//! Slice-1 capture proof — REAL third-party audio edition.
//!
//! This probe does NOT generate any audio itself (a self-played tone proved
//! nothing — cpal's loopback gave a false positive on its own output). It simply
//! captures the default system-loopback + mic for a few seconds. Play real audio
//! (YouTube, music, anything) through your default output device while it runs;
//! the system peak must go clearly nonzero and the dev WAV must contain that
//! audio.
//!
//!     cargo run --example capture_probe --manifest-path src-tauri/Cargo.toml [seconds]

use std::time::Duration;

use coldcallcoach_lib::audio::{self, CaptureHandle};

fn main() {
    let secs: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(6);

    // Part 2 proof: enumerate ALL render + capture endpoints.
    match audio::list_devices() {
        Ok(list) => {
            println!("Render (output) endpoints:");
            for d in &list.render {
                println!("  - {}{}", d.name, if d.is_default { "  (default)" } else { "" });
            }
            println!("Capture (mic) endpoints:");
            for d in &list.capture {
                println!("  - {}{}", d.name, if d.is_default { "  (default)" } else { "" });
            }
            println!();
        }
        Err(e) => println!("device enumeration failed: {e}\n"),
    }

    println!("Tell capture probe — capturing default SYSTEM (loopback) + MIC for {secs}s.");
    println!(">>> Play real audio (YouTube/music) through your default output NOW. <<<\n");

    let (handle, info) = match CaptureHandle::start(None, None) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("FATAL: capture failed to start: {e}");
            std::process::exit(1);
        }
    };
    println!("  system: {:?}", info.system);
    println!("  mic:    {:?}", info.mic);
    for w in &info.warnings {
        println!("  warning: {w}");
    }
    println!();

    // MONITOR phase: not recording yet. Levels must still move if audio plays,
    // while no samples are retained (sys_n stays 0). This is what the meters use.
    println!("[monitor] not recording — levels live, nothing retained:");
    for _ in 0..4 {
        std::thread::sleep(Duration::from_millis(500));
        let s = handle.status();
        println!(
            "  rec={} sys_lvl={:.4} mic_lvl={:.4} sys_n={} mic_n={}",
            s.recording, s.system.level, s.mic.level, s.system.samples, s.mic.samples
        );
    }

    // Flip to recording so the buffers accumulate.
    handle.begin_recording();
    println!("[recording] now retaining audio:");

    for _ in 0..(secs * 2) {
        std::thread::sleep(Duration::from_millis(500));
        let s = handle.status();
        println!(
            "  t={:>4.1}s  sys_lvl={:.4}  mic_lvl={:.4}  sys_n={} mic_n={}",
            s.elapsed_secs, s.system.level, s.mic.level, s.system.samples, s.mic.samples
        );
    }

    let res = handle.stop_recording();
    let su = &res.summary;
    println!("\n--- summary ---");
    println!("duration:  {:.2}s", su.duration_secs);
    println!(
        "system:    {} samples, peak {:.4}  [{}]",
        su.system_samples,
        su.system_peak,
        info.system.device.as_deref().unwrap_or("?")
    );
    println!(
        "mic:       {} samples, peak {:.4}  [{}]",
        su.mic_samples,
        su.mic_peak,
        info.mic.device.as_deref().unwrap_or("?")
    );
    println!(
        "mixed:     {} samples @ {} Hz ({:.2}s)",
        su.mixed_samples,
        su.mixed_rate,
        su.mixed_samples as f32 / su.mixed_rate as f32
    );
    println!("dev wav:   {:?}", su.dev_wav_path);

    println!("\n--- verdicts ---");
    println!(
        "system loopback: {}",
        verdict(
            su.system_peak > 0.01,
            "captured real audio from the render endpoint",
            "SILENT — nothing was playing, wrong endpoint, or loopback failed"
        )
    );
    println!(
        "mic capture:     {}",
        verdict(su.mic_samples > 0, "samples flowed", "NO SAMPLES")
    );
}

fn verdict(ok: bool, yes: &str, no: &str) -> String {
    if ok {
        format!("OK ({yes})")
    } else {
        format!("FAIL ({no})")
    }
}
