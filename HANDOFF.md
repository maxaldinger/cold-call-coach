# Cold Call Coach — Handoff

A single-user, **local-only Windows desktop app** for a Bito sales rep. It records a
**cold call**, transcribes it locally with speaker labels, and on **Stop → Score**
makes ONE LLM call that returns a **lean coaching report** + a **MEDDPICC** snapshot —
judged against what Bito actually does. It also has an in-call question cheat-sheet,
a Tamagotchi pet that tracks your call volume, history, light/dark themes, and
website-based context auto-fill.

- **Repo:** `D:\Claude\Claude projects\COLD CALL SCORING` · remote
  `github.com/maxaldinger/cold-call-coach` (**private**) · branch `main`.
- **Origin:** spun off from the sibling **Tell** app (`..\Tell`), reusing its proven
  audio capture + local Whisper transcription. Tell is untouched.
- **Stack:** Tauri 2 → Windows `.exe`; React + TypeScript + Vite; Rust backend;
  whisper.cpp (CUDA) via `whisper-rs`; SQLite via `tauri-plugin-sql`.

---

## Non-negotiables (carried from Tell)

- **Local-first.** The only outbound requests are the LLM API calls (scoring +
  website-positioning parse) and — only if you use Settings → "auto-fill from your
  website" — fetching that one URL. **Audio and transcripts never leave the box.**
- **Transcripts are ephemeral.** No transcript/audio column anywhere in SQLite. The
  transcript lives in Rust memory; you can Copy it, but it's never persisted. Only
  the coaching report is stored.
- **Single user, single machine.** SQLite (`coldcallcoach.db`) is the only datastore.
- **Never fail silently.** Surface errors; keep the transcript in memory on failure
  so the user can retry; one repair pass on malformed model JSON.
- **Windows only (v1).**

---

## Build & run

The full toolchain is installed on this machine (after a reformat): **rustup, MSVC
C++ Build Tools, CUDA Toolkit 13.3, cmake, LLVM**, plus Node/npm. See
[the `..\Tell` memory] / `NOTES.md` for the exact winget IDs.

**Interactive (normal):**
```
cd "D:\Claude\Claude projects\COLD CALL SCORING"
.\build-cuda.bat npm run tauri dev      # dev window, hot-reloads frontend, recompiles Rust on save
.\build-cuda.bat npm run tauri build    # packaged MSI + NSIS installers
```
`build-cuda.bat` enters MSVC `vcvars` + sets `CUDA_PATH`/`LIBCLANG_PATH`/PATH so
whisper.cpp's CUDA build finds `cl.exe`/`nvcc`/`cmake`/libclang.

**Frontend-only checks (no CUDA needed):** `npm install`, `npx tsc --noEmit`,
`npm run build`.

**Gotcha — scripted/automation builds:** `cmd /c "build-cuda.bat ..."` breaks on the
spaced repo path (cmd quote-stripping → `'D:\Claude\Claude' is not recognized`), and
PowerShell `Set-Location` does NOT set the cwd for a `cmd` child. Reliable approach:
import vcvars into the PowerShell session (write a temp `.bat` in a space-free path
that does `call "<vcvars>" >nul` + `set`, run via `cmd /c`, import each line with
`[Environment]::SetEnvironmentVariable`), then set CUDA/LLVM/cmake/PATH and call
`cargo.exe` / `npm` **directly** (native → PowerShell quotes the spaced manifest path
correctly). Interactive `build-cuda.bat` is fine.

**Bundled resources** (`src-tauri/resources/`, **gitignored**): `ggml-medium.en.bin`
(~1.5 GB) + CUDA runtime DLLs (`cudart64_13`, `cublas64_13`, `cublasLt64_13`). Present
locally; a fresh machine with only the GeForce driver runs offline.

---

## Architecture / where things live

### Rust (`src-tauri/src/`)
- **`audio.rs`** — dual-source capture, the heart of speaker separation: **mic** (cpal)
  = `[You]`, **system loopback** (wasapi crate, NOT cpal — cpal loopback false-positives)
  = `[Prospect]`. Down-mix → 16 kHz mono, two retained buffers. Headphones keep the
  prospect out of your mic.
