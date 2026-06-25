// The cold-call pet (Tamagotchi). His mood is a DAILY SURVIVAL ARC, computed
// deterministically from today's scored calls + the time of day — no new storage
// for the mood itself.
//
// Each working day he wakes at a content baseline with a clean pen. A hunger
// "pressure" rises with the clock, so doing nothing slides him content → peckish
// → hungry → dead by quitting time. Every scored call feeds him back up the
// ladder: the pen gets picked up, he eats, he plays, he thrives. Off-hours and
// weekends he naps; the next working morning he resets fresh (revives if he died).
//
// All hand-drawn inline SVG/CSS: offline, no external sprites, no copied IP.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Database from "@tauri-apps/plugin-sql";

const DB = "sqlite:coldcallcoach.db";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// Tiny helper so inline CSS custom properties (--i etc.) type-check.
const cssVars = (o: Record<string, string | number>): CSSProperties => o as CSSProperties;

// ---- Working-hours config (set in Settings, read from localStorage) ----------

interface WorkHours {
  start: number; // 24h hour, inclusive — the day resets here
  end: number; // 24h hour, exclusive — full hunger pressure here
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

// ---- Daily-arc mood model ----------------------------------------------------

// He wakes at CONTENT_BASE. Hunger pressure ramps to PRESSURE_MAX across the work
// day, so with zero calls he hits ~0 (dead) by quitting time. Each scored call
// adds PER_CALL (±15% by score; a voicemail = a full dial). Tuned so pacing your
// ~40 dials evenly carries him from content at the open to thriving by close.
const CONTENT_BASE = 24; // morning baseline — sits in the "content" band
const PRESSURE_MAX = 20; // full-day hunger pull; with no calls he hits dead by close
const PER_CALL = 1.2; // feed per dial (±15% by score); ~40 paced dials => thriving
const DEAD_AT = 8; // happiness below this during work hours => collapsed
// How the night goes, by where the day ended: dead < 10 ≤ restless < 20 ≤ asleep.
const NIGHT_DEAD_AT = 10; // ended below this => stays dead overnight
const NIGHT_OK_AT = 20; // at/above this => peaceful sleep; in between => restless

interface CallRow {
  score: number | null;
  at: Date;
}

// SQLite datetime('now') is UTC "YYYY-MM-DD HH:MM:SS".
function parseSqliteUtc(s: string): Date {
  return new Date(s.replace(" ", "T") + "Z");
}

// A dial's feed. Voicemail (null score) counts as a full dial — a dial is a dial.
function perCall(score: number | null): number {
  if (score === null || score === undefined) return PER_CALL;
  const s = clamp(score, 0, 100) / 100;
  return PER_CALL * (0.85 + 0.3 * s);
}

interface PetState {
  happiness: number; // 0-100
  isNew: boolean;
  sleeping: boolean; // off-hours / weekend
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
  const dow = now.getDay();
  const workedDay = cfg.weekends || (dow !== 0 && dow !== 6);
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), cfg.start, 0, 0, 0);
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), cfg.end, 0, 0, 0);
  const working = workedDay && now >= dayStart && now < dayEnd;

  // Today's dials = calls since this morning's reset (today's work start).
  let feed = 0;
  let callsToday = 0;
  let scoredSum = 0;
  let scoredN = 0;
  for (const c of calls) {
    if (c.at >= dayStart) {
      feed += perCall(c.score);
      callsToday++;
      if (c.score !== null) {
        scoredSum += c.score;
        scoredN++;
      }
    }
  }

  let happiness: number;
  if (working) {
    const t = clamp((now.getTime() - dayStart.getTime()) / (dayEnd.getTime() - dayStart.getTime()), 0, 1);
    happiness = clamp(Math.round(CONTENT_BASE + feed - PRESSURE_MAX * t), 0, 100);
  } else if (workedDay && now >= dayEnd) {
    // Evening of a worked day: freeze on how the day actually ended.
    happiness = clamp(Math.round(CONTENT_BASE + feed - PRESSURE_MAX), 0, 100);
  } else {
    // Pre-dawn, or a weekend: asleep at a neutral baseline, ready for a fresh day.
    happiness = CONTENT_BASE;
  }

  const last = calls.length ? calls.reduce((a, c) => (c.at > a.at ? c : a)) : null;

  return {
    happiness,
    isNew: calls.length === 0,
    sleeping: !working,
    callsToday,
    avgScore: scoredN ? Math.round(scoredSum / scoredN) : null,
    lastAgo: last ? agoLabel(now.getTime() - last.at.getTime()) : null,
  };
}

