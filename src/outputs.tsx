// Shared report types + presentational components for the cold-call coaching
// report. Used by the live view (App.tsx) and History (History.tsx) so a
// reopened call renders exactly like a fresh analysis.
//
// Types mirror the Rust coaching::CoachingReport. Optionals are `| null` because
// the model omits them on thin calls and serde renders Option::None as null.

import { useState } from "react";

// ---- Types (mirror Rust coaching::CoachingReport) ---------------------------

export interface EvidenceItem {
  idx: number;
  speaker: "You" | "Prospect";
  quote: string;
  tag: string | null;
}

export interface TalkMetrics {
  estimated_rep_talk_pct: number | null;
  longest_rep_monologue_desc: string | null;
  prospect_engaged: boolean;
}

export type DimensionStatus = "scored" | "not_applicable" | "insufficient_evidence";
export type Confidence = "high" | "medium" | "low";

export interface Dimension {
  key: string;
  label: string;
  score: number | null; // 0-10
  status: DimensionStatus;
  confidence: Confidence;
  weight: number;
  what_happened: string;
  evidence_idx: number[];
  what_to_do_better: string | null;
  suggested_rephrasing: string | null;
}

export type ClaimVerdict =
  | "accurate"
  | "overclaimed"
  | "wrong_metric"
  | "not_a_bito_capability"
  | "unverifiable";

export interface ClaimAudit {
  claim_quote: string;
  evidence_idx: number[];
  verdict: ClaimVerdict;
  matched_fact: string | null;
  correction: string | null;
}

export interface MeddpiccItem {
  letter: string;
  status: string; // covered | weak | missing
  note: string;
}

export interface WentWell {
  point: string;
  evidence_idx: number[];
}

export interface HighestLeverageFix {
  title: string;
  dimension_key: string;
  what_happened: string;
  why_it_matters: string;
  do_this_instead: string;
  evidence_idx: number[];
}

export interface PrioritizedFix {
  issue: string;
  do_this_instead: string;
  dimension_key: string;
}

export interface MissedOpportunity {
  signal: string;
  what_to_do: string;
  evidence_idx: number[];
}

export type CallClassification =
  | "real_conversation"
  | "voicemail"
  | "gatekeeper_only"
  | "immediate_decline"
  | "too_short"
  | "non_call_audio";

export type GradeBand =
  | "strong"
  | "solid"
  | "developing"
  | "needs_work"
  | "insufficient_signal";

export interface CoachingReport {
  call_classification: CallClassification;
  analyzable: boolean;
  confidence: Confidence;
  headline: string;
  overall_score: number | null; // 0-100
  grade_band: GradeBand;
  score_basis: string[];
  evidence: EvidenceItem[];
  talk_metrics: TalkMetrics;
  dimensions: Dimension[];
  claim_audit: ClaimAudit[];
  meddpicc: MeddpiccItem[];
  what_went_well: WentWell[];
  highest_leverage_fix: HighestLeverageFix | null;
  prioritized_fixes: PrioritizedFix[];
  missed_opportunities: MissedOpportunity[];
  drill: string | null;
  coaching_summary: string;
  caveats: string | null;
}

// ---- Label/format helpers ---------------------------------------------------

const BAND_LABEL: Record<GradeBand, string> = {
  strong: "Strong",
  solid: "Solid",
  developing: "Developing",
  needs_work: "Needs work",
  insufficient_signal: "Not enough signal",
};

const CLASSIFICATION_LABEL: Record<CallClassification, string> = {
  real_conversation: "Real conversation",
  voicemail: "Voicemail",
  gatekeeper_only: "Gatekeeper only",
  immediate_decline: "Immediate decline",
  too_short: "Too short",
  non_call_audio: "Not a call",
};

const VERDICT_LABEL: Record<ClaimVerdict, string> = {
  accurate: "Accurate",
  overclaimed: "Overclaimed",
  wrong_metric: "Wrong metric",
  not_a_bito_capability: "Not a Bito capability",
  unverifiable: "Unverifiable",
};

