// The cold-call pet (Tamagotchi). Its mood is computed deterministically from
// your call history + the current time — no new storage. A call "feeds" it
// (more for higher scores); the feed decays, but ONLY over your working hours,
// so it naps evenings/weekends instead of starving. Lives in a horizontal strip
// at the bottom of the Coaching panel.

import { useEffect, useRef, useState } from "react";
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

// Volume-tuned for a sales rep: ~40 calls/day => thriving (maxed out), ~25/day
// => content, ~10/day => hungry (losing health). A call's "feed" halves every
// working DAY; decay is measured in working days so it pauses off-hours and the
// calibration is independent of how long the work day is.
const BASE_FEED = 1.8;
const HALFLIFE_DAYS = 1;
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

// Volume rules; score is only a small ±15% modifier. A voicemail (null score)
// counts as a full dial — for a sales rep, a dial is a dial.
function feedAmount(score: number | null): number {
  if (score === null || score === undefined) return BASE_FEED;
  const s = Math.max(0, Math.min(100, score)) / 100;
  return BASE_FEED * (0.85 + 0.3 * s);
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

  // Decay in working DAYS = working-hours since the call / a work-day's length.
  const workdayHours = Math.max(1, cfg.end - cfg.start);
  let happiness = 0;
  for (const c of recent) {
    const workdays = workingHoursBetween(c.at, now, cfg) / workdayHours;
    happiness += feedAmount(c.score) * Math.pow(0.5, workdays / HALFLIFE_DAYS);
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
  word: string;
  nudge: string;
}

function mood(p: PetState): Mood {
  if (p.isNew) return { word: "new", nudge: "score a call to hatch me!" };
  if (p.sleeping) return { word: "napping", nudge: "resting until work hours" };
  if (p.happiness >= 80) return { word: "thriving", nudge: "keep dialing!" };
  if (p.happiness >= 55) return { word: "content", nudge: "looking good" };
  if (p.happiness >= 30) return { word: "peckish", nudge: "pick up the pace" };
  return { word: "hungry", nudge: "feed me — make some calls!" };
}

// A little blob creature drawn in SVG — color + mouth + eyes react to mood.
function BlobFace({ mood }: { mood: string }) {
  const fill =
    ({
      thriving: "#34d399",
      content: "#6ee7b7",
      peckish: "#fbbf24",
      hungry: "#f87171",
      napping: "#6b7280",
      new: "#5b6472",
    } as Record<string, string>)[mood] ?? "#6ee7b7";
  const sleeping = mood === "napping"; // a fresh blob is awake and curious
  const mouth =
    ({
      thriving: "M12 22 Q20 31 28 22",
      content: "M14 23 Q20 28 26 23",
      peckish: "M14 24 L26 24",
      hungry: "M14 27 Q20 21 26 27",
      napping: "M16 24 Q20 26 24 24",
      new: "M16 24 Q20 26 24 24",
    } as Record<string, string>)[mood] ?? "M14 23 Q20 28 26 23";
  return (
    <svg className="blob" viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
      <path
        d="M20 3 C30 3 37 11 37 21 C37 32 30 37 20 37 C10 37 3 32 3 21 C3 11 10 3 20 3 Z"
        fill={fill}
      />
      {sleeping ? (
        <>
          <path d="M10 18 q3.5 2.5 7 0" stroke="#0e1117" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <path d="M23 18 q3.5 2.5 7 0" stroke="#0e1117" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="14" cy="18" r="2.3" fill="#0e1117" />
          <circle cx="26" cy="18" r="2.3" fill="#0e1117" />
        </>
      )}
      <path d={mouth} stroke="#0e1117" strokeWidth="1.9" fill="none" strokeLinecap="round" />
    </svg>
  );
}

// ---- Component ---------------------------------------------------------------

// How the critter hops around (old-school Tamagotchi), per mood: max hop
// distance (% of the band) + how long it rests between hops. Hungry = small,
// rare hops; thriving = big, frequent hops.
function behavior(word: string): { hop: number; pauseMin: number; pauseMax: number } {
  switch (word) {
    case "thriving":
      return { hop: 30, pauseMin: 150, pauseMax: 550 };
    case "content":
      return { hop: 24, pauseMin: 500, pauseMax: 1500 };
    case "peckish":
      return { hop: 16, pauseMin: 1200, pauseMax: 3000 };
    case "hungry":
      return { hop: 9, pauseMin: 2800, pauseMax: 6500 };
    case "new":
      return { hop: 20, pauseMin: 1200, pauseMax: 3500 }; // curious fresh blob
    default:
      return { hop: 0, pauseMin: 0, pauseMax: 0 }; // napping: rest in place
  }
}

const HOP_MS = 460; // time for one hop (left transition + the jump arc)

export function Pet({ refreshKey }: { refreshKey: number }) {
  const [calls, setCalls] = useState<CallRow[] | null>(null);
  const [, setTick] = useState(0);
  const [name, setName] = useState(() => localStorage.getItem("ccc.petName") || "Pixel");
  const [editing, setEditing] = useState(false);

  // Roaming state: where the critter is (left %), how long the stroll takes, the
  // way it faces, and whether it's mid-walk (drives the walk animation).
  const [pos, setPos] = useState(50);
  const [durMs, setDurMs] = useState(0);
  const [facing, setFacing] = useState(1);
  const [moving, setMoving] = useState(false);
  const posRef = useRef(50);

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
  const beh = behavior(m.word);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  // Hop to a nearby spot, land, rest, repeat. Rests in place when napping (hop 0).
  useEffect(() => {
    if (beh.hop <= 0) {
      setMoving(false);
      return;
    }
    let alive = true;
    let t = 0;
    const step = () => {
      if (!alive) return;
      const cur = posRef.current;
      const dir = Math.random() < 0.5 ? -1 : 1;
      let target = cur + dir * (0.5 + Math.random() * 0.5) * beh.hop;
      target = Math.max(4, Math.min(84, target)); // stay in the band
      setFacing(target >= cur ? 1 : -1);
      setDurMs(HOP_MS);
      setMoving(true);
      setPos(target);
      posRef.current = target;
      t = window.setTimeout(() => {
        if (!alive) return;
        setMoving(false);
        const pause = beh.pauseMin + Math.random() * (beh.pauseMax - beh.pauseMin);
        t = window.setTimeout(step, pause);
      }, HOP_MS);
    };
    t = window.setTimeout(step, 400);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [beh.hop, beh.pauseMin, beh.pauseMax]);

  const saveName = (v: string) => {
    const n = v.trim() || "Pixel";
    setName(n);
    localStorage.setItem("ccc.petName", n);
    setEditing(false);
  };

  return (
    <div className={`pet-habitat mood-${m.word}`}>
      <div className="habitat-bar">
        <div className="habitat-fill" style={{ width: `${p.isNew ? 0 : p.happiness}%` }} />
      </div>

      <div className="habitat-info">
        <div className="habitat-left">
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
        <div className="habitat-right">
          <span className="pet-happy">{p.isNew ? "—" : p.happiness}</span>
          <span className="pet-substats">
            {p.callsToday} today
            {p.avgScore !== null ? ` · avg ${p.avgScore}` : ""}
            {p.lastAgo ? ` · ${p.lastAgo}` : ""}
          </span>
        </div>
      </div>

      <div
        className={`critter ${moving ? "is-moving" : ""}`}
        style={{
          left: `${pos}%`,
          transform: `scaleX(${facing})`,
          transitionProperty: "left",
          transitionTimingFunction: "linear",
          transitionDuration: `${durMs}ms`,
        }}
      >
        {m.word === "napping" && <span className="zzz">z</span>}
        <div className="critter-body">
          <BlobFace mood={m.word} />
        </div>
      </div>
    </div>
  );
}
