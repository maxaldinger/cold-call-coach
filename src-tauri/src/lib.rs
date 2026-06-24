pub mod audio;
pub mod coaching;
pub mod transcribe;

use std::sync::{Arc, Mutex};

use audio::{CaptureHandle, CaptureInfo, CaptureStatus, CaptureSummary, DeviceList};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_sql::{Migration, MigrationKind};
use transcribe::Transcriber;

/// In-memory audio state. The capture session lives here while recording; the
/// last captured 16 kHz mono mix is retained after stop so Slice 2 can transcribe
/// it (and so a failed transcription can be retried without re-recording). Per
/// the hard rule, this buffer is never persisted to disk.
#[derive(Default)]
struct AudioState {
    session: Mutex<Option<CaptureHandle>>,
    /// Last recording's two 16 kHz mono buffers (mic, system) — retained in
    /// memory for a transcription retry; never written to disk.
    last_capture: Mutex<Option<(Vec<f32>, Vec<f32>)>>,
}

/// Transcription state: the model is loaded once and reused; the live worker
/// runs during recording; the last completed transcript is retained in memory
/// (for Slice 4) and, per the hard rule, never written to disk.
#[derive(Default)]
struct TranscriptionState {
    transcriber: Mutex<Option<Arc<Transcriber>>>,
    live: Mutex<Option<transcribe::LiveSession>>,
    last_transcript: Mutex<Option<String>>,
}

#[derive(Serialize, Clone)]
struct TranscriptUpdate {
    /// The merged, speaker-labeled transcript so far (live).
    transcript: String,
    recording: bool,
}

/// Returned by stop_recording: the capture summary + the authoritative,
/// speaker-attributed transcript (built from two final whisper passes).
#[derive(Serialize, Clone)]
struct StopResult {
    summary: CaptureSummary,
    transcript: String,
}

/// Resolve the GGML model path: the bundled resource in production, or the dev
/// `resources/models` folder when running via `tauri dev`.
fn resolve_model_path(app: &AppHandle) -> Result<String, String> {
    const NAME: &str = "ggml-medium.en.bin";
    if let Ok(p) = app
        .path()
        .resolve(format!("models/{NAME}"), tauri::path::BaseDirectory::Resource)
    {
        if p.exists() {
            return Ok(p.to_string_lossy().into_owned());
        }
    }
    for cand in [
        format!("resources/models/{NAME}"),
        format!("src-tauri/resources/models/{NAME}"),
    ] {
        let pb = std::path::PathBuf::from(&cand);
        if pb.exists() {
            return Ok(pb.to_string_lossy().into_owned());
        }
    }
    Err(format!(
        "whisper model '{NAME}' not found (looked in app resources and ./resources/models)"
    ))
}

#[tauri::command]
fn list_audio_devices() -> Result<DeviceList, String> {
    audio::list_devices()
}

/// Ensure the always-on monitor session is running (opens the selected devices
/// and starts live level monitoring). Idempotent — returns current info if a
/// session already exists. Device changes go through set_render/capture_device.
#[tauri::command]
fn start_session(
    state: tauri::State<'_, AudioState>,
    render_id: Option<String>,
    capture_id: Option<String>,
) -> Result<CaptureInfo, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| "audio state poisoned".to_string())?;
    if let Some(handle) = session.as_ref() {
        return Ok(handle.info());
    }
    let (handle, info) = CaptureHandle::start(render_id, capture_id)?;
    *session = Some(handle);
    Ok(info)
}

/// Begin retaining audio (the Record button) and start live transcription.
/// Requires an active session. The model loads once on first use and is reused.
#[tauri::command]
fn begin_recording(
    audio: tauri::State<'_, AudioState>,
    tx: tauri::State<'_, TranscriptionState>,
    app: AppHandle,
) -> Result<(), String> {
    // Start capture immediately (record from t=0) and grab a read tap.
    let tap = {
        let session = audio
            .session
            .lock()
            .map_err(|_| "audio state poisoned".to_string())?;
        let handle = session
            .as_ref()
            .ok_or_else(|| "no audio session — call start_session first".to_string())?;
        handle.begin_recording();
        handle.tap()
    };

    // Load the model once (medium.en on the GPU); reuse across recordings.
    let transcriber = {
        let mut slot = tx
            .transcriber
            .lock()
            .map_err(|_| "transcription state poisoned".to_string())?;
        if slot.is_none() {
            let path = resolve_model_path(&app)?;
            *slot = Some(Arc::new(Transcriber::load(&path, true)?));
        }
        slot.as_ref().unwrap().clone()
    };

    // Spin up the two per-source live workers; forward the merged labeled stream
    // to the UI as `transcript` events.
    let app_emit = app.clone();
    let live = transcribe::start_live(tap, transcriber, move |text, recording| {
        let _ = app_emit.emit(
            "transcript",
            TranscriptUpdate {
                transcript: text.to_string(),
                recording,
            },
        );
    });
    *tx.live
        .lock()
        .map_err(|_| "transcription state poisoned".to_string())? = Some(live);
    Ok(())
}

/// Rebind the system-audio (loopback) source to a different render endpoint.
/// No-op if not currently recording (the selection is applied at next start).
#[tauri::command]
fn set_render_device(
    state: tauri::State<'_, AudioState>,
    render_id: Option<String>,
) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| "audio state poisoned".to_string())?;
    match session.as_mut() {
        Some(handle) => handle.set_render_device(render_id),
        None => Ok(()),
    }
}

/// Rebind the microphone source to a different capture endpoint.
#[tauri::command]
fn set_capture_device(
    state: tauri::State<'_, AudioState>,
    capture_id: Option<String>,
) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| "audio state poisoned".to_string())?;
    match session.as_mut() {
        Some(handle) => handle.set_capture_device(capture_id),
        None => Ok(()),
    }
}