const STATUS_LABEL: Record<DimensionStatus, string> = {
  scored: "scored",
  not_applicable: "N/A",
  insufficient_evidence: "no signal",
};

// Local-timezone ISO date (YYYY-MM-DD). toISOString() is UTC and would date an
// evening call one day ahead of what the user sees.
export function localIsoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---- Generic presentational components --------------------------------------

export function Panel({
  title,
  subtitle,
  action,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="panel-sub">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="panel-body">{children}</div>
      {footer}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — best-effort */
    }
  };
  return (
    <button className="ghost-btn" onClick={copy}>
      {copied ? "Copied ✓" : label ?? "Copy"}
    </button>
  );
}

// ---- Report rendering -------------------------------------------------------

/** Quote chips for a list of evidence indices, resolved against the report's
 *  evidence spine. Unknown indices are skipped (never fabricated). */
function EvidenceQuotes({
  idx,
  byIdx,
}: {
  idx: number[];
  byIdx: Map<number, EvidenceItem>;
}) {
  const items = idx.map((i) => byIdx.get(i)).filter((e): e is EvidenceItem => !!e);
  if (items.length === 0) return null;
  return (
    <ul className="evidence">
      {items.map((e) => (
        <li key={e.idx} className={`ev ev-${e.speaker.toLowerCase()}`}>
          <span className="ev-who">{e.speaker}</span>
          <span className="ev-quote">“{e.quote}”</span>
        </li>
      ))}
    </ul>
  );
}

function ScoreHeader({ report }: { report: CoachingReport }) {
  const band = report.grade_band;
  const scoreText = report.overall_score === null ? "—" : String(report.overall_score);
  return (
    <div className={`score-header band-${band}`}>
      <div className="score-ring">
        <span className="score-num">{scoreText}</span>
        {report.overall_score !== null && <span className="score-den">/100</span>}
      </div>
      <div className="score-meta">
        <div className="score-badges">
          <span className={`grade-chip band-${band}`}>{BAND_LABEL[band] ?? band}</span>
          <span className="class-chip">
            {CLASSIFICATION_LABEL[report.call_classification] ?? report.call_classification}
          </span>
          {report.confidence && (
            <span className={`conf-chip conf-${report.confidence}`}>
              {report.confidence} confidence
            </span>
          )}
        </div>
        {report.headline && <p className="score-headline">{report.headline}</p>}
      </div>
    </div>
  );
}

function DimensionRow({
  dim,
  byIdx,
}: {
  dim: Dimension;
  byIdx: Map<number, EvidenceItem>;
}) {
  const scored = dim.status === "scored" && dim.score !== null;
  const tier =
    !scored ? "na" : dim.score! >= 8 ? "good" : dim.score! >= 4 ? "mid" : "poor";
  return (
    <li className={`dim dim-${tier}`}>
      <div className="dim-head">
        <span className="dim-score">
          {scored ? (
            <>
              {dim.score}
              <span className="dim-den">/10</span>
            </>
          ) : (
            <span className="dim-na">{STATUS_LABEL[dim.status]}</span>
          )}
        </span>
        <div className="dim-titles">
          <span className="dim-label">{dim.label}</span>
          <span className="dim-sub">
            weight {dim.weight}
            {scored && dim.confidence ? ` · ${dim.confidence} confidence` : ""}
          </span>
        </div>
      </div>
      {dim.what_happened && <p className="dim-what">{dim.what_happened}</p>}
      <EvidenceQuotes idx={dim.evidence_idx} byIdx={byIdx} />
      {dim.what_to_do_better && (
        <p className="dim-better">
          <span className="dim-tag">Do better</span>
          {dim.what_to_do_better}
        </p>
      )}
      {dim.suggested_rephrasing && (
        <p className="dim-rephrase">
          <span className="dim-tag tag-say">Try saying</span>“{dim.suggested_rephrasing}”
        </p>
      )}
    </li>
  );
}

