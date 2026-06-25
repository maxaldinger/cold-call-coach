# Cold Call Coach

A single-user, **local-first** Windows desktop app that records a cold call,
transcribes it on-device with speaker labels, and turns it into a lean AI
coaching report — a scorecard, the single highest-leverage fix, an on-demand
MEDDPICC snapshot, and a one-click call summary. It also keeps a little
Tamagotchi pet that tracks your daily call volume.

Built for a Bito sales rep; the coaching is graded against what your company
actually does (fully editable in Settings).

> **Local-first.** Audio and transcripts **never leave your machine** — they live
> in memory and are never written to disk. The only outbound requests are the LLM
> API call you trigger when you *score* a call (and, optionally, fetching one URL
> if you use Settings → "auto-fill from your website"). Transcripts are ephemeral:
> nothing but the coaching report is ever stored.

## Features

- **Dual-source capture + live transcription.** Your mic = `You`, the system
  loopback (the other side of the call) = `Prospect`, transcribed live on your
  GPU with whisper.cpp — no cloud, no sidecar.
- **Multi-speaker diarization.** On a group/discovery call, the "Clean" pass runs
  offline speaker diarization on the prospect side and splits it into
  `Prospect 1 / 2 / 3` by voiceprint (1:1 calls stay a single `Prospect`).
- **One-call coaching.** A single LLM call returns a scored breakdown (opener,
  value pitch vs. what the company actually does, objection handling, next step),
  the biggest fix, and a Bito-claim audit — with anti-hallucination guardrails and
  the score recomputed deterministically in Rust.
- **On-demand MEDDPICC** and **transcript summary** buttons.
- **History**, light/dark (HubSpot-style slate) themes, and a call-volume pet that
  lives a daily survival arc.

## Stack

Tauri 2 (Rust + React/TypeScript/Vite) · whisper.cpp (CUDA) via `whisper-rs` ·
sherpa-onnx for offline diarization · SQLite via `tauri-plugin-sql`. API keys are
stored in the **Windows Credential Manager**, never in the database, source, or a
file.

## Requirements

- Windows 10/11, **x64**, with an **NVIDIA GPU + driver** (the speech models run on
  CUDA).
- An **OpenAI or Anthropic API key** (entered in Settings) for scoring. Everything
  else — recording, transcription, diarization — is fully offline.

## Install

Grab the installer from the latest [Release](../../releases) and run
`Cold Call Coach_x.y.z_x64-setup.exe`. It bundles the speech models + CUDA runtime,
so it runs offline after install. It's unsigned, so Windows SmartScreen will show
"More info → Run anyway." First launch: open **Settings**, paste your API key, then
record and score a call.

## Build from source

The full toolchain (rustup, MSVC C++ Build Tools, CUDA Toolkit 13.3, CMake, LLVM,
Node/npm) must be installed. `build-cuda.bat` sets up the MSVC + CUDA environment
so whisper.cpp's CUDA build finds `cl.exe` / `nvcc` / `cmake` / libclang.

```bat
build-cuda.bat npm run tauri dev      :: dev window (hot-reloads frontend)
build-cuda.bat npm run tauri build    :: packaged MSI + NSIS installers
```

Frontend-only checks need no CUDA: `npm install`, `npx tsc --noEmit`, `npm run build`.

Bundled resources live in `src-tauri/resources/` (gitignored — large): the Whisper
model (`ggml-medium.en.bin`), the diarization ONNX models, and the CUDA + sherpa
runtime DLLs.

## Model / provider

Scoring is provider-agnostic, routed by model name: `gpt*` / `o*` → OpenAI,
`claude-*` → Anthropic. The default is **`gpt-5.4-mini`** (fast, cheap, reliable for
the structured scoring task); pick another from the dropdown in Settings, including
`gpt-5.4-nano` (cheapest) or `gpt-5.5` / Claude for higher quality.

## Notes

- Windows-only (v1). Single user, single machine — SQLite (`coldcallcoach.db`) is
  the only datastore, and it never holds a transcript or audio.
- Wear headphones so the prospect's voice stays out of your mic; if you can't,
  enable bleed-cancellation (AEC) in Settings and run a Clean pass after the call.