- **`transcribe.rs`** — local CUDA Whisper (`whisper-rs`, statically linked, `medium.en`).
  Two per-source live workers → merged speaker-labeled stream. `clean_retranscribe`
  does full per-source passes; relabels `AE`→`You`.
- **`aec.rs`** — first-pass acoustic echo cancellation (bulk-delay cross-correlation +
  256-tap NLMS) for the no-headphones case; runs in the clean pass behind the
  `ccc.aec` toggle. Unit-tested: `cargo test aec` (2/2). Linear only; double-talk is
  basic.
- **`coaching.rs`** — **THE engine.** Provider-agnostic:
  - `call_llm(key, model, effort, system, user, json)` routes by `is_openai(model)`:
    `gpt*/chatgpt/o1/o3/o4` → **OpenAI** (`call_openai`, chat completions,
    `response_format: json_object`, optional `reasoning_effort`, no `max_tokens`);
    else → **Anthropic** (`call_claude`, messages API, cached system block).
  - Keychain (Windows Credential Manager) holds **both** keys: `anthropic_api_key`
    and `openai_api_key` under service `ai.bito.coldcallcoach`.
  - The big coaching prompt (`SYSTEM_TEMPLATE` + `OUTPUT_EXAMPLE`): evidence-spine
    anti-hallucination, 10-dimension rubric, a **Bito claim audit** (catches over/mis-
    claims vs the catalog), a **MEDDPICC** 8-entry snapshot, **voicemail scoring**
    (a real voicemail is `analyzable=true` and scored on hook/reason/value/relevance/
    tone/callback-ask; conversational dims → `not_applicable`), and a **transcription
    leniency** rule (don't penalize STT garbling of proper nouns — e.g. "Bito" heard
    as "Biddow").
  - `post_process` — DETERMINISTIC Rust guardrails: recompute `overall_score` from the
    canonical `WEIGHTS` table over `scored` dims only (N/A/insufficient excluded),
    force null on thin/no-signal, clamp `grade_band` ≤ developing on any
    `wrong_metric`/`not_a_bito_capability` claim.
  - `parse_company_site` — fetch a URL (reqwest) → strip HTML (regex) → LLM extracts a
    `SiteContext` positioning profile for Settings auto-fill.
- **`lib.rs`** — Tauri commands: `list_audio_devices`, `start_session`,
  `begin_recording`, `stop_recording`, `clean_retranscribe(aec)`,
  `set_api_key`/`has_api_key`, `set_openai_key`/`has_openai_key`,
  `parse_company_site(url, model, effort)`, `analyze_call(context, prospect, date,
  model, effort)`, `set_render/capture_device`, `capture_status`. Picks the right
  provider's key via `is_openai`; **defaults: model `gpt-5.4-mini`, effort `low`**.
- **`migrations/0001_init.sql`** — `context_profile`, `call`
  (prospect/date/model/overall_score/grade_band), `coaching_report` (one opaque JSON
  blob per call). **No transcript column** by design.

### Frontend (`src/`)
- **`App.tsx`** — capture UI (device rows, meters, record bar, "Who did you call?
  (optional)", Score), the **3-panel output row** (Coaching · MEDDPICC · Transcript),
  the **light/dark toggle** (☀/☾ in the topbar, `ccc.theme`), and the pet refresh
  signal (`petRefresh` bumps after a score → feeds the pet). Score requires only a
  transcript (name optional). Passes `model` + `effort` to `analyze_call`.
- **`outputs.tsx`** — `CoachingReport` TS types; **lean `ReportView`** (score header +
  biggest fix + "What's costing you points" [docked dims only]) with a **"Show full
  reasoning"** expander revealing the rest; `MeddpiccList`; `MeddpiccReminder` (the
  **8-question** in-call cheat-sheet, MEDDPICC + POC combined); `Panel`/`CopyButton`/
  `reportToText`. (No "what went well" by design.)
- **`Settings.tsx`** — Bito context editor (company, value prop, ideal opener, catalog,
  personas, objection answer-key, extra context); **both API keys**; **free-text Model
  field** + **Level** (Instant/Medium/High → reasoning_effort low/medium/high); AEC
  toggle; working-hours (for the pet); **website auto-fill** (`parse_company_site`).