function ClaimAuditView({
  rows,
  byIdx,
}: {
  rows: ClaimAudit[];
  byIdx: Map<number, EvidenceItem>;
}) {
  return (
    <ul className="claims">
      {rows.map((c, i) => (
        <li key={i} className={`claim verdict-${c.verdict}`}>
          <div className="claim-head">
            <span className={`verdict-chip verdict-${c.verdict}`}>
              {VERDICT_LABEL[c.verdict] ?? c.verdict}
            </span>
            <span className="claim-quote">“{c.claim_quote}”</span>
          </div>
          {c.matched_fact && (
            <p className="claim-fact">
              <span className="claim-tag">Maps to</span>
              {c.matched_fact}
            </p>
          )}
          {c.correction && (
            <p className="claim-correction">
              <span className="claim-tag tag-fix">Correct fact</span>
              {c.correction}
            </p>
          )}
          <EvidenceQuotes idx={c.evidence_idx} byIdx={byIdx} />
        </li>
      ))}
    </ul>
  );
}

const MEDDPICC_LABELS = [
  "Metrics",
  "Economic buyer",
  "Decision criteria",
  "Decision process",
  "Paper process",
  "Identify pain",
  "Champion",
  "Competition",
];

export function MeddpiccList({ items }: { items: MeddpiccItem[] }) {
  return (
    <ul className="meddpicc-list">
      {items.map((m, i) => {
        const st = (m.status || "missing").toLowerCase();
        return (
          <li key={i} className={`meddpicc-item status-${st}`}>
            <span className="meddpicc-letter">{m.letter}</span>
            <div className="meddpicc-main">
              <div className="meddpicc-toprow">
                <span className="meddpicc-label">{MEDDPICC_LABELS[i] ?? ""}</span>
                <span className={`meddpicc-status status-${st}`}>{m.status}</span>
              </div>
              {m.note && <p className="meddpicc-note">{m.note}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// In-call reminder: what to GATHER for each MEDDPICC letter + what to capture to
// build a POC. Grounded in the Bito "new customer intel" project's MEDDPICC + POC
// plan (codebase scale, the AI-tool spend baseline, a real "wrong-output moment").
const MEDDPICC_PROMPTS: { letter: string; name: string; ask: string }[] = [
  { letter: "M", name: "Metrics", ask: "A number to cut in half — time-to-merge, review hours/week, or current AI-tool token spend." },
  { letter: "E", name: "Economic Buyer", ask: "Who signs dev-tool spend over ~$50k? (Usually VP Eng / CTO.)" },
  { letter: "D", name: "Decision Criteria", ask: "What must it clear — must-haves, security (SOC 2 / self-host), grounded-context quality." },
  { letter: "D", name: "Decision Process", ask: "Steps + timeline to a yes. Is a POC/pilot required? Who else evaluates?" },
  { letter: "P", name: "Paper Process", ask: "Procurement, legal, security review — what adds time after a good trial." },
  { letter: "I", name: "Implicate the Pain", ask: "The pain AND its cost — context-blind AI code, rework, cross-repo switching." },
  { letter: "C", name: "Champion", ask: "Who'll sell internally? Head of Platform / DevEx; staff/principal engineers feel it most." },
  { letter: "C", name: "Competition", ask: "Which AI tools today (Copilot/Cursor/Claude Code)? Bito grounds them — doesn't replace." },
];

const POC_CAPTURE: { label: string; q: string; flag?: boolean }[] = [
  { label: "Who's in the room", q: "Champion, who signs the PO, who can veto on security." },
  { label: "Codebase scale", q: "How many repos, and total lines of code (ballpark)? — lands hardest." },
  { label: "Team in scope", q: "How many engineers would actually be in the trial?" },
  { label: "Stack & agents", q: "Dominant languages, and which AI coding tools today?" },
  { label: "Planning tools", q: "Where do designs/tickets live — Jira, Linear, Confluence, Slack?" },
  { label: "Slowest path", q: "Walk me through your slowest path from spec to merged PR." },
  { label: "A “moment”", q: "When has an AI agent confidently shipped something just plain wrong?" },
  { label: "A number to beat", q: "A recent estimate you'd love to cut in half." },
  { label: "Economic baseline", q: "Current AI-tool spend (seats × annual) — so token savings convert to $.", flag: true },
];

/** Pre-call / pre-score reminder shown in the MEDDPICC panel — a cheat-sheet of
 *  what to gather on the call. Replaced by the scorecard once a call is scored. */
export function MeddpiccReminder() {
  return (
    <div className="reminder">
      <div className="reminder-block">
        <h3 className="reminder-title">On the call · fill MEDDPICC</h3>
        <ul className="reminder-list">
          {MEDDPICC_PROMPTS.map((m, i) => (
            <li key={i} className="reminder-row">
              <span className="reminder-letter">{m.letter}</span>
              <div className="reminder-main">
                <span className="reminder-name">{m.name}</span>
                <p className="reminder-ask">{m.ask}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="reminder-block">
        <h3 className="reminder-title">Capture to build a POC</h3>
        <ul className="reminder-list">
          {POC_CAPTURE.map((p, i) => (
            <li key={i} className={`reminder-row ${p.flag ? "is-flagged" : ""}`}>
              <span className="reminder-bullet">{p.flag ? "⚑" : "›"}</span>
              <div className="reminder-main">
                <span className="reminder-name">{p.label}</span>
                <p className="reminder-ask">{p.q}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="reminder-foot">
          Score the call to turn your notes into the MEDDPICC scorecard.
        </p>
      </div>
    </div>
  );
}

/** The full coaching report. Confidence-first: a null score / thin call leads
 *  with caveats and shows "—" for the number rather than a fabricated score. */
export function ReportView({ report }: { report: CoachingReport }) {
  const byIdx = new Map(report.evidence.map((e) => [e.idx, e]));
  const thin = report.overall_score === null || !report.analyzable;
  const hlf = report.highest_leverage_fix;

  return (
    <div className="report">
      <ScoreHeader report={report} />

      {report.caveats && (
        <div className={`report-caveats ${thin ? "is-thin" : ""}`}>
          <span className="caveat-badge">Heads up</span>
          {report.caveats}
        </div>
      )}

      {report.coaching_summary && <p className="coaching-summary">{report.coaching_summary}</p>}

      {hlf && (
        <div className="hlf">
          <div className="hlf-head">
            <span className="hlf-badge">Highest-leverage fix</span>
            <span className="hlf-title">{hlf.title}</span>
          </div>
          {hlf.what_happened && (
            <p className="hlf-what">
              <span className="dim-tag">What happened</span>“{hlf.what_happened}”
            </p>
          )}
          {hlf.why_it_matters && <p className="hlf-why">{hlf.why_it_matters}</p>}
          {hlf.do_this_instead && (
            <p className="dim-rephrase">
              <span className="dim-tag tag-say">Do this instead</span>“{hlf.do_this_instead}”
            </p>
          )}
          <EvidenceQuotes idx={hlf.evidence_idx} byIdx={byIdx} />
        </div>
      )}

      {report.what_went_well.length > 0 && (
        <div className="report-block">
          <h3 className="block-title">What went well</h3>
          <ul className="wins">
            {report.what_went_well.map((w, i) => (
              <li key={i} className="win">
                <p className="win-point">{w.point}</p>
                <EvidenceQuotes idx={w.evidence_idx} byIdx={byIdx} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.dimensions.length > 0 && (
        <div className="report-block">
          <h3 className="block-title">Scorecard</h3>
          <ul className="dims">
            {report.dimensions.map((d) => (
              <DimensionRow key={d.key} dim={d} byIdx={byIdx} />
            ))}
          </ul>
        </div>
      )}

      {report.claim_audit.length > 0 && (
        <div className="report-block">
          <h3 className="block-title">
            Bito claim audit
            <span className="block-sub">Every product claim, checked against what Bito actually does</span>
          </h3>
          <ClaimAuditView rows={report.claim_audit} byIdx={byIdx} />
        </div>
      )}

      {report.missed_opportunities.length > 0 && (
        <div className="report-block">
          <h3 className="block-title">Missed openings</h3>
          <ul className="missed">
            {report.missed_opportunities.map((m, i) => (
              <li key={i} className="miss">
                <p className="miss-signal">{m.signal}</p>
                {m.what_to_do && <p className="miss-do">{m.what_to_do}</p>}
                <EvidenceQuotes idx={m.evidence_idx} byIdx={byIdx} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.prioritized_fixes.length > 0 && (
        <div className="report-block">
          <h3 className="block-title">Next-call fixes</h3>
          <ol className="fixes">
            {report.prioritized_fixes.map((f, i) => (
              <li key={i} className="fix">
                <p className="fix-issue">{f.issue}</p>
                {f.do_this_instead && (
                  <p className="dim-rephrase">
                    <span className="dim-tag tag-say">Do this</span>
                    {f.do_this_instead}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {report.drill && (
        <div className="drill">
          <span className="drill-badge">Drill</span>
          {report.drill}
        </div>
      )}

      <TalkMetricsView m={report.talk_metrics} />
    </div>
  );
}

function TalkMetricsView({ m }: { m: TalkMetrics }) {
  // prospect_engaged is a non-optional bool (always present), so gate on the two
  // nullable signals — otherwise the strip would render on voicemails with only
  // "Prospect engaged: no".
  const hasAny = m.estimated_rep_talk_pct !== null || m.longest_rep_monologue_desc !== null;
  if (!hasAny) return null;
  return (
    <div className="talk-metrics">
      {m.estimated_rep_talk_pct !== null && (
        <span className="tm">
          You talked ~<strong>{m.estimated_rep_talk_pct}%</strong> of the call
        </span>
      )}
      <span className="tm">
        Prospect engaged: <strong>{m.prospect_engaged ? "yes" : "no"}</strong>
      </span>
      {m.longest_rep_monologue_desc && (
        <span className="tm">Longest stretch: {m.longest_rep_monologue_desc}</span>
      )}
    </div>
  );
}

/** A plain-text rendering of a report, for the Copy button. */
export function reportToText(report: CoachingReport, prospect: string): string {
  const L: string[] = [];
  L.push(`Cold call coaching — ${prospect}`);
  L.push(
    `Score: ${report.overall_score === null ? "—" : report.overall_score + "/100"} (${
      BAND_LABEL[report.grade_band] ?? report.grade_band
    }) · ${CLASSIFICATION_LABEL[report.call_classification] ?? report.call_classification}`,
  );
  if (report.headline) L.push(report.headline);
  if (report.coaching_summary) L.push("", report.coaching_summary);
  if (report.highest_leverage_fix) {
    const h = report.highest_leverage_fix;
    L.push("", `HIGHEST-LEVERAGE FIX: ${h.title}`);
    if (h.why_it_matters) L.push(h.why_it_matters);
    if (h.do_this_instead) L.push(`Do this instead: ${h.do_this_instead}`);
  }
  if (report.dimensions.length) {
    L.push("", "SCORECARD");
    for (const d of report.dimensions) {
      const s = d.status === "scored" && d.score !== null ? `${d.score}/10` : STATUS_LABEL[d.status];
      L.push(`- ${d.label}: ${s}${d.what_to_do_better ? ` — ${d.what_to_do_better}` : ""}`);
    }
  }
  const meddLines = (report.meddpicc ?? [])
    .map((m, i) => ({ m, label: MEDDPICC_LABELS[i] ?? m.letter }))
    .filter((x) => (x.m.status || "").toLowerCase() !== "missing");
  if (meddLines.length) {
    L.push("", "MEDDPICC (what surfaced)");
    meddLines.forEach((x) => L.push(`- ${x.label} (${x.m.status}): ${x.m.note}`));
  }
  if (report.prioritized_fixes.length) {
    L.push("", "NEXT-CALL FIXES");
    report.prioritized_fixes.forEach((f, i) =>
      L.push(`${i + 1}. ${f.issue}${f.do_this_instead ? ` → ${f.do_this_instead}` : ""}`),
    );
  }
  if (report.caveats) L.push("", `Note: ${report.caveats}`);
  return L.join("\n");
}
