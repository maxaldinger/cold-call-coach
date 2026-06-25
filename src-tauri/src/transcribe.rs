//! Local speech-to-text via whisper.cpp (the `whisper-rs` bindings, CUDA feature).
//!
//! whisper.cpp is statically linked into the .exe — there is no sidecar process
//! and no network. Audio is handed in as a 16 kHz mono f32 slice straight from
//! memory; nothing is ever written to disk here. The GGML model is loaded once
//! (it's the expensive step) and reused for every transcription.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::audio::{resample_linear, AudioTap, TARGET_RATE};

/// One transcript segment with whisper's start/end timestamps (centiseconds,
/// relative to the start of the buffer that was transcribed).
#[derive(Clone, Debug)]
pub struct Segment {
    pub t0_cs: i64,
    pub t1_cs: i64,
    pub text: String,
}

/// A diarized span: [start_cs, end_cs) attributed to a speaker cluster index.
/// Produced by `crate::diarize` and consumed by `clean_retranscribe` to label
/// the prospect side. Defined here so transcribe.rs stays agnostic of the
/// diarization backend (no sherpa dependency leaks in).
#[derive(Clone, Copy, Debug)]
pub struct SpeakerSpan {
    pub start_cs: i64,
    pub end_cs: i64,
    pub speaker: i32,
}

/// A loaded whisper model. Loading is expensive (esp. medium.en on the GPU), so
/// build one and keep it for the app's lifetime. Transcription spins up a fresh
/// decode state per call, which is cheap relative to the model load.
pub struct Transcriber {
    ctx: WhisperContext,
    gpu: bool,
}

impl Transcriber {
    /// Load a GGML model. `use_gpu` selects the CUDA backend (the whole point on
    /// the RTX 4090); pass false only as a diagnostic CPU fallback.
    pub fn load(model_path: &str, use_gpu: bool) -> Result<Self, String> {
        let mut params = WhisperContextParameters::default();
        params.use_gpu = use_gpu;
        let ctx = WhisperContext::new_with_params(model_path, params)
            .map_err(|e| format!("failed to load whisper model '{model_path}': {e}"))?;
        Ok(Self { ctx, gpu: use_gpu })
    }

    pub fn is_gpu(&self) -> bool {
        self.gpu
    }

    /// Transcribe a 16 kHz mono buffer into segments with timestamps. English,
    /// no translation. Non-speech annotation segments are dropped.
    pub fn transcribe_segments(
        &self,
        samples_16k_mono: &[f32],
        initial_prompt: Option<&str>,
    ) -> Result<Vec<Segment>, String> {
        if samples_16k_mono.is_empty() {
            return Ok(Vec::new());
        }
        let mut state = self
            .ctx
            .create_state()
            .map_err(|e| format!("whisper state init failed: {e}"))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 0 });
        params.set_n_threads(suggested_threads());
        params.set_translate(false);
        params.set_language(Some("en"));
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        // Anti-hallucination for dead air / ring tones / hold music: stay greedy at
        // temperature 0 and apply whisper's quality gates so empty windows fail
        // quietly instead of inventing URLs and "thank you for watching". The
        // per-segment no-speech check below drops whatever still slips through.
        params.set_temperature(0.0);
        params.set_no_speech_thold(0.6);
        params.set_entropy_thold(2.4);
        params.set_logprob_thold(-1.0);
        // Keep whisper.cpp from printing to our stdout.
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        // Bias the decoder toward the rep's company + product vocabulary so brand
        // terms and jargon transcribe correctly (e.g. "Bito", "AI Architect",
        // "pull request") instead of being guessed phonetically.
        if let Some(p) = initial_prompt {
            let p = p.trim();
            if !p.is_empty() {
                params.set_initial_prompt(p);
            }
        }

        state
            .full(params, samples_16k_mono)
            .map_err(|e| format!("whisper inference failed: {e}"))?;

        let mut out = Vec::new();
        for segment in state.as_iter() {
            let seg = segment.to_string();
            let t = seg.trim();
            if t.is_empty() || is_nonspeech(t) {
                continue;
            }
            // Whisper invents text on silence / ring tones / hold music. Two guards:
            // (1) when the model itself is confident the window had no speech, and
            // (2) a blocklist of its classic dead-air artifacts (URLs, "thanks for
            // watching", repetition loops, keypad-tone digit runs).
            if segment.no_speech_probability() > 0.6 || is_hallucination(t) {
                continue;
            }
            out.push(Segment {
                t0_cs: segment.start_timestamp(),
                t1_cs: segment.end_timestamp(),
                text: t.split_whitespace().collect::<Vec<_>>().join(" "),
            });
        }
        Ok(out)
    }

    /// Transcribe a 16 kHz mono buffer to a single concatenated string. Used by
    /// the live ticker (no speaker labels there).
    pub fn transcribe(&self, samples_16k_mono: &[f32]) -> Result<String, String> {
        let segments = self.transcribe_segments(samples_16k_mono, None)?;
        Ok(segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" "))
    }
}

