# Cold Call Coach — build notes

A single-user, **local-only** Windows desktop app that records a **cold call**,
transcribes it locally with speaker labels, and on Stop makes ONE Claude API call
that returns a **coaching report**: a scored breakdown of the call plus concrete,
quoted feedback on how to do better next time — all judged against what **Bito**
actually does.

It is a spin-off of the sibling **Tell** app: it reuses Tell's hard-won audio
capture + local Whisper transcription verbatim, and swaps Tell's CRM/MEDDPICC/LOU
outputs for a cold-call coaching engine.

## Non-negotiables (carried from Tell)

- **100% local.** The only outbound network request the app ever makes is the
  Claude API call that produces the coaching report. Nothing else leaves the box.
- **Transcripts are ephemeral.** Raw audio and the transcript live in memory only.
  They are never written to disk or to SQLite. The schema has no column for either
  — by design. Only the coaching report (scores + feedback) is persisted.
- **Single user, single machine.** SQLite is the only datastore. No auth, no
  server, no multi-tenancy. DB file: `coldcallcoach.db`.
- **Never fail silently.** Surface every error; keep the transcript in memory on
  analysis failure so the user can retry; repair-retry malformed model JSON once.
- **Windows is the only v1 target.**

## Speaker separation (the headphones model)

The rep ("[You]") and the prospect ("[Prospect]") are separated **by audio
source, not acoustics**:

- **mic** (cpal capture endpoint) → the rep's voice → labeled **[You]**
- **system loopback** (WASAPI render endpoint) → the prospect's voice (the dialer
  / softphone playing through the speakers) → labeled **[Prospect]**

Two per-source live Whisper workers transcribe each stream independently and merge
by timestamp into one labeled transcript. This is reliable **as long as the rep
wears headphones** — otherwise the prospect's voice plays out the speakers and
bleeds into the mic, so the mic stream picks up both voices and the same words get
labeled twice. The UI shows a persistent 🎧 reminder.

### Echo cancellation (first pass — `src-tauri/src/aec.rs`)

For the no-headphones case there is now a **first-pass acoustic echo canceller**.
Because the loopback buffer is the *exact* far-end reference (the samples that
played out the speakers), we can model and subtract the echo:

1. **Bulk-delay estimation** — normalized cross-correlation over a high-energy
   window finds how far the mic's echo lags the reference (speaker/DAC/ADC latency
   + acoustic travel).
2. **NLMS adaptive FIR filter** (256 taps ≈ 16 ms, μ=0.3) on the delay-aligned
   reference models the residual echo path and subtracts the predicted echo from
   the mic; what's left is mostly the rep's voice.

It runs in the **clean pass** (post-call, on the retained 16 kHz buffers), gated by
a Settings toggle ("Not wearing headphones?" → `ccc.aec`). With headphones (no
echo) the filter converges toward zero, so the mic passes through ~unchanged and
it's safe to leave on. The `system` (prospect) buffer is the clean reference and is
never altered.

**Limitations (it's a first pass):** linear cancellation only (no residual spectral
suppression), and only basic double-talk handling (conservative step size +
adapt-only-when-the-reference-is-active). It applies to the clean pass, not the
live ticker. The DSP math is covered by `cargo test aec` (synthetic-echo ERLE +
no-reference passthrough) so it's verifiable without the CUDA/whisper build chain.
A future hardening pass could add a proper double-talk detector + residual
suppressor, or swap in WebRTC APM.

## The coaching engine (`src-tauri/src/coaching.rs`)

ONE structured Claude call → a `CoachingReport`. Designed to make fabrication
structurally hard and to keep Bito claims honest.

- **Evidence spine.** The model first builds a flat `evidence[]` of verbatim
  transcript quotes (with speaker), and every score / claim / strength references
  it by index. A scored dimension with no evidence is invalid output.
- **10-dimension rubric**, each scored 0–10 or `null` (insufficient evidence),
  with a `status` (scored / not_applicable / insufficient_evidence) and
  `confidence`. Dimensions: opener/pattern-interrupt, reason-for-call, earning
  permission, value-articulation-&-accuracy, relevance/personalization, discovery
  questions, objection handling, talk-to-listen ratio, tone/pace/filler
  (text-only), and securing a next step.
- **Bito claim audit.** Every product claim the rep made is extracted and given a
  verdict (accurate / overclaimed / wrong_metric / not_a_bito_capability /
  unverifiable) checked **only** against the seeded Bito catalog. The coach may
  never introduce a Bito capability or metric not in the catalog — even in a
  suggested rephrasing.
