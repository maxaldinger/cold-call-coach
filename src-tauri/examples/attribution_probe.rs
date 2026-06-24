//! Speaker-attribution proof. Transcribes two separate 16 kHz mono WAVs — one
//! standing in for the mic (AE), one for the system loopback (Prospect) — labels
//! each, and merges by segment start time, exactly as Stop does.
//!
//!   cargo run --example attribution_probe -- <model.bin> <ae.wav> <prospect.wav>

use coldcallcoach_lib::transcribe::{merge_transcript, Transcriber};

fn read_wav_16k_mono(path: &str) -> Vec<f32> {
    let reader = hound::WavReader::open(path).expect("open wav");
    let spec = reader.spec();
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .into_samples::<i32>()
                .map(|s| s.unwrap() as f32 / max)
                .collect()
        }
        hound::SampleFormat::Float => reader.into_samples::<f32>().map(|s| s.unwrap()).collect(),
    };
    if spec.channels == 2 {
        raw.chunks(2)
            .map(|c| (c[0] + c.get(1).copied().unwrap_or(0.0)) * 0.5)
            .collect()
    } else {
        raw
    }
}

fn main() {
    let model = std::env::args()
        .nth(1)
        .expect("usage: attribution_probe <model.bin> <ae.wav> <prospect.wav>");
    let ae_wav = std::env::args().nth(2).expect("need ae.wav");
    let prospect_wav = std::env::args().nth(3).expect("need prospect.wav");

    let tr = Transcriber::load(&model, true).expect("load model");
    let ae = read_wav_16k_mono(&ae_wav);
    let prospect = read_wav_16k_mono(&prospect_wav);

    let ae_segs = tr.transcribe_segments(&ae).expect("ae transcribe");
    let prospect_segs = tr.transcribe_segments(&prospect).expect("prospect transcribe");

    println!("--- AE (mic) segments ---");
    for s in &ae_segs {
        println!("  t0={:>4.1}s  {}", s.t0_cs as f32 / 100.0, s.text);
    }
    println!("--- Prospect (loopback) segments ---");
    for s in &prospect_segs {
        println!("  t0={:>4.1}s  {}", s.t0_cs as f32 / 100.0, s.text);
    }

    let merged = merge_transcript(&[("AE", &ae_segs), ("Prospect", &prospect_segs)]);
    println!("\n--- MERGED (speaker-attributed, time-ordered) ---\n{merged}");
}
