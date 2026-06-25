//! System-audio (WASAPI loopback) + microphone capture into an in-memory buffer.
//!
//! Two endpoints are captured concurrently by two independent worker threads,
//! both via the `wasapi` crate (shared-mode polling at each device's own mix
//! format from GetMixFormat — no 48k/2ch assumption — then down-mixed to mono and
//! resampled to 16 kHz):
//!   * SYSTEM — a WASAPI render endpoint captured in loopback mode (the
//!     prospect's audio: Zoom/Meet/YouTube/etc.).
//!   * MIC — a WASAPI capture endpoint (the AE's voice).
//!
//! Both sides go through `wasapi` (not cpal) so input devices enumerate with the
//! same friendly names as output, and both share one capture loop (`capture_run`).
//!
//! Each source accumulates into the same in-memory pipeline: native samples are
//! resampled to 16 kHz per segment, and on stop both sources are summed into one
//! 16 kHz mono buffer — the format local Whisper wants in Slice 2.
//!
//! HARD RULE: nothing here is persisted in the shipped flow. The buffer lives in
//! memory only. The single on-disk artifact is a throwaway WAV emitted ONLY in
//! debug builds (`#[cfg(debug_assertions)]`) to prove capture during dev.
//!
//! Threading: the `wasapi` COM objects are `!Send`, so each lives entirely on its
//! own worker thread and never crosses it. The control surface (`CaptureHandle`)
//! holds only `Send` handles (Arc/AtomicBool/JoinHandle). Each worker thread (and
//! each device-enumeration thread) initialises the MTA COM apartment.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use wasapi::{
    initialize_mta, AudioCaptureClient, AudioClient, DeviceEnumerator, Direction, SampleType,
    StreamMode,
};

/// Target rate for the mixed buffer handed to transcription (Whisper wants 16k mono).
pub const TARGET_RATE: u32 = 16_000;

// ---------------------------------------------------------------------------
// Shared in-memory state
// ---------------------------------------------------------------------------

/// One captured source. Native samples accumulate per segment and are resampled
/// to 16 kHz on flush; this segmenting lets a source be rebound to a different
/// device (and thus a different native rate) mid-capture without corruption.
#[derive(Default)]
struct SourceState {
    /// Current segment of mono samples at `native_rate`.
    native: Vec<f32>,
    native_rate: u32,
    channels: u16,
    /// Resampled 16 kHz mono accumulated across all segments.
    out16k: Vec<f32>,
    active: bool,
    device_name: Option<String>,
    error: Option<String>,
    /// Peak since the last status poll — drives the live meter.
    recent_peak: f32,
    /// All-time peak — drives the post-capture summary + diagnostics.
    peak: f32,
    /// Total native mono samples ever captured (running, survives flushes).
    total_native: u64,
    /// Centiseconds from `record_started` to this source's FIRST accumulated
    /// sample. The mic and the loopback stream don't begin filling at the same
    /// instant; adding this per-source offset to each segment's timestamp anchors
    /// both timelines to one clock, so the merge orders speakers correctly
    /// instead of the loopback (later-starting) reading as if it came first.
    start_offset_cs: i64,
}

impl SourceState {
    fn begin(&mut self, name: Option<String>, rate: u32, channels: u16) {
        self.native.clear();
        self.native_rate = rate;
        self.channels = channels;
        self.active = true;
        self.error = None;
        self.device_name = name;
    }

    fn fail(&mut self, name: Option<String>, err: String) {
        self.active = false;
        self.device_name = name;
        self.error = Some(err);
    }

    fn push_mono(&mut self, mono: &[f32], accumulate: bool, start_offset_cs: i64) {
        for &s in mono {
            let a = s.abs();
            if a > self.recent_peak {
                self.recent_peak = a;
            }
            if a > self.peak {
                self.peak = a;
            }
        }
        // Peaks always update (live meter). Audio is only retained while recording.
        if accumulate {
            // First retained sample → stamp this source's offset from the shared
            // record clock (total_native is reset to 0 by begin_recording).
            if self.total_native == 0 {
                self.start_offset_cs = start_offset_cs;
            }
            self.total_native += mono.len() as u64;
            self.native.extend_from_slice(mono);
        }
    }

