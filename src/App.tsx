import { useEffect, useRef, useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { Settings } from "./Settings";
import { History } from "./History";
import { Pet } from "./Pet";
import { ContextProfile, loadContext } from "./context";
import {
  CoachingReport,
  CopyButton,
  Empty,
  MeddpiccItem,
  MeddpiccList,
  MeddpiccReminder,
  Panel,
  ReportView,
  localIsoDate,
  reportToText,
} from "./outputs";
import "./App.css";

async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    /* notifications are best-effort */
  }
}

const DB = "sqlite:coldcallcoach.db";

// Persist a coaching report. Per the hard rule, the transcript is NEVER written
// here — only the call metadata + the report payload (an opaque JSON blob).
// Returns the new call id.
async function persistReport(
  prospect: string,
  callDate: string,
  model: string,
  report: CoachingReport,
): Promise<number> {
  const db = await Database.load(DB);
  const callRes = await db.execute(
    "INSERT INTO call (prospect, call_date, model, overall_score, grade_band) VALUES (?, ?, ?, ?, ?)",
    [prospect, callDate, model, report.overall_score, report.grade_band],
  );
  const callId = callRes.lastInsertId as number;
  await db.execute("INSERT INTO coaching_report (call_id, payload_json) VALUES (?, ?)", [
    callId,
    JSON.stringify(report),
  ]);
  return callId;
}

type DbStatus = "initializing" | "ready" | "error";

interface DeviceDesc {
  id: string;
  name: string;
  is_default: boolean;
}
interface DeviceList {
  render: DeviceDesc[];
  capture: DeviceDesc[];
}
interface SourceInfo {
  active: boolean;
  device: string | null;
  sample_rate: number | null;
  channels: number | null;
  error: string | null;
}
interface CaptureInfo {
  mic: SourceInfo;
  system: SourceInfo;
  warnings: string[];
}
interface SourceStatus {
  active: boolean;
  device: string | null;
  level: number;
  peak: number;
  samples: number;
  error: string | null;
}
interface CaptureStatus {
  recording: boolean;
  elapsed_secs: number;
  mic: SourceStatus;
  system: SourceStatus;
}
interface CaptureSummary {
  duration_secs: number;
  mic_samples: number;
  system_samples: number;
  mic_peak: number;
  system_peak: number;
  mixed_samples: number;
  mixed_rate: number;
  dev_wav_path: string | null;
}
interface StopResult {
  summary: CaptureSummary;
  transcript: string;
}