interface Mood {
  word: string;
  nudge: string;
}

// The ladder: dead → hungry → peckish → content → playing → thriving.
function mood(p: PetState): Mood {
  if (p.isNew) return { word: "new", nudge: "score a call to hatch me!" };
  // Off-hours: how he sleeps depends on how the day went. A wasted day leaves him
  // dead until the next morning revives him; a rough one leaves him restless.
  if (p.sleeping) {
    if (p.happiness < NIGHT_DEAD_AT) return { word: "dead", nudge: "rough day — back at the next open" };
    if (p.happiness < NIGHT_OK_AT) return { word: "restless", nudge: "tossing and turning" };
    return { word: "napping", nudge: "resting until work hours" };
  }
  if (p.happiness < DEAD_AT) return { word: "dead", nudge: "out cold — dial to revive him" };
  if (p.happiness < 15) return { word: "hungry", nudge: "feed me — make some calls!" };
  if (p.happiness < 20) return { word: "peckish", nudge: "pick up the pace" };
  if (p.happiness < 30) return { word: "content", nudge: "looking good" };
  if (p.happiness < 40) return { word: "playing", nudge: "on a roll!" };
  if (p.happiness < 55) return { word: "thriving", nudge: "crushing it!" };
  return { word: "ecstasy", nudge: "untouchable — keep it going!" };
}

// ---- Little SVG bits the flourishes are built from ---------------------------

function Sparkle() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path d="M8 0 L9.4 6.6 L16 8 L9.4 9.4 L8 16 L6.6 9.4 L0 8 L6.6 6.6 Z" fill="currentColor" />
    </svg>
  );
}

function Heart() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path
        d="M8 14.2 C8 14.2 1 9.4 1 5.2 C1 2.8 3 1.6 5 2.1 C6.4 2.5 8 4.2 8 4.2 C8 4.2 9.6 2.5 11 2.1 C13 1.6 15 2.8 15 5.2 C15 9.4 8 14.2 8 14.2 Z"
        fill="currentColor"
      />
    </svg>
  );
}

function SweatDrop() {
  return (
    <svg viewBox="0 0 8 12" width="7" height="10" aria-hidden="true">
      <path d="M4 0.5 C4 0.5 7 6 7 8.4 A3 3 0 1 1 1 8.4 C1 6 4 0.5 4 0.5 Z" fill="#5cc7f2" />
      <ellipse cx="2.7" cy="8.6" rx="0.9" ry="1.3" fill="#ffffff66" />
    </svg>
  );
}

// A tiny empty bowl in a thought bubble — language-neutral "feed me".
function ThoughtBowl() {
  return (
    <svg viewBox="0 0 32 26" width="30" height="24" aria-hidden="true">
      <circle cx="6" cy="22" r="2" fill="var(--bg-elev)" stroke="var(--border)" strokeWidth="1" />
      <circle cx="11" cy="17" r="2.7" fill="var(--bg-elev)" stroke="var(--border)" strokeWidth="1" />
      <rect x="9" y="2" width="22" height="14" rx="7" fill="var(--bg-elev)" stroke="var(--border)" strokeWidth="1" />
      <path d="M15 8 Q15 12.5 20 12.5 Q25 12.5 25 8 Z" fill="var(--text-faint)" />
      <path d="M14 8 H26" stroke="var(--text-dim)" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M18 5.6 q1.2 -1.2 0 -2.6" stroke="var(--text-faint)" strokeWidth="1" fill="none" strokeLinecap="round" />
      <path d="M21.5 5.6 q1.2 -1.2 0 -2.6" stroke="var(--text-faint)" strokeWidth="1" fill="none" strokeLinecap="round" />
    </svg>
  );
}

// A morsel of kibble he eats when a call is scored.
function Morsel() {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
      <path d="M2 5 Q2 2 5 2 L8 2 Q11 3 10 6 Q9 10 5 10 Q2 9 2 5 Z" fill="#e08a3c" />
      <circle cx="5" cy="5" r="1.1" fill="#fff" opacity="0.5" />
    </svg>
  );
}