    /// Discard accumulated audio + reset the recording peak (used when a
    /// recording starts or ends; monitoring continues either way).
    fn reset_buffers(&mut self) {
        self.native.clear();
        self.out16k.clear();
        self.total_native = 0;
        self.start_offset_cs = 0;
        self.peak = 0.0;
    }

    /// Resample the current native segment to 16 kHz and append to `out16k`.
    fn flush_segment(&mut self) {
        if !self.native.is_empty() && self.native_rate > 0 {
            let resampled = resample_linear(&self.native, self.native_rate, TARGET_RATE);
            self.out16k.extend_from_slice(&resampled);
            self.native.clear();
        }
    }

    fn info(&self) -> SourceInfo {
        SourceInfo {
            active: self.active,
            device: self.device_name.clone(),
            sample_rate: (self.native_rate > 0).then_some(self.native_rate),
            channels: (self.channels > 0).then_some(self.channels),
            error: self.error.clone(),
        }
    }

    fn status_take(&mut self) -> SourceStatus {
        SourceStatus {
            active: self.active,
            device: self.device_name.clone(),
            level: std::mem::take(&mut self.recent_peak),
            peak: self.peak,
            samples: self.total_native,
            error: self.error.clone(),
        }
    }
}

#[derive(Default)]
struct Shared {
    mic: SourceState,
    sys: SourceState,
    /// When true, captured samples are accumulated into the buffers (recording).
    /// When false, only live peak levels update (monitoring) — so the meters
    /// react before/without recording and memory doesn't grow while idle.
    accumulate: bool,
    record_started: Option<Instant>,
}

/// Which captured source a worker feeds. Lets one capture loop serve both.
#[derive(Clone, Copy)]
enum Src {
    Mic,
    Sys,
}

impl Shared {
    fn source(&mut self, src: Src) -> &mut SourceState {
        match src {
            Src::Mic => &mut self.mic,
            Src::Sys => &mut self.sys,
        }
    }
}