function fmtTime(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function App() {
  const [dbStatus, setDbStatus] = useState<DbStatus>("initializing");
  const [dbError, setDbError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem("ccc.theme") === "light" ? "light" : "dark",
  );

  const [devices, setDevices] = useState<DeviceList | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [renderId, setRenderId] = useState<string | undefined>(undefined);
  const [captureId, setCaptureId] = useState<string | undefined>(undefined);
  const [sessionReady, setSessionReady] = useState(false);

  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<CaptureInfo | null>(null);
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [summary, setSummary] = useState<CaptureSummary | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  // The merged, speaker-labeled transcript (live during the call, the final on
  // Stop, and the clean-pass result if re-transcribed).
  const [transcript, setTranscript] = useState<string>("");
  const [cleaning, setCleaning] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const [profile, setProfile] = useState<ContextProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const seededRef = useRef(false);

  // Coaching report (scored from the Coaching panel). The prospect name is no
  // longer collected in the UI — kept as "" so the prompt falls back to "unknown".
  const [prospect] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [report, setReport] = useState<CoachingReport | null>(null);
  // Bumped after a call is scored so the pet (bottom of Coaching) re-reads history.
  const [petRefresh, setPetRefresh] = useState(0);
  // MEDDPICC is scored separately, on demand (a cold call rarely has real signal).
  const [meddpicc, setMeddpicc] = useState<MeddpiccItem[] | null>(null);
  const [meddNote, setMeddNote] = useState<string | null>(null);
  const [meddLoading, setMeddLoading] = useState(false);
  const [meddError, setMeddError] = useState<string | null>(null);
  // On-demand transcript summary (Transcript panel).
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  // Quick dial logger: a non-connect (no answer / disconnected number) counts
  // toward call volume and feeds the pet, with nothing to score.
  const [logging, setLogging] = useState(false);
  const [logMsg, setLogMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await Database.load(DB);
        if (!cancelled) setDbStatus("ready");
      } catch (e) {
        if (!cancelled) {
          setDbStatus("error");
          setDbError(String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply the light/dark theme to the document + remember it.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("ccc.theme", theme);
  }, [theme]);

  // Seed + load the company-context profile once the DB (and its migrations) is ready.
  useEffect(() => {
    if (dbStatus !== "ready" || seededRef.current) return;
    seededRef.current = true;
    loadContext()
      .then(setProfile)
      .catch((e) => setProfileError(String(e)));
  }, [dbStatus]);

  // Load devices, then start the always-on monitor session so meters go live.
  // The last selection is persisted: a headphones user must not silently fall
  // back to speakers (silent loopback = silent prospect side). If the remembered
  // device is unplugged, fall back to the default — its dropdown shows that.
  useEffect(() => {
    (async () => {
      try {
        const list = await invoke<DeviceList>("list_audio_devices");
        setDevices(list);
        const pick = (opts: DeviceDesc[], savedKey: string) => {
          const saved = localStorage.getItem(savedKey);
          if (saved && opts.some((d) => d.id === saved)) return saved;
          return opts.find((d) => d.is_default)?.id ?? opts[0]?.id;
        };
        const rId = pick(list.render, "ccc.renderId");
        const cId = pick(list.capture, "ccc.captureId");
        setRenderId(rId);
        setCaptureId(cId);
        const i = await invoke<CaptureInfo>("start_session", { renderId: rId, captureId: cId });
        setInfo(i);
        setSessionReady(true);
      } catch (e) {
        setDeviceError(String(e));
      }
    })();
  }, []);

  // Poll live levels continuously (monitoring + recording).
  useEffect(() => {
    let active = true;
    const id = window.setInterval(async () => {
      try {
        const s = await invoke<CaptureStatus>("capture_status");
        if (active) setStatus(s);
      } catch {
        /* transient */
      }
    }, 200);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, []);

  // Live transcript events (merged, speaker-labeled) from the backend workers.
  useEffect(() => {
    const unlisten = listen<{ transcript: string; recording: boolean }>("transcript", (e) =>
      setTranscript(e.payload.transcript),
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Request OS notification permission up front (completion alerts).
  useEffect(() => {
    (async () => {
      try {
        if (!(await isPermissionGranted())) await requestPermission();
      } catch {
        /* best-effort */
      }
    })();
  }, []);

  // Keep the transcript scrolled to the latest text.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  const refreshDevices = async () => {
    setDeviceError(null);
    try {
      const list = await invoke<DeviceList>("list_audio_devices");
      setDevices(list);
    } catch (e) {
      setDeviceError(String(e));
    }
  };

  const onRenderChange = async (id: string) => {
    setRenderId(id);
    try {
      await invoke("set_render_device", { renderId: id });
      // Persist only after the rebind succeeds — don't remember a failed switch.
      localStorage.setItem("ccc.renderId", id);
    } catch (e) {
      setCaptureError(String(e));
    }
  };
  const onCaptureChange = async (id: string) => {
    setCaptureId(id);
    try {
      await invoke("set_capture_device", { captureId: id });
      localStorage.setItem("ccc.captureId", id);
    } catch (e) {
      setCaptureError(String(e));
    }
  };

  const startRec = async () => {
    setBusy(true);
    setCaptureError(null);
    setSummary(null);
    setTranscript("");
    setReport(null);
    setAnalyzeError(null);
    setMeddpicc(null);
    setMeddNote(null);
    setMeddError(null);
    setSummaryText(null);
    setSummaryError(null);
    // Optimistic: capture starts server-side immediately; the first-time model
    // load can take a couple seconds, so don't make the UI wait to feel live.
    setRecording(true);
    try {
      await invoke("begin_recording");
    } catch (e) {
      setCaptureError(String(e));
      setRecording(false);
    } finally {
      setBusy(false);
    }
  };

  const stopRec = async () => {
    setBusy(true);
    setRecording(false);
    try {
      // Live workers already transcribed per source; Stop just flushes the tail
      // and returns the merged labeled transcript (~instant).
      const res = await invoke<StopResult>("stop_recording");
      setSummary(res.summary);
      setTranscript(res.transcript);
    } catch (e) {
      setCaptureError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const cleanPass = async () => {
    setCleaning(true);
    setCaptureError(null);
    const aec = localStorage.getItem("ccc.aec") === "1";
    try {
      const t = await invoke<string>("clean_retranscribe", { aec });
      setTranscript(t);
      void notify("Cold Call Coach", aec ? "Clean, de-echoed transcript ready." : "Clean transcript ready.");
    } catch (e) {
      setCaptureError(String(e));
    } finally {
      setCleaning(false);
    }
  };

  // Shared LLM-call inputs. Non-secret config only — the key is read in Rust.
  const buildContext = () =>
    profile && {
      company: profile.company,
      rep_name: profile.rep_name,
      value_oneliner: profile.value_oneliner,
      ideal_opener: profile.ideal_opener,
      catalog: profile.catalog,
      personas: profile.personas,
      objections: profile.objections,
      extra_context: profile.extra_context,
    };
  const callMeta = () => ({
    model: localStorage.getItem("ccc.model") || "gpt-5.4-mini",
    effort: localStorage.getItem("ccc.effort") || "low",
    humanDate: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
  });

  // MEDDPICC — a separate, deliberate pass, scored from the MEDDPICC panel.
  const runMeddpicc = async () => {
    const ctx = buildContext();
    if (!ctx || !transcript.trim()) return;
    setMeddLoading(true);
    setMeddError(null);
    try {
      const { model, effort, humanDate } = callMeta();
      const res = await invoke<{ meddpicc: MeddpiccItem[]; note: string | null }>("score_meddpicc", {
        context: ctx,
        prospect: prospect.trim(),
        date: humanDate,
        model,
        effort,
      });
      setMeddpicc(res.meddpicc ?? []);
      setMeddNote(res.note ?? null);
    } catch (e) {
      setMeddError(String(e));
    } finally {
      setMeddLoading(false);
    }
  };

  // A quick factual recap of the transcript — the Transcript panel's Summarize button.
  const runSummary = async () => {
    const ctx = buildContext();
    if (!ctx || !transcript.trim()) return;
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const { model, effort, humanDate } = callMeta();
      const text = await invoke<string>("summarize_transcript", {
        context: ctx,
        prospect: prospect.trim(),
        date: humanDate,
        model,
        effort,
      });
      setSummaryText(text);
    } catch (e) {
      setSummaryError(String(e));
    } finally {
      setSummaryLoading(false);
    }
  };

  // Log a non-connect dial (no answer / disconnected number). Inserts a call row
  // with no score and no coaching report, so it counts toward volume + feeds the
  // pet (a null score is treated as a full dial) without a record→score pass.
  const logDial = async () => {
    setLogging(true);
    setLogMsg(null);
    try {
      const db = await Database.load(DB);
      await db.execute(
        "INSERT INTO call (prospect, call_date, model, overall_score, grade_band) VALUES (?, ?, ?, ?, ?)",
        ["No-answer / disconnect", localIsoDate(new Date()), "", null, "logged"],
      );
      setPetRefresh((r) => r + 1);
      setLogMsg("Dial logged ✓");
      window.setTimeout(() => setLogMsg(null), 1800);
    } catch (e) {
      setLogMsg(`Couldn't log: ${String(e)}`);
    } finally {
      setLogging(false);
    }
  };

  // The one structured Claude call. The transcript + key stay in Rust; only the
  // parsed report crosses back. On failure the transcript is retained in Rust
  // memory, so the user can fix the issue and click again — nothing lost.
  const runAnalyze = async () => {
    if (!profile) return;
    const who = prospect.trim();
    if (!transcript.trim()) {
      setAnalyzeError("No transcript yet — record and stop a call first.");
      return;
    }
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      // Non-secret config — the key is read in Rust, never sent from here.
      const context = {
        company: profile.company,
        rep_name: profile.rep_name,
        value_oneliner: profile.value_oneliner,
        ideal_opener: profile.ideal_opener,
        catalog: profile.catalog,
        personas: profile.personas,
        objections: profile.objections,
        extra_context: profile.extra_context,
      };
      const model = localStorage.getItem("ccc.model") || "gpt-5.4-mini";
      const effort = localStorage.getItem("ccc.effort") || "low";
      const now = new Date();
      const humanDate = now.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const isoDate = localIsoDate(now);

      const out = await invoke<CoachingReport>("analyze_call", {
        context,
        prospect: who,
        date: humanDate,
        model,
        effort,
      });
      setReport(out);

      // Analysis succeeded — persist (call + report payload, NOT the transcript).
      // If saving fails, keep the report on screen and say so.
      try {
        await persistReport(who || "Untitled call", isoDate, model, out);
      } catch (e) {
        setAnalyzeError(`Report ready but could not be saved to history: ${String(e)}`);
      }
      setPetRefresh((r) => r + 1); // feed the pet
      const scoreText = out.overall_score === null ? "no score (thin call)" : `${out.overall_score}/100`;
      void notify("Cold Call Coach", `Coaching ready for ${who || "your call"} — ${scoreText}`);
    } catch (e) {
      setAnalyzeError(String(e));
    } finally {
      setAnalyzing(false);
    }
  };

  // Read fresh each render (status polls every 200ms) so the label reflects the
  // Settings toggle without extra state plumbing.
  const aecOn = localStorage.getItem("ccc.aec") === "1";

  const elapsed = recording ? status?.elapsed_secs ?? 0 : summary?.duration_secs ?? null;
  const hint = recording
    ? "Recording — your mic + the prospect's audio into memory…"
    : summary
    ? "Captured. Review the transcript, then score the call."
    : sessionReady
    ? "Monitoring — meters are live. Press Record to capture a cold call."
    : "Starting audio session…";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">Cold Call Coach</span>
          <span className="brand-sub">local cold-call recorder + AI coaching</span>
        </div>
        <div className="status-cluster">
          <span
            className="badge badge-local"
            title="No cloud. The only outbound call is to the Claude API when you score a call."
          >
            100% local
          </span>
          <span className={`badge db-${dbStatus}`}>
            <span className="dot" />
            {dbStatus === "initializing" && "DB initializing…"}
            {dbStatus === "ready" && "DB ready"}
            {dbStatus === "error" && "DB error"}
          </span>
          <button
            className="icon-btn"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button
            className={`icon-btn ${historyOpen ? "is-active" : ""}`}
            title={
              profile ? "History — past calls and their scores" : "History (waiting for context to load)"
            }
            disabled={!profile}
            onClick={() => {
              setHistoryOpen((v) => !v);
              setSettingsOpen(false);
            }}
          >
            🕘
          </button>
          <button
            className={`icon-btn ${settingsOpen ? "is-active" : ""}`}
            title={profile ? "Bito context / settings" : "Settings (waiting for context to load)"}
            disabled={!profile}
            onClick={() => {
              setSettingsOpen((v) => !v);
              setHistoryOpen(false);
            }}
          >
            ⚙
          </button>
        </div>
      </header>

      {dbStatus === "error" && (
        <div className="error-banner">
          Database failed to initialize: <code>{dbError}</code>
        </div>
      )}
      {profileError && (
        <div className="error-banner">
          Context profile error: <code>{profileError}</code>
        </div>
      )}

      {settingsOpen && profile ? (
        <Settings profile={profile} onSaved={setProfile} onClose={() => setSettingsOpen(false)} />
      ) : historyOpen && profile ? (
        <History onClose={() => setHistoryOpen(false)} />
      ) : (
        <>
          <section className="sources">
            <SourceRow
              label="Prospect audio"
              hint="system loopback — wear headphones"
              options={devices?.render ?? []}
              selectedId={renderId}
              onChange={onRenderChange}
              status={status?.system}
              info={info?.system}
              disabled={busy}
            />
            <SourceRow
              label="Your mic"
              hint="your voice"
              options={devices?.capture ?? []}
              selectedId={captureId}
              onChange={onCaptureChange}
              status={status?.mic}
              info={info?.mic}
              disabled={busy}
            />
            <button className="ghost-btn refresh" onClick={refreshDevices} disabled={busy}>
              ↻ Devices
            </button>
          </section>
          {deviceError && (
            <div className="error-banner">
              Could not list devices: <code>{deviceError}</code>
            </div>
          )}

          <div className="headphone-note">
            🎧 Headphones keep the prospect's voice out of your mic, so “you” and “prospect” stay
            cleanly separated.{" "}
            {aecOn ? (
              <>
                Bleed-cancellation is <strong>on</strong> — after the call, run a{" "}
                <strong>Clean + de-echo</strong> pass before scoring.
              </>
            ) : (
              <>
                No headphones? Turn on <strong>bleed-cancellation</strong> in Settings, then run a
                Clean pass after the call.
              </>
            )}
          </div>

          <section className="record-bar">
            <button
              className={`record-btn ${recording ? "is-recording" : ""}`}
              onClick={recording ? stopRec : startRec}
              disabled={busy || !sessionReady || dbStatus === "error"}
            >
              <span className="record-icon" />
              {recording ? "Stop" : "Record"}
            </button>
            <div className="record-meta">
              <span className="timer">{elapsed === null ? "—:—" : fmtTime(elapsed)}</span>
              <span className="record-hint">{hint}</span>
            </div>
          </section>

          {captureError && (
            <div className="error-banner">
              Capture error: <code>{captureError}</code>
            </div>
          )}
          {info && info.warnings.length > 0 && (
            <div className="warn-banner">{info.warnings.join(" · ")}</div>
          )}
          {!recording && summary && <CaptureReport summary={summary} />}

          {analyzeError && (
            <div className="error-banner">
              {analyzeError}
              <div className="gen-retry-note">
                Your transcript is still held in memory — fix the issue and click again.
              </div>
            </div>
          )}

          <main className="panels-3">
            <Panel
              title="Coaching"
              subtitle="Scorecard + how to do better"
              footer={<Pet refreshKey={petRefresh} />}
              action={
                report ? (
                  <CopyButton text={reportToText(report, prospect)} label="Copy" />
                ) : undefined
              }
            >
              {report ? (
                <ReportView report={report} />
              ) : (
                <div className="coaching-cta">
                  <div className="cta-row">
                    <button
                      className="generate-btn"
                      onClick={runAnalyze}
                      disabled={analyzing || recording || !transcript.trim()}
                      title={
                        !transcript.trim()
                          ? "Record and stop a call first"
                          : "Score the call and get coaching"
                      }
                    >
                      {analyzing ? "Scoring…" : "Score this call"}
                    </button>
                    <button
                      className="ghost-btn log-dial-btn"
                      onClick={logDial}
                      disabled={logging || recording}
                      title="Log a non-connect (no answer / disconnected number) — counts toward your call volume, nothing to score"
                    >
                      {logging ? "Logging…" : "+ Log dial"}
                    </button>
                  </div>
                  {logMsg && <p className="log-msg">{logMsg}</p>}
                  <Empty>
                    Record a call, stop, then hit <strong>Score this call</strong> — you'll get a scored
                    breakdown (opener, value pitch vs. what Bito does, objection handling, next step) plus
                    the single highest-leverage fix. Or <strong>+ Log dial</strong> a no-answer/disconnect
                    so it still counts toward your volume (and feeds the pet) with nothing to score.
                  </Empty>
                </div>
              )}
            </Panel>

            <Panel
              title="MEDDPICC"
              subtitle={meddpicc ? "Qualification snapshot" : "What to gather on the call"}
              action={
                !recording && transcript.trim() ? (
                  <button
                    className="ghost-btn"
                    onClick={runMeddpicc}
                    disabled={meddLoading}
                    title="Score this call against MEDDPICC"
                  >
                    {meddLoading ? "Scoring…" : meddpicc ? "↻ Re-score" : "Score MEDDPICC"}
                  </button>
                ) : undefined
              }
            >
              {meddError && <div className="error-banner">{meddError}</div>}
              {meddpicc && meddpicc.length > 0 ? (
                <>
                  {meddNote && <p className="meddpicc-readout">{meddNote}</p>}
                  <MeddpiccList items={meddpicc} />
                </>
              ) : (
                <MeddpiccReminder />
              )}
            </Panel>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>{recording ? "Live transcript" : "Transcript"}</h2>
                  <p className="panel-sub">speaker-labeled · in memory</p>
                </div>
                {!recording && transcript && (
                  <div className="panel-actions">
                    <button
                      className="ghost-btn"
                      onClick={runSummary}
                      disabled={summaryLoading}
                      title="Summarize this call"
                    >
                      {summaryLoading ? "Summarizing…" : "Summarize"}
                    </button>
                    <CopyButton text={transcript} label="Copy" />
                    <button
                      className="ghost-btn clean-btn"
                      onClick={cleanPass}
                      disabled={cleaning}
                      title={
                        aecOn
                          ? "Full per-source re-transcribe + cancel the prospect's bleed out of your mic"
                          : "Full per-source re-transcribe for max quality"
                      }
                    >
                      {cleaning ? "Re-transcribing…" : aecOn ? "↻ De-echo" : "↻ Clean"}
                    </button>
                  </div>
                )}
              </div>
              <div className="panel-body transcript-body" ref={transcriptRef}>
                {summaryError && <div className="error-banner">{summaryError}</div>}
                {summaryText && (
                  <div className="transcript-summary">
                    <div className="ts-head">
                      <span className="ts-badge">Summary</span>
                      <CopyButton text={summaryText} label="Copy" />
                    </div>
                    <div className="ts-body">{summaryText}</div>
                  </div>
                )}
                {transcript ? (
                  <LabeledTranscript text={transcript} />
                ) : recording ? (
                  <span className="t-empty">Listening…</span>
                ) : (
                  <Empty>Record a call to see the live, speaker-labeled transcript here.</Empty>
                )}
              </div>
            </section>
          </main>
        </>
      )}
    </div>
  );
}

function SourceRow({
  label,
  hint,
  options,
  selectedId,
  onChange,
  status,
  info,
  disabled,
}: {
  label: string;
  hint: string;
  options: DeviceDesc[];
  selectedId: string | undefined;
  onChange: (id: string) => void;
  status: SourceStatus | undefined;
  info: SourceInfo | undefined;
  disabled: boolean;
}) {
  const level = status?.level ?? 0;
  const pct = Math.min(100, Math.round(level * 140));
  const bound = status?.device ?? info?.device ?? null;
  const err = status?.error ?? info?.error ?? null;
  const peak = status?.peak;

  return (
    <div className="source-row">
      <div className="source-head">
        <span className="source-label">{label}</span>
        <span className="source-hint">{hint}</span>
      </div>
      <select
        className="device-select"
        value={selectedId ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || options.length === 0}
      >
        {options.length === 0 && <option value="">No devices found</option>}
        {options.map((d, i) => (
          <option key={`${d.id}-${i}`} value={d.id}>
            {d.name}
            {d.is_default ? "  (default)" : ""}
          </option>
        ))}
      </select>
      <div className="source-meter">
        <div className="meter-bar">
          <div className="meter-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="source-diag">
          {err ? (
            <span className="diag-err" title={err}>
              error: {err}
            </span>
          ) : (
            <>
              <span className="diag-bound">{bound ? `bound: ${bound}` : "—"}</span>
              {peak !== undefined && <span className="diag-peak">peak {peak.toFixed(3)}</span>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function LabeledTranscript({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return (
    <div className="labeled">
      {lines.map((line, i) => {
        const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
        if (!m) {
          return (
            <p key={i} className="t-line">
              {line}
            </p>
          );
        }
        const label = m[1];
        const who = label.toLowerCase() === "prospect" ? "prospect" : "you";
        return (
          <p key={i} className={`t-line t-${who}`}>
            <span className="t-label">{label}</span>
            {m[2]}
          </p>
        );
      })}
    </div>
  );
}

function CaptureReport({ summary }: { summary: CaptureSummary }) {
  const mixedSecs = summary.mixed_samples / summary.mixed_rate;
  return (
    <div className="capture-report">
      <span className="cr-strong">Captured {summary.duration_secs.toFixed(1)}s</span>
      <span>
        prospect {summary.system_samples.toLocaleString()} smp (peak{" "}
        {summary.system_peak.toFixed(3)})
      </span>
      <span>
        you {summary.mic_samples.toLocaleString()} smp (peak {summary.mic_peak.toFixed(3)})
      </span>
      <span>→ {mixedSecs.toFixed(1)}s of 16 kHz mono held in memory for transcription</span>
      {summary.dev_wav_path && (
        <span className="cr-dev" title={summary.dev_wav_path}>
          dev WAV: {summary.dev_wav_path}
        </span>
      )}
    </div>
  );
}