// A little bouncing ball he plays with when he's doing well.
function ToyBall() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="#f06a8a" />
      <path d="M1.5 8 A7 7 0 0 1 14.5 8 Z" fill="#ffffff" opacity="0.22" />
      <path d="M8 1 V15" stroke="#b83b5e" strokeWidth="1.1" />
      <circle cx="6" cy="5.5" r="1.4" fill="#ffffff" opacity="0.5" />
    </svg>
  );
}

// ---- The creature's face -----------------------------------------------------

const BODY =
  "M24 5 C34 5 42 12 42 23 C42 34.5 35.5 44 24 44 C12.5 44 6 34.5 6 23 C6 12 14 5 24 5 Z";

// Color + brows + eyes + mouth all react to mood. `blink` momentarily shuts the
// eyes; `look` (-1/0/1) slides the pupils so it glances around.
function CritterFace({ mood, blink, look }: { mood: string; blink: boolean; look: number }) {
  const palette: Record<string, [string, string]> = {
    ecstasy: ["#86ffd0", "#10d89a"],
    thriving: ["#5eeab0", "#23c98e"],
    playing: ["#7ee7c0", "#2bd29a"],
    content: ["#86efc6", "#41d49e"],
    peckish: ["#fcd34d", "#f0a92a"],
    hungry: ["#fca5a5", "#f06868"],
    dead: ["#aab0a6", "#868c83"],
    restless: ["#aab1bc", "#6b7280"],
    napping: ["#9aa3b2", "#6b7280"],
    new: ["#9aa3b6", "#5b6472"],
  };
  const [c1, c2] = palette[mood] ?? palette.content;
  const dead = mood === "dead";
  const restless = mood === "restless";
  const asleep = mood === "napping" || restless;
  const blissful = mood === "ecstasy";
  const closed = blink || asleep;
  const grin = mood === "thriving" || mood === "playing" || blissful;
  const happy = grin || mood === "content";
  const px = 1.7 * look; // pupil shift (glance)
  const py = mood === "hungry" ? 1.3 : 0; // droops its gaze when hungry

  const brow = grin ? (
    <g stroke="#0e1117" strokeOpacity="0.5" strokeWidth="1.5" fill="none" strokeLinecap="round">
      <path d="M11.5 13.8 Q15 11.6 19 13.2" />
      <path d="M29 13.2 Q33 11.6 36.5 13.8" />
    </g>
  ) : mood === "hungry" ? (
    <g stroke="#0e1117" strokeOpacity="0.55" strokeWidth="1.6" fill="none" strokeLinecap="round">
      <path d="M11.5 15.6 L19 12.8" />
      <path d="M36.5 15.6 L29 12.8" />
    </g>
  ) : mood === "peckish" ? (
    <g stroke="#0e1117" strokeOpacity="0.45" strokeWidth="1.5" fill="none" strokeLinecap="round">
      <path d="M12.5 14 L18.5 14" />
      <path d="M29.5 14 L35.5 14" />
    </g>
  ) : null;

  const mouth = dead ? (
    <path d="M19 35 Q24 33 29 35" stroke="#0e1117" strokeWidth="1.7" fill="none" strokeLinecap="round" />
  ) : restless ? (
    <path d="M20.5 34 Q24 31.7 27.5 34" stroke="#0e1117" strokeWidth="1.7" fill="none" strokeLinecap="round" />
  ) : asleep ? (
    <path d="M20.5 33 Q24 35.4 27.5 33" stroke="#0e1117" strokeWidth="1.7" fill="none" strokeLinecap="round" />
  ) : grin ? (
    <g>
      <path d="M16.5 30 Q24 40.5 31.5 30 Z" fill="#7a2933" />
      <path d="M19.6 35 Q24 39.6 28.4 35 Z" fill="#fb7185" />
    </g>
  ) : mood === "content" ? (
    <path d="M18 31 Q24 36.6 30 31" stroke="#0e1117" strokeWidth="2" fill="none" strokeLinecap="round" />
  ) : mood === "peckish" ? (
    <path d="M20.5 33 Q24 34.6 27.5 33" stroke="#0e1117" strokeWidth="1.9" fill="none" strokeLinecap="round" />
  ) : mood === "hungry" ? (
    <path d="M21 34.2 Q24 31.4 27 34.2 Q24 37.4 21 34.2 Z" fill="#0e1117" />
  ) : (
    <ellipse cx="24" cy="33" rx="2" ry="2.4" fill="#0e1117" />
  );

  // Dead = X'd-out eyes; otherwise blink/sleep close them, else open with pupils.
  const eyes = dead ? (
    <g stroke="#0e1117" strokeWidth="1.7" strokeLinecap="round">
      <path d="M14 18.5 L20 24.5 M20 18.5 L14 24.5" />
      <path d="M28 18.5 L34 24.5 M34 18.5 L28 24.5" />
    </g>
  ) : blissful && !blink ? (
    <g stroke="#0e1117" strokeWidth="1.8" fill="none" strokeLinecap="round">
      <path d="M13 22 q4 -3 8 0" />
      <path d="M27 22 q4 -3 8 0" />
    </g>
  ) : closed ? (
    <g stroke="#0e1117" strokeWidth="1.8" fill="none" strokeLinecap="round">
      <path d="M13 21 q4 3 8 0" />
      <path d="M27 21 q4 3 8 0" />
    </g>
  ) : (
    <g>
      <circle cx="17" cy="21" r="4.1" fill="#fff" />
      <circle cx="31" cy="21" r="4.1" fill="#fff" />
      <circle cx={17 + px} cy={21 + py} r="2.3" fill="#0e1117" />
      <circle cx={31 + px} cy={21 + py} r="2.3" fill="#0e1117" />
      <circle cx={17 + px + 0.9} cy={21 + py - 1} r="0.8" fill="#fff" />
      <circle cx={31 + px + 0.9} cy={21 + py - 1} r="0.8" fill="#fff" />
    </g>
  );

  return (
    <svg className="blob" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
      <path d={BODY} fill={c1} />
      {/* roundness: a soft belly shade + a top highlight */}
      <ellipse cx="24" cy="33" rx="15" ry="11" fill={c2} opacity="0.25" />
      <ellipse cx="18" cy="14" rx="11" ry="8" fill="#ffffff" opacity="0.14" />
      {happy && (
        <g>
          <ellipse cx="12.5" cy="29" rx="3.1" ry="2" fill="#fb7185" opacity="0.5" />
          <ellipse cx="35.5" cy="29" rx="3.1" ry="2" fill="#fb7185" opacity="0.5" />
        </g>
      )}
      {brow}
      {eyes}
      {mouth}
    </svg>
  );
}

