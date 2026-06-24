//! End-to-end live-transcription proof (headless).
//!
//!   cargo run --example live_probe -- [model.bin] [seconds]
//!
//! Starts a real capture session, begins recording, and runs the live worker —
//! the same `start_live` the app uses, with a printing callback instead of Tauri
//! events. Play speech through your default output while it runs; you should see
//! the transcript build up live, then a final transcript on stop.

use std::sync::Arc;
use std::time::Duration;

use coldcallcoach_lib::audio::CaptureHandle;
use coldcallcoach_lib::transcribe::{start_live, Transcriber};

fn main() {
    let model = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "src-tauri/resources/models/ggml-tiny.en.bin".to_string());
    let secs: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(12);

    println!("loading model on GPU: {model}");
    let transcriber = Arc::new(Transcriber::load(&model, true).expect("load model"));

    println!("starting capture (default devices)...");
    let (handle, info) = CaptureHandle::start(None, None).expect("capture start");
    println!(
        "system: {:?} | mic: {:?}",
        info.system.device, info.mic.device
    );
    for w in &info.warnings {
        println!("warning: {w}");
    }

    handle.begin_recording();
    println!("\n>>> Play speech through your default output NOW — live transcript for {secs}s: <<<\n");

    let live = start_live(handle.tap(), transcriber, |text, recording| {
        println!("[{}]\n{}\n", if recording { "REC" } else { "FIN" }, text);
    });

    std::thread::sleep(Duration::from_secs(secs));

    let stop_timer = std::time::Instant::now();
    let final_text = live.stop_and_final();
    let stop_ms = stop_timer.elapsed().as_millis();
    let _ = handle.stop_recording();

    println!("\n--- FINAL TRANSCRIPT (Stop flush took {stop_ms} ms) ---\n{final_text}\n");
    if final_text.trim().is_empty() {
        println!("VERDICT: EMPTY (was speech playing through the captured output?)");
    } else {
        println!("VERDICT: OK — live transcript produced");
    }
}