/// Merge labeled segment lists into one transcript ordered by segment start
/// time, coalescing consecutive segments from the same speaker into one line.
/// Each line is prefixed with its speaker label, e.g. "[Prospect] …".
pub fn merge_transcript(sources: &[(&str, &[Segment])]) -> String {
    let mut all: Vec<(i64, &str, &str)> = Vec::new();
    for (label, segs) in sources {
        for s in *segs {
            all.push((s.t0_cs, label, s.text.as_str()));
        }
    }
    // Stable sort by start time keeps each source's internal order on ties.
    all.sort_by_key(|(t0, _, _)| *t0);

    let mut lines: Vec<(String, String)> = Vec::new();
    for (_, label, text) in all {
        match lines.last_mut() {
            Some(last) if last.0 == label => {
                last.1.push(' ');
                last.1.push_str(text);
            }
            _ => lines.push((label.to_string(), text.to_string())),
        }
    }
    lines
        .into_iter()
        .map(|(label, text)| format!("[{label}] {text}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// whisper.cpp emits non-speech annotations as whole segments wrapped in
/// brackets/parens, e.g. "[BLANK_AUDIO]", "(music)", "[ Silence ]". Drop them.
fn is_nonspeech(seg: &str) -> bool {
    (seg.starts_with('[') && seg.ends_with(']')) || (seg.starts_with('(') && seg.ends_with(')'))
}

/// Whisper's well-known dead-air hallucinations. It was trained on a lot of
/// YouTube, so silence / ring tones / hold music decode into URLs, "thanks for
/// watching" sign-offs, repeated filler, or keypad-tone digit runs. These never
/// occur in a real cold call, so dropping them is safe.
fn is_hallucination(seg: &str) -> bool {
    let s = seg.trim();
    let lower = s.to_lowercase();
    // Spoken web addresses don't happen on a dial; these are pure artifacts.
    if lower.contains("www.")
        || lower.contains("http://")
        || lower.contains("https://")
        || lower.contains(".com/")
        || lower.contains(".org")
    {
        return true;
    }
    const FILLERS: [&str; 6] = [
        "thank you for watching",
        "thanks for watching",
        "thank you for listening",
        "please subscribe",
        "subtitles by",
        "amara.org",
    ];
    if FILLERS.iter().any(|f| lower.contains(f)) {
        return true;
    }
    // A run of digits/punctuation with no letters is a keypad / DTMF tone artifact
    // (e.g. "5, 7, 1, 4, 4, 2"), not speech.
    let has_alpha = s.chars().any(|c| c.is_alphabetic());
    let digits = s.chars().filter(|c| c.is_ascii_digit()).count();
    if !has_alpha && digits >= 4 {
        return true;
    }
    // Degenerate repetition loop, e.g. "Thank you. Thank you. Thank you."
    let parts: Vec<&str> = lower
        .split(['.', '!', '?'])
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() >= 3 && parts.iter().all(|p| *p == parts[0]) {
        return true;
    }
    false
}

fn suggested_threads() -> std::os::raw::c_int {
    let n = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    n.clamp(1, 8) as std::os::raw::c_int
}

// ---------------------------------------------------------------------------
// Live (streaming) transcription — per source, speaker-attributed
// ---------------------------------------------------------------------------
//
// TWO workers run concurrently, one per source (mic = AE, system loopback =
// Prospect). Each does the same windowed re-transcribe + commit on its OWN
// 16 kHz buffer, producing absolute-timestamped segments. After every update
// the two speakers' segments are merged by start time + labeled into one
// stream — that merged stream IS the live display (there is no separate mix).
//
// Because the work amortizes across the call, Stop only needs to flush each
// source's last uncommitted window (~instant). A full per-source re-pass is
// available on demand via `clean_retranscribe` for the rare rough call.
//
// Everything is in memory; the transcript is never written to disk.

const TICK: Duration = Duration::from_millis(1500);
const COMMIT_SAMPLES: usize = TARGET_RATE as usize * 12; // ~12 s commit window
const MIN_PARTIAL_SAMPLES: usize = TARGET_RATE as usize / 2; // don't transcribe < 0.5 s

#[derive(Clone, Copy)]
enum Label {
    Ae,
    Prospect,
}

#[derive(Default)]
struct SpeakerState {
    committed: Vec<Segment>, // absolute t0 (cs)
    partial: Vec<Segment>,   // current window, absolute t0
}

#[derive(Default)]
struct Merged {
    ae: SpeakerState,
    prospect: SpeakerState,
}

impl Merged {
    fn speaker(&mut self, label: Label) -> &mut SpeakerState {
        match label {
            Label::Ae => &mut self.ae,
            Label::Prospect => &mut self.prospect,
        }
    }
}

fn merge_live(m: &Merged) -> String {
    let mut ae = m.ae.committed.clone();
    ae.extend(m.ae.partial.iter().cloned());
    let mut prospect = m.prospect.committed.clone();
    prospect.extend(m.prospect.partial.iter().cloned());
    merge_transcript(&[("You", &ae), ("Prospect", &prospect)])
}

/// Handle to the two running live workers.
pub struct LiveSession {
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
    shared: Arc<Mutex<Merged>>,
}

impl LiveSession {
    /// Stop both workers (each flushes its last uncommitted window) and return
    /// the final merged, speaker-labeled transcript. ~Instant — only the tail of
    /// each source is transcribed, regardless of call length.
    pub fn stop_and_final(mut self) -> String {
        self.stop.store(true, Ordering::Release);
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
        let m = self.shared.lock().expect("transcript poisoned");
        merge_live(&m)
    }
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

/// Start the two per-source live workers. `on_update(merged_labeled_text,
/// recording)` fires whenever either worker advances (decoupled from Tauri so
/// this is testable headlessly).
pub fn start_live<F>(
    tap: AudioTap,
    transcriber: Arc<Transcriber>,
    initial_prompt: Option<String>,
    on_update: F,
) -> LiveSession
where
    F: Fn(&str, bool) + Send + Sync + 'static,
{
    let stop = Arc::new(AtomicBool::new(false));
    let shared = Arc::new(Mutex::new(Merged::default()));
    let on_update: Arc<dyn Fn(&str, bool) + Send + Sync> = Arc::new(on_update);

    let emit: Arc<dyn Fn() + Send + Sync> = {
        let shared = shared.clone();
        let on_update = on_update.clone();
        let stop = stop.clone();
        Arc::new(move || {
            let text = {
                let m = shared.lock().expect("transcript poisoned");
                merge_live(&m)
            };
            on_update(&text, !stop.load(Ordering::Acquire));
        })
    };

    let mut threads = Vec::new();
    {
        let tap = tap.clone();
        let (tr, sh, st, em) = (transcriber.clone(), shared.clone(), stop.clone(), emit.clone());
        let ip = initial_prompt.clone();
        threads.push(thread::spawn(move || {
            source_loop(Label::Ae, tr, ip, st, sh, em, move |from| {
                let d = tap.snapshot_mic_since(from);
                (d.samples, d.rate, d.start_offset_cs)
            });
        }));
    }
    {
        let tap = tap.clone();
        let (tr, sh, st, em) = (transcriber.clone(), shared.clone(), stop.clone(), emit.clone());
        let ip = initial_prompt.clone();
        threads.push(thread::spawn(move || {
            source_loop(Label::Prospect, tr, ip, st, sh, em, move |from| {
                let d = tap.snapshot_sys_since(from);
                (d.samples, d.rate, d.start_offset_cs)
            });
        }));
    }

    LiveSession {
        stop,
        threads,
        shared,
    }
}

/// One source's windowed re-transcribe + commit loop. `pull(from)` returns the
/// new native samples since `from` for this source, plus its native rate.
fn source_loop<P>(
    label: Label,
    transcriber: Arc<Transcriber>,
    initial_prompt: Option<String>,
    stop: Arc<AtomicBool>,
    shared: Arc<Mutex<Merged>>,
    emit: Arc<dyn Fn() + Send + Sync>,
    pull: P,
) where
    P: Fn(usize) -> (Vec<f32>, u32, i64),
{
    let mut from = 0usize;
    let mut buf: Vec<f32> = Vec::new();
    let mut commit_idx = 0usize;
    let mut last_len = 0usize;

    loop {
        let stopping = stop.load(Ordering::Acquire);

        let (samples, rate, start_offset_cs) = pull(from);
        from += samples.len();
        if !samples.is_empty() && rate > 0 {
            buf.extend(resample_linear(&samples, rate, TARGET_RATE));
        }

        let uncommitted = buf.len().saturating_sub(commit_idx);
        if uncommitted >= MIN_PARTIAL_SAMPLES && buf.len() > last_len {
            let segs = transcriber
                .transcribe_segments(&buf[commit_idx..], initial_prompt.as_deref())
                .unwrap_or_default();
            // Window-relative timestamps -> absolute: shared-clock start offset for
            // this source + its commit point. The start offset aligns the two
            // streams so the merge orders You vs Prospect chronologically.
            let offset_cs = start_offset_cs + (commit_idx as i64) * 100 / (TARGET_RATE as i64);
            let abs: Vec<Segment> = segs
                .into_iter()
                .map(|s| Segment {
                    t0_cs: s.t0_cs + offset_cs,
                    t1_cs: s.t1_cs + offset_cs,
                    text: s.text,
                })
                .collect();
            last_len = buf.len();

            {
                let mut m = shared.lock().expect("transcript poisoned");
                let sp = m.speaker(label);
                if uncommitted >= COMMIT_SAMPLES && !abs.is_empty() {
                    sp.committed.extend(abs);
                    sp.partial.clear();
                    commit_idx = buf.len();
                } else {
                    sp.partial = abs;
                }
            }
            emit();
        }

        if stopping {
            // Flush: commit whatever's in the partial window, then we're done.
            {
                let mut m = shared.lock().expect("transcript poisoned");
                let sp = m.speaker(label);
                let tail = std::mem::take(&mut sp.partial);
                sp.committed.extend(tail);
            }
            emit();
            break;
        }

        let mut waited = Duration::ZERO;
        while waited < TICK && !stop.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(100));
            waited += Duration::from_millis(100);
        }
    }
}

/// Merge owned (label, segment) pairs into one transcript ordered by start time,
/// coalescing consecutive same-label segments. Like `merge_transcript` but with
/// PER-SEGMENT labels — used when prospect segments carry per-speaker labels.
pub fn merge_labeled(mut items: Vec<(String, Segment)>) -> String {
    items.sort_by_key(|(_, s)| s.t0_cs);
    let mut lines: Vec<(String, String)> = Vec::new();
    for (label, seg) in items {
        match lines.last_mut() {
            Some(last) if last.0 == label => {
                last.1.push(' ');
                last.1.push_str(&seg.text);
            }
            _ => lines.push((label, seg.text)),
        }
    }
    lines
        .into_iter()
        .map(|(label, text)| format!("[{label}] {text}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The diarization cluster covering `mid_cs` (a segment's midpoint); falls back
/// to the nearest span by time gap when no span strictly contains it.
fn speaker_at(mid_cs: i64, spans: &[SpeakerSpan]) -> i32 {
    let mut best: Option<(i64, i32)> = None;
    for sp in spans {
        if mid_cs >= sp.start_cs && mid_cs < sp.end_cs {
            return sp.speaker;
        }
        let gap = if mid_cs < sp.start_cs {
            sp.start_cs - mid_cs
        } else {
            mid_cs - sp.end_cs
        };
        if best.map_or(true, |(g, _)| gap < g) {
            best = Some((gap, sp.speaker));
        }
    }
    best.map(|(_, s)| s).unwrap_or(0)
}

/// On-demand max-quality pass: transcribe each retained buffer in full (no
/// windowing), then label. The mic is always "You"; the prospect side is split
/// into "Prospect 1/2/3" using the diarization `prospect_spans` (by voiceprint).
/// If diarization found 0 or 1 speakers (empty/short audio, or a 1:1 call), the
/// prospect stays a single "Prospect".
pub fn clean_retranscribe(
    transcriber: &Transcriber,
    mic_16k: &[f32],
    sys_16k: &[f32],
    mic_offset_cs: i64,
    sys_offset_cs: i64,
    prospect_spans: &[SpeakerSpan],
    initial_prompt: Option<&str>,
) -> Result<String, String> {
    let you = transcriber
        .transcribe_segments(mic_16k, initial_prompt)
        .map_err(|e| format!("you (mic) clean pass failed: {e}"))?;
    let prospect = transcriber
        .transcribe_segments(sys_16k, initial_prompt)
        .map_err(|e| format!("prospect (system) clean pass failed: {e}"))?;

    let n_speakers = prospect_spans
        .iter()
        .map(|s| s.speaker)
        .max()
        .map(|m| m + 1)
        .unwrap_or(0);
    let multi = n_speakers >= 2;

    let mut items: Vec<(String, Segment)> = Vec::with_capacity(you.len() + prospect.len());
    for s in you {
        items.push((
            "You".to_string(),
            Segment {
                t0_cs: s.t0_cs + mic_offset_cs,
                t1_cs: s.t1_cs + mic_offset_cs,
                text: s.text,
            },
        ));
    }
    for s in prospect {
        // Pick the speaker from the diarization spans (which are in sys-stream time,
        // pre-offset), THEN shift the segment onto the shared clock for the merge.
        let label = if multi {
            let spk = speaker_at((s.t0_cs + s.t1_cs) / 2, prospect_spans);
            format!("Prospect {}", spk + 1)
        } else {
            "Prospect".to_string()
        };
        items.push((
            label,
            Segment {
                t0_cs: s.t0_cs + sys_offset_cs,
                t1_cs: s.t1_cs + sys_offset_cs,
                text: s.text,
            },
        ));
    }
    Ok(merge_labeled(items))
}