// A single poop pile on the floor (hand-drawn, three tiers + a curl).
function FloorPoop({ x, swept }: { x: number; swept: boolean }) {
  return (
    <div className={`poop ${swept ? "poop--swept" : ""}`} style={{ left: `${x}%` }} aria-hidden="true">
      <svg viewBox="0 0 26 21" width="24" height="19">
        <ellipse cx="13" cy="18.6" rx="11" ry="2.6" fill="rgba(0,0,0,0.22)" />
        <path
          d="M3.5 16.5 Q3.5 11.5 8.5 11.5 L17.5 11.5 Q22.5 11.5 22.5 16.5 Q22.5 18.8 17.5 18.8 L8.5 18.8 Q3.5 18.8 3.5 16.5 Z"
          fill="#6b4423"
        />
        <path
          d="M6.5 11.6 Q6.5 7.4 11 7.4 L16 7.4 Q20 7.4 20 11.6 Q20 12.6 16 12.6 L11 12.6 Q6.5 12.6 6.5 11.6 Z"
          fill="#7a4e29"
        />
        <path d="M9.5 7.5 Q9.5 4.2 13 4.2 Q16.8 4.2 16.4 7.5 Q16 8.4 13 8.4 Q9.8 8.4 9.5 7.5 Z" fill="#8a5a30" />
        <path d="M12.6 4.4 Q13.2 1.8 15.2 2.8" stroke="#4a2d14" strokeWidth="1.3" fill="none" strokeLinecap="round" />
        <circle cx="9.5" cy="14.5" r="1.1" fill="rgba(255,255,255,0.22)" />
        <circle cx="11.5" cy="9.6" r="0.9" fill="rgba(255,255,255,0.22)" />
      </svg>
    </div>
  );
}