- **Deterministic Rust guardrails** (`post_process`, not trusted to the model):
  - recompute `overall_score` from the canonical weight table over `status=scored`
    dimensions only — the headline number is auditable and immune to model math;
  - force `overall_score = null`, `grade_band = insufficient_signal` when the call
    is not `analyzable` (voicemail / gatekeeper / too short / non-call) or nothing
    scored — never a fabricated score on a thin call;
  - clamp `grade_band` to at most `developing` if any claim verdict is
    `wrong_metric` / `not_a_bito_capability` (a technical buyer who catches one
    false claim discounts the rest);
  - backfill each dimension's `weight` from the canonical table by key.
- Plumbing mirrors Tell's `generate.rs`: cached system block, `max_tokens` 8192,
  models `claude-sonnet-4-6` (default) / `claude-opus-4-8` (Settings), defensive
  `extract_json`, one repair pass. API key in Windows Credential Manager
  (`keyring`, service `ai.bito.coldcallcoach`); transcript + key stay in Rust.

## Bito context (`src/context.ts`)

Seeded with the real Bito profile and editable in Settings. Cold-call-specific
fields added on top of Tell's catalog/personas: a one-line value prop, an ideal
pattern-interrupt opener, and a **common-objections → ideal-responses answer key**
the coach grades objection handling against. The catalog is the single source of
truth the claim audit checks against — keep it accurate.

## Stack (inherited from Tell, locked)

- Tauri 2.x → Windows `.exe`; Frontend React + TS + Vite; Backend Rust.
- Transcription: local `whisper.cpp` via `whisper-rs` (CUDA, statically linked),
  `medium.en` model bundled as a Tauri resource.
- Storage: SQLite via `tauri-plugin-sql` (single fresh migration `0001_init.sql`).
- LLM: Anthropic Claude API, one structured call.
- Plugins: `sql`, `notification` (completion toast), `dialog` (delete-call
  confirm only). No `opener` / file-system grants — this app never opens URLs,
  reveals files, or writes documents.

## Build prerequisites — READ FIRST

This machine currently has **Node 24 + npm 11 + git + the GeForce driver**, but
the **Rust/CUDA build chain is NOT installed** (the machine was reformatted). The
frontend typechecks and builds today; the Rust backend will not compile until you
reinstall:

1. **Rust toolchain** — `rustup` (host `x86_64-pc-windows-msvc`).
2. **MSVC C++ Build Tools** — Visual Studio 2022 *Build Tools* with the "Desktop
   development with C++" workload (provides `link.exe` + Windows SDK).
3. **CUDA Toolkit 13.3** + **cmake** + **LLVM/libclang** — needed to compile
   `whisper.cpp` with CUDA. Build via [build-cuda.bat](build-cuda.bat), which
   enters MSVC `vcvars` and sets `CUDA_PATH` / `LIBCLANG_PATH`. First build
   compiles `whisper.cpp` from source (slow); cached afterward.

Bundled resources (already present in `src-tauri/resources/`, gitignored): the
`ggml-medium.en.bin` model + the CUDA runtime DLLs (`cudart64_13`, `cublas64_13`,
`cublasLt64_13`). A fresh machine with only the GeForce driver runs offline.

## Build & run

```
npm install            # frontend deps
npm run build          # tsc typecheck + vite build (frontend only — works today)
npm run tauri dev      # full app — REQUIRES the Rust/CUDA chain above
npm run tauri build    # packaged .exe
```

Set your Anthropic API key in Settings (gear icon) before scoring a call — it is
stored in the OS keychain, never in the DB or source.

## Probes (dev harnesses, `src-tauri/examples/`)

`capture_probe`, `transcribe_probe`, `live_probe`, `attribution_probe` are carried
over from Tell for exercising the audio/transcription chain headlessly. The old
`generate_probe` / `xlsx_probe` were removed with the LOU engine.

## Project layout

```
COLD CALL SCORING/
├── index.html, vite.config.ts, tsconfig*.json, package.json
├── src/                     React frontend
│   ├── main.tsx, App.tsx, App.css, styles.css
│   ├── context.ts           Bito context (seed + load/save)
│   ├── outputs.tsx          CoachingReport types + ReportView
│   ├── Settings.tsx         context editor + API key + model
│   └── History.tsx          past calls, reopen report, delete
└── src-tauri/               Rust backend
    ├── Cargo.toml, build.rs, tauri.conf.json, build-cuda.bat
    ├── capabilities/default.json
    ├── migrations/0001_init.sql   (context_profile, call, coaching_report — no transcript column)
    └── src/{main.rs, lib.rs, audio.rs, transcribe.rs, coaching.rs}
```
