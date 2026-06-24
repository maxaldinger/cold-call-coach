// History: list past coached calls from SQLite, reopen a stored coaching report
// read-only, delete with confirm. Transcripts don't exist in the DB — search
// covers the prospect name and the stored report text only, and the UI says so.

import { useEffect, useRef, useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import { ask } from "@tauri-apps/plugin-dialog";
import { CoachingReport, CopyButton, Empty, Panel, ReportView, reportToText } from "./outputs";

const DB = "sqlite:coldcallcoach.db";

interface CallRow {
  id: number;
  prospect: string;
  call_date: string;
  model: string;
  overall_score: number | null;
  grade_band: string;
  created_at: string;
}

const BAND_LABEL: Record<string, string> = {
  strong: "Strong",
  solid: "Solid",
  developing: "Developing",
  needs_work: "Needs work",
  insufficient_signal: "No signal",
};

// "YYYY-MM-DD" → "June 11, 2026" without UTC parsing pitfalls (new Date on a
// bare date string parses as UTC midnight and shifts a day in negative offsets).
function humanDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export function History({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [calls, setCalls] = useState<CallRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailCall, setDetailCall] = useState<CallRow | null>(null);
  const [detailReport, setDetailReport] = useState<CoachingReport | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Race guard: rapid clicks run loaders concurrently and SQLite answers out of
  // order — only the LATEST click may own the detail pane.
  const openSeq = useRef(0);

  // Load / search the call list. LIKE wildcards in the query are escaped so a
  // literal "100%" search behaves as a substring, not a pattern.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await Database.load(DB);
        const q = query.trim();
        let rows: CallRow[];
        if (q) {
          const pat = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
          rows = await db.select<CallRow[]>(
            `SELECT c.id, c.prospect, c.call_date, c.model, c.overall_score, c.grade_band, c.created_at
             FROM call c
             WHERE c.prospect LIKE $1 ESCAPE '\\'
                OR EXISTS (SELECT 1 FROM coaching_report r
                           WHERE r.call_id = c.id AND r.payload_json LIKE $1 ESCAPE '\\')
             ORDER BY c.created_at DESC, c.id DESC`,
            [pat],
          );
        } else {
          rows = await db.select<CallRow[]>(
            `SELECT id, prospect, call_date, model, overall_score, grade_band, created_at
             FROM call ORDER BY created_at DESC, id DESC`,
          );
        }
        if (!cancelled) {
          setCalls(rows);
          setListError(null);
        }
      } catch (e) {
        if (!cancelled) setListError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query]);

  const openCall = async (call: CallRow) => {
    const seq = ++openSeq.current;
    setLoadingDetail(true);
    setDetailError(null);
    setDetailCall(call);
    setDetailReport(null);
    try {
      const db = await Database.load(DB);
      const rows = await db.select<{ payload_json: string }[]>(
        "SELECT payload_json FROM coaching_report WHERE call_id = $1 ORDER BY id DESC LIMIT 1",
        [call.id],
      );
      if (seq !== openSeq.current) return; // a newer click owns the pane
      if (rows.length === 0) {
        setDetailError("No coaching report was stored for this call.");
        return;
      }
      let report: CoachingReport;
      try {
        report = JSON.parse(rows[0].payload_json) as CoachingReport;
      } catch {
        setDetailError("The stored report is corrupt and could not be read.");
        return;
      }
      setDetailReport(report);
    } catch (e) {
      if (seq !== openSeq.current) return;
      setDetailError(String(e));
      setDetailCall(null);
    } finally {
      if (seq === openSeq.current) setLoadingDetail(false);
    }
  };

  // Delete with native confirm. Each statement is idempotent — a failure mid-way
  // surfaces and a retry finishes the job. (coaching_report also has ON DELETE
  // CASCADE, but it's deleted explicitly so the result doesn't depend on the
  // connection's foreign_keys pragma.)
  const deleteCall = async (call: CallRow) => {
    setDetailError(null);
    let yes = false;
    try {
      yes = await ask(
        `Delete the ${call.prospect} call from ${humanDate(call.call_date)}?\n\nThis permanently removes its coaching report.`,
        { title: "Delete call", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" },
      );
    } catch (e) {
      setDetailError(`Could not show the confirm dialog: ${String(e)}`);
      return;
    }
    if (!yes) return;
    setDeleting(true);
    try {
      const db = await Database.load(DB);
      await db.execute("DELETE FROM coaching_report WHERE call_id = $1", [call.id]);
      await db.execute("DELETE FROM call WHERE id = $1", [call.id]);
      openSeq.current++; // invalidate any in-flight openCall for this pane
      setDetailCall(null);
      setDetailReport(null);
      setCalls((prev) => (prev ? prev.filter((c) => c.id !== call.id) : prev));
    } catch (e) {
      setDetailError(
        `Delete failed: ${String(e)} — some parts may already be removed; delete again to finish.`,
      );
    } finally {
      setDeleting(false);
    }
  };

  const q = query.trim();

  return (
    <div className="history">
      <div className="history-head">
        <div>
          <h2>History</h2>
          <p className="history-sub">
            Every scored call. Search covers the prospect name and the report text — transcripts are
            never stored, so there's nothing of them to search.
          </p>
        </div>
        <div className="history-actions">
          <input
            className="s-input history-search"
            placeholder="Search prospect or report…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="ghost-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {listError && (
        <div className="error-banner">
          Could not load history: <code>{listError}</code>
        </div>
      )}

      <div className="history-body">
        <aside className="history-list">
          {listError ? (
            <div className="history-empty">
              <span className="he-title">Couldn't load history</span>
              The list below may be stale. Details are in the banner above — edit the search to retry.
            </div>
          ) : calls === null ? (
            <div className="history-empty">Loading…</div>
          ) : calls.length === 0 && !q ? (
            <div className="history-empty">
              <span className="he-title">No calls yet</span>
              Record a cold call and hit Score — every coaching report lands here, reopenable.
            </div>
          ) : calls.length === 0 ? (
            <div className="history-empty">
              <span className="he-title">No matches for “{q}”</span>
              Try a prospect name or a phrase from a report.
            </div>
          ) : (
            <ul className="call-list">
              {calls.map((c) => (
                <li key={c.id}>
                  <button
                    className={`call-item ${detailCall?.id === c.id ? "is-selected" : ""}`}
                    onClick={() => openCall(c)}
                    disabled={deleting}
                  >
                    <span className={`call-score band-${c.grade_band}`}>
                      {c.overall_score === null ? "—" : c.overall_score}
                    </span>
                    <span className="call-main">
                      <span className="call-customer">{c.prospect}</span>
                      <span className="call-meta">
                        {c.call_date}
                        <span className="call-model">{BAND_LABEL[c.grade_band] || c.model || "—"}</span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="history-detail">
          {detailError && (
            <div className="error-banner">
              <code>{detailError}</code>
            </div>
          )}
          {!detailCall && !loadingDetail && !detailError && (
            <div className="history-empty detail-placeholder">
              <span className="he-title">Nothing open</span>
              Select a call on the left to reopen its coaching report — read-only, with Copy still live.
            </div>
          )}
          {loadingDetail && <div className="history-empty">Loading call…</div>}
          {detailCall && detailReport && (
            <>
              <div className="detail-head">
                <div>
                  <h3>{detailCall.prospect}</h3>
                  <p className="detail-meta">
                    {humanDate(detailCall.call_date)} · model: {detailCall.model || "— (not recorded)"}
                  </p>
                </div>
                <div className="panel-actions">
                  <CopyButton
                    text={reportToText(detailReport, detailCall.prospect)}
                    label="Copy report"
                  />
                  <button
                    className="ghost-btn danger-btn"
                    onClick={() => deleteCall(detailCall)}
                    disabled={deleting}
                  >
                    {deleting ? "Deleting…" : "Delete call"}
                  </button>
                </div>
              </div>

              <Panel title="Coaching" subtitle="Read-only">
                <ReportView report={detailReport} />
              </Panel>
            </>
          )}
          {detailCall && !detailReport && !loadingDetail && !detailError && (
            <Empty>No report to show.</Empty>
          )}
        </div>
      </div>
    </div>
  );
}
