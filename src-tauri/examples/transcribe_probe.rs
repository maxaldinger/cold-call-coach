//! Proof that whisper.cpp (CUDA) transcribes from an in-memory buffer.
//!
//!     cargo run --example transcribe_probe -- <model.bin> <audio16k_mono.wav>
//!
//! Loads the model on the GPU, reads a 16 kHz mono WAV into memory, transcribes
//! it, and prints the text + the realtime factor (>1 confirms GPU acceleration).

use std::time::Instant;

use coldcallcoach_lib::transcribe::Transcriber;

fn main() {
    let model = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "src-tauri/resources/models/ggml-tiny.en.bin".to_string());
    let wav = std::env::args()
        .nth(2)
        .expect("usage: transcribe_probe <model.bin> <audio16k_mono.wav>");

    let reader = hound::WavReader::open(&wav).expect("open wav");
    let spec = reader.spec();
    println!(
        "wav: {} Hz, {} ch, {} bits",
        spec.sample_rate, spec.channels, spec.bits_per_sample
    );
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
    let mono: Vec<f32> = if spec.channels == 2 {
        raw.chunks(2)
            .map(|c| (c[0] + c.get(1).copied().unwrap_or(0.0)) * 0.5)
            .collect()
    } else {
        raw
    };
    if spec.sample_rate != 16000 {
        eprintln!("WARNING: expected 16 kHz; got {} Hz", spec.sample_rate);
    }

    println!("loading model on GPU: {model}");
    let t0 = Instant::now();
    let tr = match Transcriber::load(&model, true) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("FATAL: {e}");
            std::process::exit(1);
        }
    };
    println!("model loaded in {:.2}s (gpu={})", t0.elapsed().as_secs_f64(), tr.is_gpu());

    let dur = mono.len() as f64 / 16000.0;
    println!("transcribing {:.1}s of audio...", dur);
    let t1 = Instant::now();
    let text = match tr.transcribe(&mono) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("FATAL: {e}");
            std::process::exit(1);
        }
    };
    let el = t1.elapsed().as_secs_f64();
    println!("--- transcript (inference {:.2}s = {:.1}x realtime) ---", el, dur / el);
    println!("{text}");
}