- **`Pet.tsx`** — the Tamagotchi blob. Mood is derived from `call` history + current
  time with **working-hours-only decay** (a call's feed halves each working day; tuned
  so ~40 calls/day = thriving, ~25 = content, ~10 = hungry; voicemails count as full
  dials; score is a ±15% modifier). It **hops** around a `.pet-habitat` strip at the
  bottom of the Coaching panel; editable name (`ccc.petName`); happiness bar + stats.
- **`History.tsx`** — list past scored calls + reopen the stored report read-only +
  delete. **`context.ts`** — Bito `BITO_SEED` + `loadContext`/`saveProfile`.
  **`styles.css`** — theme variables + `[data-theme="light"]` overrides.

---

## Model / provider config (READ THIS)

- **Default: `gpt-5.4-mini` at "Instant" (`reasoning_effort: low`)** — chosen (via a
  web check, June 2026) as the fast/cheap/accurate pick for this structured task;
  `gpt-5.4-nano` is cheaper. Set in `App.tsx`, `Settings.tsx`, `lib.rs` defaults.
- **The model is a free-text field** in Settings (key `ccc.model`), routed by prefix.
  Type `gpt-5.4-nano`, `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, etc.
- **⚠️ Unverified against the live API:** the exact GPT-5.4 model id and the
  `reasoning_effort` param were set without an API round-trip (couldn't reach OpenAI
  from the build env). If scoring errors with "OpenAI API error (…)", confirm the
  model id / param against the user's account and adjust (`coaching.rs::call_openai`
  + the defaults). The free-text field lets the user correct it inline.
- Keys live in the OS keychain; the user enters them in Settings (one per provider).

---

## Open TODOs / next steps

1. **Pet "more life" upgrade — NOT DONE (blocked).** The user wants the blob much
   livelier (blink, look-around, mood flourishes: sparkles when thriving / sweat-drop
   + "feed me" bubble when hungry / floating Zzz napping, a **"fed" celebration** on a
   scored call, level-up/down beats). A multi-agent design workflow
   (`design-lively-pet`) was launched but **all agents rate-limited and returned
   nothing** — re-run when the API isn't throttled, or do it solo. **Original inline
   SVG/CSS only** (offline app; no external sprite/image assets; don't copy Tamagotchi
   or any IP). Integrate in `Pet.tsx` (`BlobFace` + a behavior scheduler) + `App.css`.
2. **Separate "deep dive" generation.** Today "Show full reasoning" reveals detail that
   the main call *already* generated. The user asked for it to be **generated
   separately** on demand — i.e. the main `analyze_call` produces only the lean score,
   and a new command generates the full reasoning / an **"intel brief"** when expanded.
   This also speeds up the main score. Bigger change to `coaching.rs` (lean schema +
   a `deep_dive` command, likely returning markdown).
3. **Quick dial logger.** For the pet to reflect real volume (40 dials/day), add
   one-tap **`+ Voicemail` / `+ No answer`** buttons that log a dial WITHOUT the full
   record→score flow, stored separately so they feed the pet without cluttering
   History. Discussed, not built.
4. **Light-mode polish.** First pass (variable flip + a few hardcoded `#0e1117` →
   `var(--bg)`); some accent chips may read slightly off on white.
5. **AEC hardening.** Current NLMS is linear with basic double-talk handling; could add
   a proper double-talk detector + residual suppressor, or swap in WebRTC APM.

---

## Verification status

- Frontend: `tsc` + `vite build` clean. Rust: `cargo build` clean (debug + release);
  release **MSI + NSIS installers** were produced earlier (`target/release/bundle/`).
- `cargo test aec` passes 2/2 (synthetic-echo cancellation + no-reference passthrough).
- The app runs (`tauri dev`) and has been driven through the UI.
- **Not API-verified:** live OpenAI GPT-5.4 scoring (see Model config caveat) and the
  GPT/Claude *quality* of the lean report + voicemail scoring (needs real calls).

## Misc

- **Git identity:** commit as `Max Aldinger <max@gowarm.org>` (set per-repo).
- LF→CRLF git warnings on Windows are benign.
- Co-author trailer on commits: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Commit history (newest first): voicemail scoring → OpenAI provider → lean report +
  STT fix + light mode → name-optional/8-question/hopping-blob/Haiku → pet habitat →
  pet retune+blob → pet → MEDDPICC reminder → 3-panel layout → MEDDPICC+website+copy →
  AEC fix → AEC → initial.
