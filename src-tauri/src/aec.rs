//! Acoustic echo cancellation (FIRST PASS) — cancel the prospect's voice bleeding
//! into the rep's mic when the rep is NOT wearing headphones.
//!
//! The setup is ideal for AEC: the system-loopback buffer IS the exact far-end
//! reference (literally the samples that played out the speakers — the prospect).
//! So when the prospect's voice leaks back into the mic, we can model that echo
//! path from the reference and subtract it.
//!
//! Pipeline:
//!   1. Estimate the BULK delay between the reference and its echo in the mic via
//!      normalized cross-correlation over a high-energy window (speaker/ADC/DAC
//!      latency + acoustic travel — typically tens of ms).
//!   2. Run an NLMS (normalized least-mean-squares) adaptive FIR filter on the
//!      delay-aligned reference to model the residual echo path (gain + early
//!      reflections) and subtract the predicted echo from the mic. What's left is
//!      (mostly) the rep's own voice.
//!
//! This is a LINEAR first pass: no residual spectral suppression, and only basic
//! double-talk handling (a conservative step size + adapt-only-when-the-reference-
//! is-active). It is SAFE to run unconditionally: with headphones there is no
//! echo, the filter converges toward zero, and the mic passes through ~unchanged.
//!
//! All buffers are 16 kHz mono f32 — the same format transcription consumes.

/// NLMS filter length (taps). ~16 ms at 16 kHz — enough to cover residual delay
/// jitter + early reflections AFTER the bulk delay has been aligned out. Kept
/// short so it converges fast and stays cheap (cost is O(n · taps)).
const FILTER_TAPS: usize = 256;

/// Max bulk delay searched, in samples (~150 ms at 16 kHz).
const MAX_DELAY: usize = 2400;

/// NLMS step size (0 < mu < 2). Conservative, for double-talk robustness.
const MU: f32 = 0.3;

/// NLMS regularization — avoids a divide-by-zero on quiet frames.
const EPS: f32 = 1e-6;

/// Skip adaptation when the reference frame energy is below this (no far-end → no
/// echo to model → don't let the normalized update run wild on near-silence).
const REF_ACTIVITY: f32 = 1e-4;

/// Cancel the `reference` (prospect / loopback) echo from `mic`, returning a
/// de-echoed buffer the same length as `mic`. Both are 16 kHz mono. If either is
/// empty the mic is returned unchanged.
pub fn cancel_echo(mic: &[f32], reference: &[f32]) -> Vec<f32> {
    if mic.is_empty() || reference.is_empty() {
        return mic.to_vec();
    }
    let delay = estimate_delay(mic, reference, MAX_DELAY);
    nlms_cancel(mic, reference, delay, FILTER_TAPS, MU)
}

/// Estimate the bulk delay (in samples) by which the echo in `mic` lags
/// `reference`, via normalized cross-correlation over a high-energy reference
/// window. Returns 0 when there is no usable correlation (e.g. no echo at all).
fn estimate_delay(mic: &[f32], reference: &[f32], max_delay: usize) -> usize {
    // ~3 s window, bounded for speed and clamped to both buffers.
    let win = 48_000.min(reference.len()).min(mic.len());
    if win == 0 {
        return 0;
    }
    let start = strongest_window_start(reference, win);
    // Don't index past the mic when shifting the window forward by the lag.
    let max_d = max_delay.min(mic.len().saturating_sub(start + win));
    if max_d == 0 {
        return 0;
    }

    // Reference energy in the window is constant across lags, so normalizing by
    // the mic energy at each lag is enough to pick the true alignment.
    let mut best_lag = 0usize;
    let mut best_score = f32::NEG_INFINITY;
    for d in 0..=max_d {
        let mut dot = 0.0f32;
        let mut mic_energy = 0.0f32;
        for i in 0..win {
            let r = reference[start + i];
            let m = mic[start + i + d];
            dot += r * m;
            mic_energy += m * m;
        }
        let score = if mic_energy > 0.0 {
            dot / mic_energy.sqrt()
        } else {
            0.0
        };
        if score > best_score {
            best_score = score;
            best_lag = d;
        }
    }
    best_lag
}

/// Coarse scan for the start of the highest-energy `win`-sample window in `x`.
fn strongest_window_start(x: &[f32], win: usize) -> usize {
    if x.len() <= win {
        return 0;
    }
    let step = (win / 4).max(1);
    let mut best_start = 0usize;
    let mut best_energy = -1.0f32;
    let mut s = 0usize;
    while s + win <= x.len() {
        // Subsample for speed — we only need the roughly-loudest region.
        let mut e = 0.0f32;
        let mut i = 0usize;
        while i < win {
            let v = x[s + i];
            e += v * v;
            i += 16;
        }
        if e > best_energy {
            best_energy = e;
            best_start = s;
        }
        s += step;
    }
    best_start
}