// ---------------------------------------------------------------------------
// Serializable types crossing to the UI
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
pub struct SourceInfo {
    pub active: bool,
    pub device: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct CaptureInfo {
    pub mic: SourceInfo,
    pub system: SourceInfo,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct SourceStatus {
    pub active: bool,
    pub device: Option<String>,
    pub level: f32,
    pub peak: f32,
    pub samples: u64,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct CaptureStatus {
    pub recording: bool,
    pub elapsed_secs: f64,
    pub mic: SourceStatus,
    pub system: SourceStatus,
}

#[derive(Serialize, Clone, Debug)]
pub struct CaptureSummary {
    pub duration_secs: f64,
    pub mic_samples: u64,
    pub system_samples: u64,
    pub mic_peak: f32,
    pub system_peak: f32,
    pub mixed_samples: usize,
    pub mixed_rate: u32,
    pub dev_wav_path: Option<String>,
}

pub struct CaptureResult {
    pub summary: CaptureSummary,
    /// Separate 16 kHz mono buffers, retained for speaker-attributed
    /// transcription (mic = AE, system loopback = prospect). The mix is only
    /// used for the live ticker + the dev WAV.
    pub mic_16k_mono: Vec<f32>,
    pub sys_16k_mono: Vec<f32>,
    /// Per-source offsets (cs) from the shared record clock, so the clean pass
    /// aligns the two full-buffer transcriptions the same way the live merge does.
    pub mic_start_offset_cs: i64,
    pub sys_start_offset_cs: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct DeviceDesc {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct DeviceList {
    pub render: Vec<DeviceDesc>,
    pub capture: Vec<DeviceDesc>,
}

// ---------------------------------------------------------------------------
// Worker handle + capture handle
// ---------------------------------------------------------------------------

/// A single capture worker thread + its stop flag.
struct Worker {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Worker {
    fn stop_join(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Owns both worker threads + the shared buffers. `Send + Sync`.
///
/// The session is "always on" once started: workers run continuously and keep
/// the live peak meters fed (monitoring). `begin_recording` / `stop_recording`
/// toggle whether audio is actually retained, without re-opening the devices.
pub struct CaptureHandle {
    shared: Arc<Mutex<Shared>>,
    mic: Worker,
    sys: Worker,
}

impl CaptureHandle {
    /// Open the selected endpoints and begin a monitor session (live levels, no
    /// audio retained yet). `render_id` / `capture_id` select specific endpoints
    /// (by WASAPI id); `None` means the system default.
    pub fn start(
        render_id: Option<String>,
        capture_id: Option<String>,
    ) -> Result<(CaptureHandle, CaptureInfo), String> {
        let shared = Arc::new(Mutex::new(Shared::default()));

        let (sys, sys_rx) = spawn_system(&shared, render_id);
        let (mic, mic_rx) = spawn_mic(&shared, capture_id);

        let sys_res = sys_rx
            .recv()
            .unwrap_or_else(|_| Err("system audio thread exited before signalling".into()));
        let mic_res = mic_rx
            .recv()
            .unwrap_or_else(|_| Err("microphone thread exited before signalling".into()));

        let mut warnings = Vec::new();
        if let Err(e) = &sys_res {
            warnings.push(format!("system audio (loopback) unavailable: {e}"));
        }
        if let Err(e) = &mic_res {
            warnings.push(format!("microphone unavailable: {e}"));
        }

        let mut handle = CaptureHandle { shared, mic, sys };

        // Degrade gracefully: only fail if BOTH sources are dead.
        if sys_res.is_err() && mic_res.is_err() {
            handle.mic.stop_join();
            handle.sys.stop_join();
            return Err(format!(
                "no audio sources could be opened. {}",
                warnings.join("; ")
            ));
        }

        let info = {
            let s = handle.shared.lock().expect("audio state poisoned");
            CaptureInfo {
                mic: s.mic.info(),
                system: s.sys.info(),
                warnings,
            }
        };
        Ok((handle, info))
    }

    /// Current info snapshot (devices/formats/active), no warnings.
    pub fn info(&self) -> CaptureInfo {
        let s = self.shared.lock().expect("audio state poisoned");
        CaptureInfo {
            mic: s.mic.info(),
            system: s.sys.info(),
            warnings: Vec::new(),
        }
    }

    /// A cloneable read tap into the live capture buffers, for the transcription
    /// worker to consume audio incrementally during recording.
    pub fn tap(&self) -> AudioTap {
        AudioTap {
            shared: self.shared.clone(),
        }
    }

    pub fn status(&self) -> CaptureStatus {
        let mut s = self.shared.lock().expect("audio state poisoned");
        let recording = s.accumulate;
        let elapsed = s
            .record_started
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        CaptureStatus {
            recording,
            elapsed_secs: elapsed,
            mic: s.mic.status_take(),
            system: s.sys.status_take(),
        }
    }

    /// Begin retaining audio. Resets buffers and the recording clock; monitoring
    /// continues seamlessly (devices stay open).
    pub fn begin_recording(&self) {
        let mut s = self.shared.lock().expect("audio state poisoned");
        s.mic.reset_buffers();
        s.sys.reset_buffers();
        // Set the clock BEFORE opening the gate so the first accumulated sample on
        // either stream measures a valid offset against it.
        s.record_started = Some(Instant::now());
        s.accumulate = true;
    }

    /// Stop retaining audio: resample + mix what was recorded, return it, then
    /// drop back to monitoring. Infallible — it only processes in-memory buffers.
    pub fn stop_recording(&self) -> CaptureResult {
        let mut s = self.shared.lock().expect("audio state poisoned");
        let duration = s
            .record_started
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        s.mic.flush_segment();
        s.sys.flush_segment();
        let mic = s.mic.out16k.clone();
        let sys = s.sys.out16k.clone();
        let mic_start_offset_cs = s.mic.start_offset_cs;
        let sys_start_offset_cs = s.sys.start_offset_cs;
        // The mix is only for the dev-only WAV proof; the two buffers above are
        // what drive speaker-attributed transcription.
        let mixed = mix(&mic, &sys);
        let dev_wav_path = dump_dev_wav(&mixed, TARGET_RATE);
        let summary = CaptureSummary {
            duration_secs: duration,
            mic_samples: s.mic.total_native,
            system_samples: s.sys.total_native,
            mic_peak: s.mic.peak,
            system_peak: s.sys.peak,
            mixed_samples: mixed.len(),
            mixed_rate: TARGET_RATE,
            dev_wav_path,
        };
        // Back to monitoring (devices stay open).
        s.accumulate = false;
        s.record_started = None;
        s.mic.reset_buffers();
        s.sys.reset_buffers();
        CaptureResult {
            summary,
            mic_16k_mono: mic,
            sys_16k_mono: sys,
            mic_start_offset_cs,
            sys_start_offset_cs,
        }
    }

    /// Rebind the system (loopback) source to a different render endpoint while
    /// recording. The accumulated audio is preserved (segment is flushed first).
    pub fn set_render_device(&mut self, render_id: Option<String>) -> Result<(), String> {
        self.sys.stop_join();
        {
            let mut s = self.shared.lock().expect("audio state poisoned");
            s.sys.flush_segment();
        }
        let (sys, rx) = spawn_system(&self.shared, render_id);
        self.sys = sys;
        rx.recv()
            .unwrap_or_else(|_| Err("system audio thread exited before signalling".into()))
    }

    /// Rebind the mic source to a different capture endpoint while recording.
    pub fn set_capture_device(&mut self, capture_id: Option<String>) -> Result<(), String> {
        self.mic.stop_join();
        {
            let mut s = self.shared.lock().expect("audio state poisoned");
            s.mic.flush_segment();
        }
        let (mic, rx) = spawn_mic(&self.shared, capture_id);
        self.mic = mic;
        rx.recv()
            .unwrap_or_else(|_| Err("microphone thread exited before signalling".into()))
    }

}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.mic.stop_join();
        self.sys.stop_join();
    }
}

/// New native mono samples for one source since the caller's last snapshot.
pub struct SourceDelta {
    pub samples: Vec<f32>,
    pub rate: u32,
    pub recording: bool,
    /// This source's offset (cs) from the shared record clock — added to segment
    /// timestamps so the two streams merge in true chronological order.
    pub start_offset_cs: i64,
}

/// A cloneable read handle into the live capture buffers. Each per-source
/// transcription worker reads only its own source.
#[derive(Clone)]
pub struct AudioTap {
    shared: Arc<Mutex<Shared>>,
}

impl AudioTap {
    pub fn snapshot_mic_since(&self, from: usize) -> SourceDelta {
        let s = self.shared.lock().expect("audio state poisoned");
        SourceDelta {
            samples: s.mic.native.get(from..).unwrap_or(&[]).to_vec(),
            rate: s.mic.native_rate,
            recording: s.accumulate,
            start_offset_cs: s.mic.start_offset_cs,
        }
    }

    pub fn snapshot_sys_since(&self, from: usize) -> SourceDelta {
        let s = self.shared.lock().expect("audio state poisoned");
        SourceDelta {
            samples: s.sys.native.get(from..).unwrap_or(&[]).to_vec(),
            rate: s.sys.native_rate,
            recording: s.accumulate,
            start_offset_cs: s.sys.start_offset_cs,
        }
    }
}

// ---------------------------------------------------------------------------
// System (wasapi loopback) worker
// ---------------------------------------------------------------------------

fn spawn_system(
    shared: &Arc<Mutex<Shared>>,
    render_id: Option<String>,
) -> (Worker, mpsc::Receiver<Result<(), String>>) {
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel();
    let sh = shared.clone();
    let st = stop.clone();
    let thread = thread::spawn(move || {
        capture_run(sh, st, Src::Sys, move || open_system(render_id.as_deref()), tx)
    });
    (
        Worker {
            stop,
            thread: Some(thread),
        },
        rx,
    )
}

/// Holds the live wasapi objects for the duration of the poll loop. `!Send`,
/// created and used only on the worker thread.
struct SysSetup {
    audio_client: AudioClient,
    capture_client: AudioCaptureClient,
    name: Option<String>,
    rate: u32,
    channels: usize,
    bits: u16,
    sample_type: SampleType,
    block_align: usize,
    bytes_per_sample: usize,
    poll_ms: u64,
}

/// One capture worker: open the device, then poll → decode → mono → push to the
/// chosen source until stopped. Drives both the mic and the loopback side; the
/// only difference is the `open` closure (capture endpoint vs render loopback).
fn capture_run(
    shared: Arc<Mutex<Shared>>,
    stop: Arc<AtomicBool>,
    src: Src,
    open: impl FnOnce() -> Result<SysSetup, String>,
    ready: mpsc::Sender<Result<(), String>>,
) {
    // Every wasapi worker thread runs in the MTA COM apartment.
    let _ = initialize_mta();

    let setup = match open() {
        Ok(s) => s,
        Err(e) => {
            if let Ok(mut sh) = shared.lock() {
                sh.source(src).fail(None, e.clone());
            }
            let _ = ready.send(Err(e));
            return;
        }
    };

    if let Ok(mut sh) = shared.lock() {
        sh.source(src)
            .begin(setup.name.clone(), setup.rate, setup.channels as u16);
    }
    let _ = ready.send(Ok(()));

    let block_align = setup.block_align.max(1);
    let mut frame = vec![0u8; block_align];
    let mut queue: VecDeque<u8> = VecDeque::new();
    let poll = Duration::from_millis(setup.poll_ms);
    let mut run_err: Option<String> = None;
    let mut err_streak: u32 = 0;

    while !stop.load(Ordering::Acquire) {
        // Drain every packet currently available from the capture client. A
        // transient read error (a momentary buffer glitch under load) must NOT kill
        // capture for the rest of the call — skip this cycle and keep polling; only
        // give up after a sustained failure (~2 s of solid errors).
        let mut cycle_err: Option<String> = None;
        loop {
            let before = queue.len();
            match setup.capture_client.read_from_device_to_deque(&mut queue) {
                Ok(_) => {}
                Err(e) => {
                    cycle_err = Some(e.to_string());
                    break;
                }
            }
            if queue.len() == before {
                break;
            }
        }
        if let Some(e) = cycle_err {
            err_streak += 1;
            if err_streak > 400 {
                run_err = Some(e);
                break;
            }
            thread::sleep(poll);
            continue;
        }
        err_streak = 0;

        if queue.len() >= block_align {
            let mut mono = Vec::with_capacity(queue.len() / block_align + 1);
            while queue.len() >= block_align {
                for byte in frame.iter_mut() {
                    *byte = queue.pop_front().unwrap();
                }
                let mut acc = 0.0f32;
                for c in 0..setup.channels {
                    let off = c * setup.bytes_per_sample;
                    acc += decode_sample(
                        &frame[off..off + setup.bytes_per_sample],
                        setup.sample_type,
                        setup.bits,
                    );
                }
                mono.push(acc / setup.channels as f32);
            }
            if let Ok(mut sh) = shared.lock() {
                let acc = sh.accumulate;
                let off = sh
                    .record_started
                    .map(|t| (t.elapsed().as_millis() as i64) / 10)
                    .unwrap_or(0);
                sh.source(src).push_mono(&mono, acc, off);
            }
        }

        thread::sleep(poll);
    }

    let _ = setup.audio_client.stop_stream();
    if let Some(e) = run_err {
        if let Ok(mut sh) = shared.lock() {
            sh.source(src).error = Some(e);
        }
    }
}

/// Open the system (loopback) side: a render endpoint captured in the Capture
/// direction => loopback, at its native mix format.
fn open_system(render_id: Option<&str>) -> Result<SysSetup, String> {
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let device = open_render_device(&enumerator, render_id)?;
    finish_open(device, "loopback")
}

/// Open the microphone: a real capture endpoint, via the same wasapi path as the
/// system side (so input devices carry the same friendly names as output).
fn open_mic(capture_id: Option<&str>) -> Result<SysSetup, String> {
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let device = open_capture_device(&enumerator, capture_id)?;
    finish_open(device, "microphone")
}

/// Shared open path for both sides: read the device's actual mix format (no
/// 48k/2ch assumption) and start a shared-mode polling capture client. Both the
/// loopback (render device) and the mic (capture device) initialise in the
/// Capture direction — the loopback-ness comes purely from the device kind.
fn finish_open(device: wasapi::Device, label: &str) -> Result<SysSetup, String> {
    let name = device.get_friendlyname().ok();

    let mut audio_client = device.get_iaudioclient().map_err(|e| e.to_string())?;
    let format = audio_client.get_mixformat().map_err(|e| e.to_string())?;
    let channels = format.get_nchannels() as usize;
    if channels == 0 {
        return Err("device reports zero channels".into());
    }
    let rate = format.get_samplespersec();
    let bits = format.get_bitspersample();
    let sample_type = format.get_subformat().map_err(|e| e.to_string())?;
    let block_align = format.get_blockalign() as usize;
    let bytes_per_sample = block_align / channels;

    let (def_time, _min_time) = audio_client.get_device_period().map_err(|e| e.to_string())?;
    // Shared mode, Direction::Capture, polling (loopback can't use event timing;
    // we poll the mic the same way so one loop serves both).
    // Give the capture buffer real headroom (≥200 ms; def_time is only ~10 ms).
    // With two WASAPI workers polling + locking, a delayed poll on the tiny default
    // buffer would overflow and stall the stream. We still poll every few ms, so
    // the extra size is pure slack, not latency. (1 hns = 100 ns → 2_000_000 = 200 ms.)
    let buffer_hns = def_time.max(2_000_000);
    let mode = StreamMode::PollingShared {
        autoconvert: false,
        buffer_duration_hns: buffer_hns,
    };
    audio_client
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(|e| format!("initialize {label} failed: {e}"))?;
    let capture_client = audio_client.get_audiocaptureclient().map_err(|e| e.to_string())?;
    audio_client.start_stream().map_err(|e| e.to_string())?;

    let poll_ms = ((def_time / 10_000) / 2).clamp(3, 15) as u64;

    Ok(SysSetup {
        audio_client,
        capture_client,
        name,
        rate,
        channels,
        bits,
        sample_type,
        block_align,
        bytes_per_sample,
        poll_ms,
    })
}

fn open_render_device(
    enumerator: &DeviceEnumerator,
    id: Option<&str>,
) -> Result<wasapi::Device, String> {
    match id {
        Some(want) => {
            let coll = enumerator
                .get_device_collection(&Direction::Render)
                .map_err(|e| e.to_string())?;
            for dev in &coll {
                let dev = dev.map_err(|e| e.to_string())?;
                if dev.get_id().map_err(|e| e.to_string())? == want {
                    return Ok(dev);
                }
            }
            Err(format!("render device '{want}' not found (unplugged?)"))
        }
        None => enumerator
            .get_default_device(&Direction::Render)
            .map_err(|e| e.to_string()),
    }
}

fn open_capture_device(
    enumerator: &DeviceEnumerator,
    id: Option<&str>,
) -> Result<wasapi::Device, String> {
    match id {
        Some(want) => {
            let coll = enumerator
                .get_device_collection(&Direction::Capture)
                .map_err(|e| e.to_string())?;
            for dev in &coll {
                let dev = dev.map_err(|e| e.to_string())?;
                if dev.get_id().map_err(|e| e.to_string())? == want {
                    return Ok(dev);
                }
            }
            Err(format!("capture device '{want}' not found (unplugged?)"))
        }
        None => enumerator
            .get_default_device(&Direction::Capture)
            .map_err(|e| e.to_string()),
    }
}

/// Decode one little-endian sample of the given format to normalised f32.
fn decode_sample(bytes: &[u8], sample_type: SampleType, bits: u16) -> f32 {
    match sample_type {
        SampleType::Float => match bits {
            32 if bytes.len() >= 4 => f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            64 if bytes.len() >= 8 => f64::from_le_bytes([
                bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            ]) as f32,
            _ => 0.0,
        },
        SampleType::Int => match bits {
            16 if bytes.len() >= 2 => i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32_768.0,
            24 if bytes.len() >= 3 => {
                // Sign-extend a packed 24-bit little-endian value.
                let v = ((bytes[0] as i32) | ((bytes[1] as i32) << 8) | ((bytes[2] as i32) << 16))
                    << 8
                    >> 8;
                v as f32 / 8_388_608.0
            }
            32 if bytes.len() >= 4 => {
                i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32
                    / 2_147_483_648.0
            }
            _ => 0.0,
        },
    }
}

// ---------------------------------------------------------------------------
// Microphone (wasapi) worker
// ---------------------------------------------------------------------------

fn spawn_mic(
    shared: &Arc<Mutex<Shared>>,
    capture_id: Option<String>,
) -> (Worker, mpsc::Receiver<Result<(), String>>) {
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel();
    let sh = shared.clone();
    let st = stop.clone();
    let thread = thread::spawn(move || {
        capture_run(sh, st, Src::Mic, move || open_mic(capture_id.as_deref()), tx)
    });
    (
        Worker {
            stop,
            thread: Some(thread),
        },
        rx,
    )
}

// ---------------------------------------------------------------------------
// Resample + mix + dev WAV
// ---------------------------------------------------------------------------

/// Linear-interpolation resampler (Slice-1 placeholder; Slice 2 swaps in a
/// properly filtered resampler — rubato).
pub(crate) fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if input.is_empty() || from == 0 {
        return Vec::new();
    }
    if from == to {
        return input.to_vec();
    }
    let ratio = to as f64 / from as f64;
    let out_len = ((input.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    let last = input.len() - 1;
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let idx = src.floor() as usize;
        let frac = (src - idx as f64) as f32;
        let a = input[idx.min(last)];
        let b = input[(idx + 1).min(last)];
        out.push(a + (b - a) * frac);
    }
    out
}

/// Sum two mono buffers sample-for-sample, clamping to [-1, 1].
fn mix(a: &[f32], b: &[f32]) -> Vec<f32> {
    let n = a.len().max(b.len());
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0.0) + b.get(i).copied().unwrap_or(0.0);
        out.push(x.clamp(-1.0, 1.0));
    }
    out
}

#[cfg(debug_assertions)]
fn dump_dev_wav(samples: &[f32], rate: u32) -> Option<String> {
    if samples.is_empty() {
        return None;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("tell_dev_capture_{ts}.wav"));
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = match hound::WavWriter::create(&path, spec) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[audio] dev wav create failed: {e}");
            return None;
        }
    };
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        if writer.write_sample(v).is_err() {
            return None;
        }
    }
    writer.finalize().ok()?;
    Some(path.to_string_lossy().into_owned())
}

#[cfg(not(debug_assertions))]
fn dump_dev_wav(_samples: &[f32], _rate: u32) -> Option<String> {
    None
}

// ---------------------------------------------------------------------------
// Device enumeration
// ---------------------------------------------------------------------------

/// Enumerate all active render (output) and capture (mic) endpoints. Both are
/// enumerated via wasapi on their own MTA threads, so they share the friendly
/// naming and run without clashing.
pub fn list_devices() -> Result<DeviceList, String> {
    let render_h = thread::spawn(|| {
        let _ = initialize_mta();
        enum_render()
    });
    let capture_h = thread::spawn(enum_capture);

    let render = render_h
        .join()
        .map_err(|_| "render enumeration thread panicked".to_string())??;
    let capture = capture_h
        .join()
        .map_err(|_| "capture enumeration thread panicked".to_string())??;
    Ok(DeviceList { render, capture })
}

fn enum_render() -> Result<Vec<DeviceDesc>, String> {
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let default_id = enumerator
        .get_default_device(&Direction::Render)
        .ok()
        .and_then(|d| d.get_id().ok());
    let coll = enumerator
        .get_device_collection(&Direction::Render)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for dev in &coll {
        let dev = match dev {
            Ok(d) => d,
            Err(_) => continue,
        };
        let id = match dev.get_id() {
            Ok(i) => i,
            Err(_) => continue,
        };
        let name = dev
            .get_friendlyname()
            .unwrap_or_else(|_| "Unknown output".into());
        let is_default = Some(&id) == default_id.as_ref();
        out.push(DeviceDesc {
            id,
            name,
            is_default,
        });
    }
    Ok(out)
}

#[allow(deprecated)]
fn enum_capture() -> Result<Vec<DeviceDesc>, String> {
    // Enumerate via wasapi (same path as render), so input devices get the same
    // friendly names as output instead of cpal's generic "Microphone" labels.
    // This thread therefore needs the MTA COM apartment.
    let _ = initialize_mta();
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let default_id = enumerator
        .get_default_device(&Direction::Capture)
        .ok()
        .and_then(|d| d.get_id().ok());
    let coll = enumerator
        .get_device_collection(&Direction::Capture)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for dev in &coll {
        let dev = match dev {
            Ok(d) => d,
            Err(_) => continue,
        };
        let id = match dev.get_id() {
            Ok(i) => i,
            Err(_) => continue,
        };
        let name = dev
            .get_friendlyname()
            .unwrap_or_else(|_| "Unknown microphone".into());
        let is_default = Some(&id) == default_id.as_ref();
        out.push(DeviceDesc {
            id,
            name,
            is_default,
        });
    }
    Ok(out)
}
