//! Offline speaker diarization (sherpa-onnx) — clusters the prospect-side audio
//! by voiceprint so multiple remote participants get distinct labels instead of
//! all collapsing into one "[Prospect]".
//!
//! SECURITY / COST: 100% local. Runs ONNX models on-device (segmentation +
//! speaker embedding + clustering), statically linked into the .exe. No network,
//! no API, no cost. Used only in the on-demand Clean pass — the live transcript
//! stays the simple mic=You / loopback=Prospect split.

use sherpa_onnx::{
    FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
    OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
    SpeakerEmbeddingExtractorConfig,
};

use crate::audio::TARGET_RATE;
use crate::transcribe::SpeakerSpan;

/// A loaded diarization pipeline (pyannote segmentation + speaker embedding +
/// clustering). Loading the ONNX models is the expensive step, so build once and
/// reuse for the app's lifetime.
pub struct Diarizer {
    sd: OfflineSpeakerDiarization,
}

impl Diarizer {
    /// Load the segmentation + embedding models and build the diarizer. Speaker
    /// count is auto-detected (num_clusters < 0 => use the clustering threshold).
    pub fn load(seg_model: &str, emb_model: &str) -> Result<Self, String> {
        let config = OfflineSpeakerDiarizationConfig {
            segmentation: OfflineSpeakerSegmentationModelConfig {
                pyannote: OfflineSpeakerSegmentationPyannoteModelConfig {
                    model: Some(seg_model.into()),
                },
                ..Default::default()
            },
            embedding: SpeakerEmbeddingExtractorConfig {
                model: Some(emb_model.into()),
                ..Default::default()
            },
            clustering: FastClusteringConfig {
                num_clusters: -1, // auto: let the threshold decide how many speakers
                threshold: 0.5,
                ..Default::default()
            },
            ..Default::default()
        };
        let sd = OfflineSpeakerDiarization::create(&config)
            .ok_or_else(|| "failed to initialize speaker diarization (check the model files)".to_string())?;
        Ok(Self { sd })
    }

    /// Diarize a 16 kHz mono buffer into speaker-attributed spans (centiseconds).
    /// Returns an empty vec for very short audio (caller treats that as 1 speaker).
    pub fn diarize(&self, samples_16k_mono: &[f32]) -> Result<Vec<SpeakerSpan>, String> {
        if samples_16k_mono.len() < TARGET_RATE as usize {
            return Ok(Vec::new()); // < 1s — not worth diarizing
        }
        let result = self
            .sd
            .process(samples_16k_mono)
            .ok_or_else(|| "speaker diarization failed".to_string())?;
        let spans = result
            .sort_by_start_time()
            .into_iter()
            .map(|s| SpeakerSpan {
                start_cs: (s.start as f64 * 100.0).round() as i64,
                end_cs: (s.end as f64 * 100.0).round() as i64,
                speaker: s.speaker,
            })
            .collect();
        Ok(spans)
    }
}
