// The cold-call pet (Tamagotchi). Its mood is computed deterministically from
// your call history + the current time — no new storage. A call "feeds" it
// (more for higher scores); the feed decays, but ONLY over your working hours,
// so it naps evenings/weekends instead of starving. Lives in a horizontal strip
// at the bottom of the Coaching panel.

import { useEffect, useState } from "react";
import Database from "@tauri-apps/plugin-sql";

const DB = "sqlite:coldcallcoach.db";

// ---- Working-hours config (set in Settings, read from localStorage) ----------

interface WorkHours {
  start: number; // 24h hour, inclusive
  end: number; // 24h hour, exclusive
  weekends: boolean;
}

function loadWorkHours(): WorkHours {
  const num = (k: string, d: number) => {
    const v = parseInt(localStorage.getItem(k) ?? "", 10);
    return Number.isFinite(v) ? Math.max(0, Math.min(24, v)) : d;
  };
  const start = num("ccc.workStart", 9);
  let end = num("ccc.workEnd", 17);
  if (end <= start) end = start + 1; // guard against an empty/inverted window
  return { start, end, weekends: localStorage.getItem("ccc.workWeekends") === "1" };
}

// ---- Mood model --------------------------------------------------------------

const HALFLIFE_WH = 6; // a call's "feed" halves every 6 working hours
const LOOKBACK_DAYS = 14;

interface CallRow {
  score: number | null;
  at: Date;
}

// SQLite datetime('now') is UTC "YYYY-MM-DD HH:MM:SS".
function parseSqliteUtc(s: string): Date {
  return new Date(s.replace(" ", "T") + "Z");
}

/** Hours that fall inside the daily working window (on worked days) between two
 *  timestamps. This is what makes decay pause overnight and on weekends. */
function workingHoursBetween(from: Date, to: Date, cfg: WorkHours): number {
  if (to <= from) return 0;
  let total = 0;
  const cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  let guard = 0;
  while (cur <= end && guard < LOOKBACK_DAYS + 2) {
    const dow = cur.getDay();
    const weekend = dow === 0 || dow === 6;
    if (cfg.weekends || !weekend) {
      const ws = new Date(cur);
      ws.setHours(cfg.start, 0, 0, 0);
      const we = new Date(cur);
      we.setHours(cfg.end, 0, 0, 0);
      const s = Math.max(ws.getTime(), from.getTime());
      const e = Math.min(we.getTime(), to.getTime());
      if (e > s) total += (e - s) / 3_600_000;
    }
    cur.setDate(cur.getDate() + 1);
    guard++;
  }
  return total;
}

function isWorkingNow(now: Date, cfg: WorkHours): boolean {
  const dow = now.getDay();
  if (!cfg.weekends && (dow === 0 || dow === 6)) return false;
  const h = now.getHours() + now.getMinutes() / 60;
  return h >= cfg.start && h < cfg.end;
}

// A dial always counts (the habit); a higher score feeds more.
function feedAmount(score: number | null): number {
  if (score === null || score === undefined) return 10;
  return 12 + (Math.max(0, Math.min(100, score)) / 100) * 16; // 12–28
}

interface PetState {
  happiness: number; // 0-100
  isNew: boolean;
  sleeping: boolean;
  callsToday: number;
  avgScore: number | null;
  lastAgo: string | null;
}

function agoLabel(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function computePet(calls: CallRow[], now: Date, cfg: WorkHours): PetState {
  const cutoff = now.getTime() - LOOKBACK_DAYS * 24 * 3_600_000;
  const recent = calls.filter((c) => c.at.getTime() >= cutoff);

  let happiness = 0;
  for (const c of recent) {
    const wh = workingHoursBetween(c.at, now, cfg);
    happiness += feedAmount(c.score) * Math.pow(0.5, wh / HALFLIFE_WH);
  }
  happiness = Math.max(0, Math.min(100, Math.round(happiness)));

  const isToday = (d: Date) =>
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const callsToday = calls.filter((c) => isToday(c.at)).length;

  const scored = recent.filter((c) => c.score !== null);
  const avgScore = scored.length
    ? Math.round(scored.reduce((a, c) => a + (c.score ?? 0), 0) / scored.length)
    : null;

  const last = calls.length ? calls.reduce((a, c) => (c.at > a.at ? c : a)) : null;

  return {
    happiness,
    isNew: calls.length === 0,
    sleeping: !isWorkingNow(now, cfg),
    callsToday,
    avgScore,
    lastAgo: last ? agoLabel(now.getTime() - last.at.getTime()) : null,
  };
}

interface Mood {
  emoji: string;
  word: string;
  nudge: string;
}

function mood(p: PetState): Mood {
  if (p.isNew) return { emoji: "🥚", word: "new", nudge: "Score a call to hatch me!" };
  if (p.sleeping) return { emoji: "😴", word: "napping", nudge: "resting until work hours" };
  if (p.happiness >= 80) return { emoji: "😻", word: "thriving", nudge: "keep it going!" };
  if (p.happiness >= 55) return { emoji: "😺", word: "content", nudge: "looking good" };
  if (p.happiness >= 30) return { emoji: "😼", word: "peckish", nudge: "time for a call" };
  return { emoji: "😿", word: "hungry", nudge: "feed me — make a call!" };
}

// ---- Component ---------------------------------------------------------------

export function Pet({ refreshKey }: { refreshKey: number }) {
  const [calls, setCalls] = useState<CallRow[] | null>(null);
  const [, setTick] = useState(0);
  const [name, setName] = useState(() => localStorage.getItem("ccc.petName") || "Pixel");
  const [editing, setEditing] = useState(false);

  // Reload call history on mount + whenever a new call is scored.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await Database.load(DB);
        const rows = await db.select<{ overall_score: number | null; created_at: string }[]>(
          "SELECT overall_score, created_at FROM call ORDER BY created_at DESC LIMIT 300",
        );
        if (!cancelled) {
          setCalls(rows.map((r) => ({ score: r.overall_score, at: parseSqliteUtc(r.created_at) })));
        }
      } catch {
        if (!cancelled) setCalls([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // Re-render every minute so decay / nap / "last call" stay live.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const p = computePet(calls ?? [], new Date(), loadWorkHours());
  const m = mood(p);

  const saveName = (v: string) => {
    const n = v.trim() || "Pixel";
    setName(n);
    localStorage.setItem("ccc.petName", n);
    setEditing(false);
  };

  return (
    <div className={`pet mood-${m.word}`} title={`${name} is ${m.word}`}>
      <span className="pet-face">{m.emoji}</span>
      <div className="pet-mid">
        <div className="pet-toprow">
          {editing ? (
            <input
              className="pet-name-input"
              defaultValue={name}
              autoFocus
              onBlur={(e) => saveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveName((e.target as HTMLInputElement).value);
              }}
            />
          ) : (
            <span className="pet-name" onClick={() => setEditing(true)} title="Click to rename">
              {name}
            </span>
          )}
          <span className="pet-mood">{m.word}</span>
          <span className="pet-nudge">· {m.nudge}</span>
        </div>
        <div className="pet-bar">
          <div className="pet-fill" style={{ width: `${p.isNew ? 0 : p.happiness}%` }} />
        </div>
      </div>
      <div className="pet-stats">
        <span className="pet-happy">{p.isNew ? "—" : p.happiness}</span>
        <span className="pet-substats">
          {p.callsToday} today
          {p.avgScore !== null ? ` · avg ${p.avgScore}` : ""}
          {p.lastAgo ? ` · ${p.lastAgo}` : ""}
        </span>
      </div>
    </div>
  );
}