/// NLMS echo canceller. `delay` aligns the reference to the mic's echo; an FIR
/// filter of `taps` length then models the residual path and is subtracted from
/// the mic. Returns `mic - predicted_echo`, clamped to [-1, 1].
fn nlms_cancel(mic: &[f32], reference: &[f32], delay: usize, taps: usize, mu: f32) -> Vec<f32> {
    let n = mic.len();
    let mut w = vec![0.0f32; taps]; // adaptive filter weights
    // History of the delay-aligned reference, most-recent first: x_hist[0] is the
    // current aligned sample, x_hist[k] is k samples ago.
    let mut x_hist = vec![0.0f32; taps];
    let mut norm = 0.0f32; // running Σ x_hist[k]^2 (the NLMS denominator)
    let mut out = Vec::with_capacity(n);

    for i in 0..n {
        // Current delay-aligned reference sample = reference[i - delay].
        let xr = if i >= delay {
            reference.get(i - delay).copied().unwrap_or(0.0)
        } else {
            0.0
        };

        // Shift history right by one and insert the new sample at the front.
        let dropped = x_hist[taps - 1];
        for k in (1..taps).rev() {
            x_hist[k] = x_hist[k - 1];
        }
        x_hist[0] = xr;
        norm += xr * xr - dropped * dropped;
        if norm < 0.0 {
            norm = 0.0; // guard against float drift
        }
        // Periodically recompute the running energy exactly to bound drift.
        if i % 4096 == 0 {
            norm = x_hist.iter().map(|v| v * v).sum();
        }

        // Predict the echo and subtract it.
        let mut echo = 0.0f32;
        for k in 0..taps {
            echo += w[k] * x_hist[k];
        }
        let e = mic[i] - echo;
        out.push(e.clamp(-1.0, 1.0));

        // Adapt only when the reference is active (there IS echo to model);
        // otherwise the normalized step would amplify noise on near-silence.
        if norm > REF_ACTIVITY {
            let g = mu * e / (norm + EPS);
            for k in 0..taps {
                w[k] += g * x_hist[k];
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Tests — runnable with `cargo test aec` to validate the DSP math even on a
// machine without the CUDA/whisper build chain (these don't touch whisper).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic broadband noise in [-1, 1) — a clean test signal whose
    /// cross-correlation has an unambiguous peak (unlike a pure sine).
    fn noise(seed: &mut u32) -> f32 {
        *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        ((*seed >> 9) as f32 / (1u32 << 23) as f32) * 2.0 - 1.0
    }

    fn energy(x: &[f32]) -> f32 {
        x.iter().map(|v| v * v).sum()
    }

    /// Pure-echo case (no near-end talk): the canceller should remove most of the
    /// echo, leaving near-silence. Validates the core cancellation.
    #[test]
    fn cancels_pure_echo() {
        let n = 48_000; // 3 s
        let delay = 320usize; // ~20 ms
        let mut seed = 12345u32;
        let reference: Vec<f32> = (0..n).map(|_| 0.5 * noise(&mut seed)).collect();

        // Multi-tap echo path (gain + early reflections), all within the filter span.
        let mut mic = vec![0.0f32; n];
        for i in 0..n {
            let mut e = 0.0f32;
            if i >= delay {
                e += 0.50 * reference[i - delay];
            }
            if i >= delay + 5 {
                e += 0.25 * reference[i - delay - 5];
            }
            if i >= delay + 17 {
                e += 0.12 * reference[i - delay - 17];
            }
            mic[i] = e;
        }

        let out = cancel_echo(&mic, &reference);

        // Measure over the second half (after the filter has converged).
        let h = n / 2;
        let residual = energy(&out[h..]);
        let original = energy(&mic[h..]);
        // Expect a large reduction (>10 dB ERLE → residual < 10% of the echo).
        assert!(
            residual < 0.1 * original,
            "weak cancellation: residual {residual} vs echo {original} (want < 10%)"
        );
    }

    /// No-reference case (≈ headphones): with a silent reference the filter never
    /// adapts and the mic must pass through unchanged — the safety property.
    #[test]
    fn passes_through_when_no_reference() {
        let n = 16_000;
        let mut seed = 99u32;
        let nearend: Vec<f32> = (0..n).map(|_| 0.3 * noise(&mut seed)).collect();
        let reference = vec![0.0f32; n]; // nothing playing out the speakers

        let out = cancel_echo(&nearend, &reference);

        // Identical (the clamp is a no-op for in-range near-end).
        let mut max_dev = 0.0f32;
        for i in 0..n {
            max_dev = max_dev.max((out[i] - nearend[i]).abs());
        }
        assert!(max_dev < 1e-6, "near-end was altered with no reference: {max_dev}");
    }
}