// ---- Roaming + poop helpers --------------------------------------------------

// How the critter hops around, per mood: max hop distance (% of the band) + how
// long it rests between hops. Dead/napping hold still; playing/thriving bounce a lot.
function behavior(word: string): { hop: number; pauseMin: number; pauseMax: number } {
  switch (word) {
    case "ecstasy":
      return { hop: 32, pauseMin: 120, pauseMax: 450 };
    case "thriving":
      return { hop: 30, pauseMin: 150, pauseMax: 550 };
    case "playing":
      return { hop: 28, pauseMin: 200, pauseMax: 700 };
    case "content":
      return { hop: 24, pauseMin: 500, pauseMax: 1500 };
    case "peckish":
      return { hop: 16, pauseMin: 1200, pauseMax: 3000 };
    case "hungry":
      return { hop: 9, pauseMin: 2800, pauseMax: 6500 };
    case "new":
      return { hop: 20, pauseMin: 1200, pauseMax: 3500 }; // curious fresh blob
    default:
      return { hop: 0, pauseMin: 0, pauseMax: 0 }; // napping / dead: stay put
  }
}

const HOP_MS = 460; // time for one hop (left transition + the jump arc)

interface Poop {
  id: number;
  x: number; // % across the band
  swept?: boolean; // mid pick-up animation, about to be removed
}

// Poops persist across restarts (a pen left messy is still messy when you return).
function loadPoops(): Poop[] {
  try {
    const v = JSON.parse(localStorage.getItem("ccc.poops") || "[]");
    if (Array.isArray(v))
      return v
        .filter((p) => p && typeof p.x === "number")
        .map((p, i) => ({ id: typeof p.id === "number" ? p.id : i + 1, x: p.x }));
  } catch {
    /* corrupt value — start clean */
  }
  return [];
}

// Drop a fresh pile somewhere along the floor, spaced from the others.
function freshPoopX(existing: Poop[]): number {
  for (let tries = 0; tries < 12; tries++) {
    const x = 20 + Math.random() * 56; // 20%..76%
    if (existing.every((p) => Math.abs(p.x - x) > 12)) return x;
  }
  return 20 + Math.random() * 56;
}

// Ambient sparkles around a thriving critter (positions in px within .critter).
const SPK = [
  { t: 4, l: 4, d: 0 },
  { t: 0, l: 36, d: 650 },
  { t: 18, l: 44, d: 1250 },
];

// Scored-call confetti (tier 2): a full-terrarium shower, not a puff at the pet.
// Each bit falls from the top in its own column with drift + spin. The scatter is
// a deterministic hash of the index (stable across renders, no RNG).
const CONFETTI_COLORS = ["#fb7185", "#fbbf24", "#34d399", "#60a5fa", "#a78bfa", "#f472b6"];
const CONFETTI = Array.from({ length: 46 }, (_, i) => {
  const hash = (seed: number) => {
    const x = Math.sin((i + 1) * seed) * 43758.5453;
    return x - Math.floor(x); // 0..1
  };
  return {
    left: Math.round(hash(12.9898) * 98) + 1, // 1–99% across the full width
    fall: 108 + Math.round(hash(5.51) * 72), // 108–180px — past the 116px floor
    drift: Math.round((hash(9.17) - 0.5) * 80), // ±40px sideways sway
    rot: Math.round((hash(2.13) - 0.5) * 1080), // tumble
    delay: Math.round(hash(78.233) * 340), // 0–340ms stagger
    dur: 1100 + Math.round(hash(3.71) * 600), // 1.1–1.7s fall
    w: 6 + Math.round(hash(1.7) * 5), // 6–11px
    h: 8 + Math.round(hash(4.2) * 7), // 8–15px
    round: hash(6.61) > 0.72,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
  };
});

// ---- Component ---------------------------------------------------------------

