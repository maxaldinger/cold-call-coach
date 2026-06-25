// Scoreboard: dial volume + call quality over the month and year, computed live
// from the `call` table. A dial = one row (scored calls, voicemails, AND logged
// disconnects all count toward volume); the average score is over scored calls
// only. Nothing new is stored — it's all derived from the history already on disk.

import { useEffect, useMemo, useState } from "react";
import Database from "@tauri-apps/plugin-sql";

const DB = "sqlite:coldcallcoach.db";

interface Row {
  call_date: string; // local "YYYY-MM-DD", set at capture
  overall_score: number | null;
}

interface Parsed {
  y: number;
  m: number; // 0-11
  d: number;
  score: number | null;
}

// A "thriving" day target — mirrors the pet's top rung (~41 dials by close).
const DAY_TARGET = 41;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseRows(rows: Row[]): Parsed[] {
  const out: Parsed[] = [];
  for (const r of rows) {
    const mt = r.call_date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!mt) continue;
    out.push({ y: +mt[1], m: +mt[2] - 1, d: +mt[3], score: r.overall_score });
  }
  return out;
}

function avgScore(scores: (number | null)[]): number | null {
  const s = scores.filter((x): x is number => x !== null);
  return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null;
}

export function Scoreboard({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const now = useMemo(() => new Date(), []);
  const [year, setYear] = useState(now.getFullYear());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await Database.load(DB);
        const r = await db.select<Row[]>("SELECT call_date, overall_score FROM call");
        if (!cancelled) {
          setRows(r);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const data = useMemo(() => (rows ? parseRows(rows) : []), [rows]);

  const curY = now.getFullYear();
  const curM = now.getMonth();
  const today = now.getDate();
  const daysInMonth = new Date(curY, curM + 1, 0).getDate();

  // This calendar month.
  const monthRows = data.filter((r) => r.y === curY && r.m === curM);
  const monthDials = monthRows.length;
  const monthScored = monthRows.filter((r) => r.score !== null).length;
  const monthAvg = avgScore(monthRows.map((r) => r.score));
  // Last month (delta), handling the year wrap.
  const lm = curM === 0 ? 11 : curM - 1;
  const lmy = curM === 0 ? curY - 1 : curY;
  const monthDelta = monthDials - data.filter((r) => r.y === lmy && r.m === lm).length;

  // Dials per day this month.
  const perDay = Array.from({ length: daysInMonth }, () => 0);
  for (const r of monthRows) if (r.d >= 1 && r.d <= daysInMonth) perDay[r.d - 1]++;
  const bestDay = perDay.reduce((a, b) => Math.max(a, b), 0);
  const daysDialed = perDay.filter((n) => n > 0).length;
  const daysHitTarget = perDay.filter((n) => n >= DAY_TARGET).length;
  const dayMax = Math.max(bestDay, DAY_TARGET, 1);

  // Selected year, broken out by month.
  const yearRows = data.filter((r) => r.y === year);
  const yearDials = yearRows.length;
  const yearAvg = avgScore(yearRows.map((r) => r.score));
  const byMonth = Array.from({ length: 12 }, (_, m) => {
    const mr = yearRows.filter((r) => r.m === m);
    return { dials: mr.length, avg: avgScore(mr.map((r) => r.score)) };
  });
  const monthMax = Math.max(...byMonth.map((x) => x.dials), 1);

  const years = useMemo(() => {
    const ys = new Set<number>(data.map((r) => r.y));
    ys.add(curY);
    return Array.from(ys).sort((a, b) => a - b);
  }, [data, curY]);
  const minYear = years.length ? years[0] : curY;

  const tier = (n: number) =>
    n >= DAY_TARGET ? "hit" : n >= DAY_TARGET / 2 ? "ok" : n > 0 ? "low" : "none";

  return (
    <div className="history scoreboard">
      <div className="history-head">
        <div>
          <h2>Scoreboard</h2>
          <p className="history-sub">
            Dial volume and call quality over time. Every dial counts toward volume (scored calls,
            voicemails, and logged disconnects); the average score is over scored calls only.
          </p>
        </div>
        <div className="history-actions">
          <button className="ghost-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {err && (
        <div className="error-banner">
          Could not load scoreboard: <code>{err}</code>
        </div>
      )}

      {rows === null ? (
        <div className="history-empty">Loading…</div>
      ) : data.length === 0 ? (
        <div className="history-empty">
          <span className="he-title">No calls yet</span>
          Log dials and score calls — your monthly and yearly progress builds up here.
        </div>
      ) : (
        <div className="sb-body">
          <section className="sb-section">
            <div className="sb-cards">
              <div className="sb-card">
                <span className="sb-label">Dials this month</span>
                <span className="sb-value">{monthDials}</span>
                <span className={`sb-delta ${monthDelta >= 0 ? "up" : "down"}`}>
                  {monthDelta >= 0 ? "▲" : "▼"} {Math.abs(monthDelta)} vs last month
                </span>
              </div>
              <div className="sb-card">
                <span className="sb-label">Avg score this month</span>
                <span className="sb-value">{monthAvg ?? "—"}</span>
                <span className="sb-delta muted">{monthScored} scored</span>
              </div>
              <div className="sb-card">
                <span className="sb-label">Best day</span>
                <span className="sb-value">{bestDay}</span>
                <span className="sb-delta muted">
                  {daysDialed} days dialed · {daysHitTarget} hit {DAY_TARGET}+
                </span>
              </div>
            </div>

            <div className="sb-chart-head">
              <h3>{MONTHS[curM]} — dials per day</h3>
              <span className="sb-target-key">dashed line = {DAY_TARGET}/day (a thriving day)</span>
            </div>
            <div className="sb-daybars">
              <div
                className="sb-target-line"
                style={{ bottom: `${Math.round((DAY_TARGET / dayMax) * 100)}%` }}
                aria-hidden="true"
              />
              {perDay.map((n, i) => (
                <div
                  className="sb-daybar-col"
                  key={i}
                  title={`${MONTHS[curM]} ${i + 1}: ${n} ${n === 1 ? "dial" : "dials"}`}
                >
                  <div
                    className={`sb-daybar t-${tier(n)} ${i + 1 === today ? "is-today" : ""}`}
                    style={{ height: `${Math.round((n / dayMax) * 100)}%` }}
                  />
                </div>
              ))}
            </div>
          </section>

          <section className="sb-section">
            <div className="sb-chart-head">
              <h3>By month</h3>
              <div className="sb-year-nav">
                <button
                  className="ghost-btn sb-yr-btn"
                  onClick={() => setYear((y) => y - 1)}
                  disabled={year <= minYear}
                  aria-label="Previous year"
                >
                  ◀
                </button>
                <span className="sb-year">{year}</span>
                <button
                  className="ghost-btn sb-yr-btn"
                  onClick={() => setYear((y) => y + 1)}
                  disabled={year >= curY}
                  aria-label="Next year"
                >
                  ▶
                </button>
              </div>
            </div>
            <div className="sb-cards">
              <div className="sb-card">
                <span className="sb-label">Dials in {year}</span>
                <span className="sb-value">{yearDials}</span>
              </div>
              <div className="sb-card">
                <span className="sb-label">Avg score {year}</span>
                <span className="sb-value">{yearAvg ?? "—"}</span>
              </div>
            </div>
            <table className="sb-months">
              <tbody>
                {byMonth.map((mo, m) => (
                  <tr key={m} className={year === curY && m === curM ? "is-current" : ""}>
                    <td className="sb-mname">{MONTHS[m]}</td>
                    <td className="sb-mbar-cell">
                      <div
                        className="sb-mbar"
                        style={{ width: `${Math.round((mo.dials / monthMax) * 100)}%` }}
                      />
                    </td>
                    <td className="sb-mdials">{mo.dials}</td>
                    <td className="sb-mavg">{mo.avg !== null ? `avg ${mo.avg}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </div>
  );
}