#[tauri::command]
fn capture_status(state: tauri::State<'_, AudioState>) -> Result<CaptureStatus, String> {
    let session = state
        .session
        .lock()
        .map_err(|_| "audio state poisoned".to_string())?;
    Ok(match session.as_ref() {
        Some(h) => h.status(),
        None => CaptureStatus::default(),
    })
}

/// Stop retaining audio (the Stop button); returns the recording summary and
/// keeps the session monitoring (devices stay open for an immediate re-record).
/// The completed transcript arrives via a final `transcript` event and is also
/// retained in memory for the generation step (Slice 4).
#[tauri::command]
fn stop_recording(
    audio: tauri::State<'_, AudioState>,
    tx: tauri::State<'_, TranscriptionState>,
) -> Result<StopResult, String> {
    // Stop the live workers FIRST — each flushes its last uncommitted window and
    // the merged, speaker-labeled transcript comes back ~instantly (the per-source
    // transcription already happened live; no full re-pass here).
    let transcript = {
        let mut live = tx
            .live
            .lock()
            .map_err(|_| "transcription state poisoned".to_string())?;
        match live.take() {
            Some(session) => session.stop_and_final(),
            None => String::new(),
        }
    };

    // Then stop capture and retain the two buffers (for an on-demand clean pass).
    let result = {
        let session = audio
            .session
            .lock()
            .map_err(|_| "audio state poisoned".to_string())?;
        let handle = session
            .as_ref()
            .ok_or_else(|| "no audio session".to_string())?;
        handle.stop_recording()
    };
    *audio
        .last_capture
        .lock()
        .map_err(|_| "audio state poisoned".to_string())? =
        Some((result.mic_16k_mono, result.sys_16k_mono));
    *tx.last_transcript
        .lock()
        .map_err(|_| "transcription state poisoned".to_string())? = Some(transcript.clone());

    Ok(StopResult {
        summary: result.summary,
        transcript,
    })
}

/// On-demand max-quality re-transcription of the last recording's two retained
/// buffers (full per-source passes, no window boundaries). Slower; the UI fires
/// a completion notification when it returns.
#[tauri::command]
fn clean_retranscribe(
    audio: tauri::State<'_, AudioState>,
    tx: tauri::State<'_, TranscriptionState>,
) -> Result<String, String> {
    let (mic, sys) = {
        let cap = audio
            .last_capture
            .lock()
            .map_err(|_| "audio state poisoned".to_string())?;
        cap.clone()
            .ok_or_else(|| "no recording to re-transcribe".to_string())?
    };
    let transcriber = {
        let slot = tx
            .transcriber
            .lock()
            .map_err(|_| "transcription state poisoned".to_string())?;
        slot.as_ref()
            .cloned()
            .ok_or_else(|| "model not loaded".to_string())?
    };
    let transcript = transcribe::clean_retranscribe(&transcriber, &mic, &sys)?;
    *tx.last_transcript
        .lock()
        .map_err(|_| "transcription state poisoned".to_string())? = Some(transcript.clone());
    Ok(transcript)
}

/// Save the Anthropic API key to the OS keychain (never SQLite, never source).
#[tauri::command]
fn set_api_key(key: String) -> Result<(), String> {
    coaching::save_api_key(&key)
}

/// Whether an API key is present (never returns the key itself).
#[tauri::command]
fn has_api_key() -> bool {
    coaching::has_api_key()
}

/// The one structured Claude call: labeled cold-call transcript (Rust memory) +
/// key (keychain) + Bito context (passed in) → a structured coaching report. On
/// any failure the transcript is retained so the user can retry without
/// re-recording.
#[tauri::command]
async fn analyze_call(
    tx: tauri::State<'_, TranscriptionState>,
    context: coaching::ContextInput,
    prospect: String,
    date: String,
    model: String,
) -> Result<coaching::CoachingReport, String> {
    let prospect = prospect.trim().to_string();
    if prospect.is_empty() {
        return Err("enter who you called (prospect / account name) first".into());
    }
    let transcript = {
        let slot = tx
            .last_transcript
            .lock()
            .map_err(|_| "transcription state poisoned".to_string())?;
        slot.clone()
            .ok_or_else(|| "no transcript yet — record and stop a call first".to_string())?
    };
    if transcript.trim().is_empty() {
        return Err("the transcript is empty — nothing to coach from".into());
    }
    let key = coaching::read_api_key()?;
    let model = if model.trim().is_empty() {
        "claude-sonnet-4-6".to_string()
    } else {
        model
    };
    coaching::run_coaching(&key, &model, &context, &prospect, &date, &transcript).await
}

/// Database migrations. Versioned and append-only — never edit a shipped
/// migration, add a new one. The schema deliberately has NO transcript or
/// raw-audio column anywhere: transcripts are ephemeral and live in memory
/// only (hard requirement).
fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create_initial_schema",
        sql: include_str!("../migrations/0001_init.sql"),
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Route whisper.cpp / ggml logs through the `log` crate; with no logger
    // installed they are dropped, silencing their verbose stderr output.
    whisper_rs::install_logging_hooks();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                // The connection string maps to a file in the app data dir.
                // Loading "sqlite:coldcallcoach.db" from the frontend runs these
                // migrations on first connect.
                .add_migrations("sqlite:coldcallcoach.db", migrations())
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AudioState::default())
        .manage(TranscriptionState::default())
        .invoke_handler(tauri::generate_handler![
            list_audio_devices,
            start_session,
            begin_recording,
            stop_recording,
            clean_retranscribe,
            set_api_key,
            has_api_key,
            analyze_call,
            set_render_device,
            set_capture_device,
            capture_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cold Call Coach");
}