export function Pet({
  refreshKey,
  celebrateSignal = 0,
  celebrateTier = 1,
}: {
  refreshKey: number;
  /** Bumped to fire a celebration — separate from refreshKey (which reloads the
   *  call history). Lets the on-press spin+eat fire before the score returns. */
  celebrateSignal?: number;
  /** Tier of the latest celebration: 0 = spin (logged dial), 1 = spin + eats
   *  (scored call, fired on press), 2 = backflip + confetti (a >50 score). */
  celebrateTier?: number;
}) {
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

  // Liveliness: blink, glance, the eating beat, level beats, and the messy pen.
  const [blinking, setBlinking] = useState(false);
  const [look, setLook] = useState(0);
  // Celebration tier currently animating (0/1/2), or null. Stacks: spin (all) +
  // eat (>=1) + confetti & backflip (>=2). celRef lets the roam loop hold still.
  const [cel, setCel] = useState<number | null>(null);
  const celRef = useRef<number | null>(null);
  // The ball Gers chases + nudges around the pen during the "playing" mood.
  const [ballPos, setBallPos] = useState(66);
  const [ballSpin, setBallSpin] = useState(0);
  const ballPosRef = useRef(66);
  const [poops, setPoops] = useState<Poop[]>(loadPoops);
  const poopId = useRef(poops.reduce((m, p) => Math.max(m, p.id), 0) + 1);
  const prevCel = useRef(celebrateSignal);
  const prevRank = useRef<number | null>(null);
  const [beat, setBeat] = useState<"up" | "down" | null>(null);

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

  // Re-render every 30s so the hunger pressure / nap / "last call" stay live.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const p = computePet(calls ?? [], new Date(), loadWorkHours());
  const m = mood(p);
  const isHungry = m.word === "hungry" && !moving && cel === null;

  // How many piles the pen "should" have right now, from how starved he is.
  const poopTarget = p.isNew
    ? 0
    : p.happiness < DEAD_AT
      ? 4
      : p.happiness < 15
        ? 3
        : p.happiness < 20
          ? 2
          : 0;
  const activePoops = poops.filter((pp) => !pp.swept);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  // Hop to a nearby spot, land, rest, repeat. Holds still when napping/dead (hop 0).
  useEffect(() => {
    const b = behavior(m.word);
    const playing = m.word === "playing";
    if (b.hop <= 0 && !playing) {
      setMoving(false);
      return;
    }
    let alive = true;
    let t = 0;
    const step = () => {
      if (!alive) return;
      // Hold still mid-celebration so the spin / backflip reads cleanly.
      if (celRef.current !== null) {
        t = window.setTimeout(step, 300);
        return;
      }
      const cur = posRef.current;
      if (playing) {
        // Chase the ball; when we reach it, boot it onward (bounces off the walls).
        const bp = ballPosRef.current;
        let dir = bp >= cur ? 1 : -1;
        let target: number;
        if (Math.abs(bp - cur) < 11) {
          let nx = bp + dir * (16 + Math.random() * 16);
          if (nx > 86 || nx < 10) {
            dir = -dir;
            nx = bp + dir * (16 + Math.random() * 16);
          }
          nx = Math.max(10, Math.min(86, nx));
          ballPosRef.current = nx;
          setBallPos(nx);
          setBallSpin((s) => s + dir * 420);
          target = Math.max(4, Math.min(84, cur + dir * 8));
        } else {
          target = Math.max(4, Math.min(84, cur + dir * (10 + Math.random() * 8)));
        }
        setFacing(dir);
        setDurMs(HOP_MS);
        setMoving(true);
        setPos(target);
        posRef.current = target;
        t = window.setTimeout(() => {
          if (!alive) return;
          setMoving(false);
          t = window.setTimeout(step, 520 + Math.random() * 260);
        }, HOP_MS);
      } else {
        const dir = Math.random() < 0.5 ? -1 : 1;
        let target = cur + dir * (0.5 + Math.random() * 0.5) * b.hop;
        target = Math.max(4, Math.min(84, target)); // stay in the band
        setFacing(target >= cur ? 1 : -1);
        setDurMs(HOP_MS);
        setMoving(true);
        setPos(target);
        posRef.current = target;
        t = window.setTimeout(() => {
          if (!alive) return;
          setMoving(false);
          const pause = b.pauseMin + Math.random() * (b.pauseMax - b.pauseMin);
          t = window.setTimeout(step, pause);
        }, HOP_MS);
      }
    };
    t = window.setTimeout(step, 400);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [m.word]);

  // Blink on a random cadence (not while asleep/dead — eyes are already shut/X'd).
  useEffect(() => {
    if (p.sleeping || m.word === "dead") {
      setBlinking(false);
      return;
    }
    let alive = true;
    let t = 0;
    const loop = () => {
      t = window.setTimeout(
        () => {
          if (!alive) return;
          setBlinking(true);
          window.setTimeout(() => alive && setBlinking(false), 150);
          loop();
        },
        2200 + Math.random() * 3800,
      );
    };
    loop();
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [p.sleeping, m.word]);

  // Glance left/right/center now and then.
  useEffect(() => {
    if (p.sleeping || m.word === "dead") {
      setLook(0);
      return;
    }
    let alive = true;
    let t = 0;
    const loop = () => {
      t = window.setTimeout(
        () => {
          if (!alive) return;
          const r = Math.random();
          setLook(r < 0.34 ? -1 : r < 0.68 ? 1 : 0);
          loop();
        },
        1600 + Math.random() * 2600,
      );
    };
    loop();
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [p.sleeping, m.word]);

  // A dial event happened → celebrate at the given tier (spin / + eat / + confetti
  // & backflip). Guarded so it never fires on first mount.
  useEffect(() => {
    if (celebrateSignal === prevCel.current) return;
    prevCel.current = celebrateSignal;
    const tier = celebrateTier;
    setCel(tier);
    celRef.current = tier;
    // Hold long enough for the full-terrarium confetti shower (tier 2) to fall.
    const hold = tier >= 2 ? 2300 : 1700;
    const t = window.setTimeout(() => {
      setCel(null);
      celRef.current = null;
    }, hold);
    return () => window.clearTimeout(t);
  }, [celebrateSignal]);

  // Reconcile the pen toward the hunger-driven target — only during work hours, so
  // a messy pen stays put overnight and gets cleaned at the next morning's reset.
  // Removals animate (poop gets "picked up") rather than vanishing.
  useEffect(() => {
    if (calls === null || p.sleeping) return;
    setPoops((prev) => {
      const active = prev.filter((pp) => !pp.swept);
      if (active.length === poopTarget) return prev;
      if (active.length > poopTarget) {
        const toSweep = new Set(active.slice(0, active.length - poopTarget).map((pp) => pp.id));
        return prev.map((pp) => (toSweep.has(pp.id) ? { ...pp, swept: true } : pp));
      }
      const next = prev.slice();
      let add = poopTarget - active.length;
      while (add-- > 0) next.push({ id: poopId.current++, x: freshPoopX(next) });
      return next;
    });
  }, [poopTarget, p.sleeping, calls]);

  // Drop swept piles once their pick-up animation finishes.
  useEffect(() => {
    if (!poops.some((pp) => pp.swept)) return;
    const t = window.setTimeout(() => setPoops((prev) => prev.filter((pp) => !pp.swept)), 600);
    return () => window.clearTimeout(t);
  }, [poops]);

  useEffect(() => {
    try {
      localStorage.setItem("ccc.poops", JSON.stringify(poops.filter((pp) => !pp.swept)));
    } catch {
      /* storage full / disabled — non-fatal */
    }
  }, [poops]);

  // Level-up / level-down beats: a brief glow when he climbs a rung, a sad flash
  // when he slips one. Only after the first real read (so loading doesn't fire).
  useEffect(() => {
    if (calls === null) return;
    const rank =
      p.isNew || p.sleeping
        ? null
        : p.happiness < DEAD_AT
          ? 0
          : p.happiness < 15
            ? 1
            : p.happiness < 20
              ? 2
              : p.happiness < 30
                ? 3
                : p.happiness < 40
                  ? 4
                  : p.happiness < 55
                    ? 5
                    : 6;
    const prev = prevRank.current;
    prevRank.current = rank;
    if (prev === null || rank === null || prev === rank) return;
    setBeat(rank > prev ? "up" : "down");
    const t = window.setTimeout(() => setBeat(null), 900);
    return () => window.clearTimeout(t);
  }, [p.happiness, p.isNew, p.sleeping, calls]);

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
      <div className="habitat-floor" aria-hidden="true" />

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

      {/* the messy pen — piles on the floor, plus the odd fly when it's bad */}
      {poops.map((pp) => (
        <FloorPoop key={pp.id} x={pp.x} swept={!!pp.swept} />
      ))}
      {cel === null && (m.word === "dead" || (!p.sleeping && activePoops.length >= 2)) && (
        <div className="fly" style={{ left: `${activePoops[0]?.x ?? pos}%` }} aria-hidden="true">
          <span />
        </div>
      )}
      {cel === null && (m.word === "dead" || (!p.sleeping && activePoops.length >= 3)) && (
        <div
          className="fly"
          style={{ left: `${activePoops[activePoops.length - 1]?.x ?? pos + 6}%`, animationDelay: "700ms" }}
          aria-hidden="true"
        >
          <span />
        </div>
      )}

      {m.word === "playing" && (
        <div
          className="play-ball"
          style={{ left: `${ballPos}%`, transform: `rotate(${ballSpin}deg)` }}
          aria-hidden="true"
        >
          <ToyBall />
        </div>
      )}

      {cel != null && cel >= 2 && (
        <div className="confetti" aria-hidden="true">
          {CONFETTI.map((c, i) => (
            <span
              key={i}
              className={`confetti-bit${c.round ? " round" : ""}`}
              style={cssVars({
                left: `${c.left}%`,
                width: `${c.w}px`,
                height: `${c.h}px`,
                background: c.color,
                "--fall": `${c.fall}px`,
                "--drift": `${c.drift}px`,
                "--rot": `${c.rot}deg`,
                animationDelay: `${c.delay}ms`,
                animationDuration: `${c.dur}ms`,
              })}
            />
          ))}
        </div>
      )}

      <div
        className={`critter ${moving ? "is-moving" : ""} ${
          cel === null ? "" : cel >= 2 ? "cel-flip" : "cel-spin"
        } ${isHungry ? "is-hungry" : ""} ${beat ? `beat-${beat}` : ""}`}
        style={{
          left: `${pos}%`,
          transitionProperty: "left",
          transitionTimingFunction: "linear",
          transitionDuration: `${durMs}ms`,
        }}
      >
        {/* flourishes — outside .critter-facing so text/icons never mirror */}
        {m.word === "napping" && (
          <div className="zzz" aria-hidden="true">
            <span style={cssVars({ "--i": 0 })}>z</span>
            <span style={cssVars({ "--i": 1 })}>z</span>
            <span style={cssVars({ "--i": 2 })}>z</span>
          </div>
        )}
        {m.word === "restless" && (
          <div className="zzz restless" aria-hidden="true">
            <span>z</span>
          </div>
        )}
        {m.word === "thriving" && (
          <div className="sparkles" aria-hidden="true">
            {SPK.map((s, i) => (
              <span
                key={i}
                className="spk"
                style={cssVars({ top: `${s.t}px`, left: `${s.l}px`, animationDelay: `${s.d}ms` })}
              >
                <Sparkle />
              </span>
            ))}
          </div>
        )}
        {m.word === "ecstasy" && (
          <div className="bliss" aria-hidden="true">
            <span className="bl bl-h">
              <Heart />
            </span>
            <span className="bl bl-s">
              <Sparkle />
            </span>
            <span className="bl bl-h">
              <Heart />
            </span>
            <span className="bl bl-s">
              <Sparkle />
            </span>
          </div>
        )}
        {m.word === "hungry" && (
          <div className="sweat" aria-hidden="true">
            <SweatDrop />
          </div>
        )}
        {m.word === "hungry" && (
          <div className="thought" aria-hidden="true">
            <ThoughtBowl />
          </div>
        )}
        {cel !== null && (
          <>
            <div className="fed-bubble">
              {cel >= 2 ? "great call!" : cel === 1 ? "yum! +1 dial" : "+1 dial"}
            </div>
            {cel === 1 && (
              <div className="morsel" aria-hidden="true">
                <Morsel />
              </div>
            )}
          </>
        )}

        <div className="critter-shadow" aria-hidden="true" />
        <div className="critter-facing" style={{ transform: `scaleX(${facing})` }}>
          <div className="critter-body">
            <CritterFace mood={m.word} blink={blinking} look={look} />
          </div>
        </div>
      </div>
    </div>
  );
}
