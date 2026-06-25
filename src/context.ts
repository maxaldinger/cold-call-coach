import Database from "@tauri-apps/plugin-sql";

// The company-context layer that powers the coaching engine. Stored in SQLite
// (context_profile), seeded with the real Bito content so the app works out of
// the box, and editable from the settings screen. One profile is seeded (Bito);
// the table keeps an id so it's multi-profile-capable later.
//
// Everything here is non-secret config. It is read in JS and passed to the Rust
// `analyze_call` command, which interpolates it into the coaching prompt. The
// API key never lives here — it stays in the OS keychain, read only in Rust.

export interface Capability {
  name: string;
  description: string;
  proof_points: string[];
}

/** A cold-call objection + the ideal way to handle it. The coach scores the
 *  rep's objection handling against these. */
export interface Objection {
  objection: string;
  response: string;
}

export interface ContextProfile {
  id: number;
  company: string;
  /** The rep's name — used so the coach addresses feedback to a person and can
   *  fill the opener template. */
  rep_name: string;
  /** The crisp one-line value proposition the rep should be able to land. */
  value_oneliner: string;
  /** An exemplary cold-call opener; the coach compares the rep's real opener to it. */
  ideal_opener: string;
  /** Bito's products + proof points — the ONLY allowed source of truth about what
   *  Bito does. The coach checks the rep's claims against this. */
  catalog: Capability[];
  /** ICP / personas a rep cold-calls — used to judge relevance/personalization. */
  personas: string[];
  /** Common objections + ideal responses — the objection-handling answer key. */
  objections: Objection[];
  /** Freeform extra coaching context (campaign notes, current promo, etc.). */
  extra_context: string;
}

/** Real Bito seed content. */
export const BITO_SEED: Omit<ContextProfile, "id"> = {
  company: "Bito",
  rep_name: "",
  value_oneliner:
    "Bito gives engineering teams an AI Code Review Agent plus a codebase-intelligence layer (AI Architect) that closes PRs ~45% faster and wins back ~1 day/sprint — without ever storing your code or training on it.",
  ideal_opener:
    "Hi {prospect}, this is {rep} from Bito — I know I'm catching you cold. Can I take 30 seconds to tell you why I called, and then you tell me if it's worth continuing?",
  catalog: [
    {
      name: "AI Code Review Agent",
      description:
        "Codebase-aware PR feedback, 1-click suggestions, custom review rules, and PR summaries across GitHub / GitLab / Bitbucket (incl. self-hosted / Enterprise).",
      proof_points: [
        "PRs close ~45% faster",
        "~89% improvement in median merge time",
        "Bito provides ~85% of PR feedback",
        "Teams win back ~1 day/sprint",
      ],
    },
    {
      name: "AI Architect",
      description:
        "Codebase-intelligence context layer (runs locally or in Docker) that builds a semantic + syntactic knowledge graph of the codebase — grounded in code, commits, issues, docs, and Slack — across repos and services. Available via MCP. It augments your existing setup (same model, same IDE) rather than replacing anything: by grounding AI coding agents in how your system actually works, they produce more production-ready output with less wasted token spend. The core wedge — nearly every capability ladders back to it.",
      proof_points: [
        "Grounds AI coding agents so they produce production-ready, higher-quality output",
        "Cuts wasted token spend from agents flailing without codebase context",
        "Augments your existing model + IDE — doesn't replace them",
      ],
    },
    {
      name: "Security posture",
      description: "No code stored, no model trained on code, SOC 2 Type II.",
      proof_points: [],
    },
  ],
  personas: [
    "VP Engineering",
    "CTO",
    "Director of Platform / DevEx / Engineering Productivity",
    "Engineering Managers",
  ],
  objections: [
    {
      objection: "We already use Copilot / CodeRabbit / another review tool.",
      response:
        "Totally fair. The wedge isn't another diff-reviewer — it's AI Architect, a knowledge graph of YOUR codebase (code, commits, issues, Slack) that grounds review in real context. Most point tools review a diff in isolation; we catch the cross-repo break before it merges.",
    },
    {
      objection: "We don't have budget / now isn't a good time.",
      response:
        "Makes sense — most teams I call aren't shopping. I reached out because teams like yours are winning back ~1 day/sprint on review alone. Worth a 15-minute look, or should I circle back next quarter?",
    },
    {
      objection: "Just send me some info.",
      response:
        "Happy to — so I send the right thing, are you most focused on review speed, onboarding/ramp, or codebase knowledge? And honestly, would 15 minutes Thursday beat a PDF that sits in your inbox?",
    },
    {
      objection: "Is our code safe? What about security?",
      response:
        "Yes — no code stored, no model trained on your code, and we're SOC 2 Type II. Want me to send the security one-pager alongside a quick walkthrough?",
    },
    {
      objection: "Who is this? / What is this about?",
      response:
        "Reason I called: I work with engineering leaders at companies like yours who are trying to ship reviews faster without growing the team — can I give you the 30-second version?",
    },
  ],
  extra_context: "",
};

interface ProfileRow {
  id: number;
  company: string;
  rep_name: string;
  value_oneliner: string;
  ideal_opener: string;
  catalog_json: string;
  personas_json: string;
  objections_json: string;
  extra_context: string;
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function parseRow(r: ProfileRow): ContextProfile {
  return {
    id: r.id,
    company: r.company,
    rep_name: r.rep_name ?? "",
    value_oneliner: r.value_oneliner ?? "",
    ideal_opener: r.ideal_opener ?? "",
    catalog: safeParse(r.catalog_json, [] as Capability[]),
    personas: safeParse(r.personas_json, [] as string[]),
    objections: safeParse(r.objections_json, [] as Objection[]),
    extra_context: r.extra_context ?? "",
  };
}

const DB = "sqlite:coldcallcoach.db";

/**
 * The single seam for reading company context (the coaching prompt is built
 * from this). Returns the active profile, seeding the Bito defaults on first run.
 */
export async function loadContext(): Promise<ContextProfile> {
  const db = await Database.load(DB);
  const existing = await db.select<ProfileRow[]>(
    "SELECT * FROM context_profile ORDER BY id DESC LIMIT 1"
  );
  if (existing.length > 0) {
    return parseRow(existing[0]);
  }
  // Seed (guarded so a race can't double-insert).
  await db.execute(
    `INSERT INTO context_profile
       (company, rep_name, value_oneliner, ideal_opener, catalog_json,
        personas_json, objections_json, extra_context)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8
     WHERE NOT EXISTS (SELECT 1 FROM context_profile)`,
    [
      BITO_SEED.company,
      BITO_SEED.rep_name,
      BITO_SEED.value_oneliner,
      BITO_SEED.ideal_opener,
      JSON.stringify(BITO_SEED.catalog),
      JSON.stringify(BITO_SEED.personas),
      JSON.stringify(BITO_SEED.objections),
      BITO_SEED.extra_context,
    ]
  );
  const seeded = await db.select<ProfileRow[]>(
    "SELECT * FROM context_profile ORDER BY id DESC LIMIT 1"
  );
  return parseRow(seeded[0]);
}

/** Persist an edited profile. */
export async function saveProfile(p: ContextProfile): Promise<void> {
  const db = await Database.load(DB);
  await db.execute(
    `UPDATE context_profile SET
       company = $1, rep_name = $2, value_oneliner = $3, ideal_opener = $4,
       catalog_json = $5, personas_json = $6, objections_json = $7,
       extra_context = $8, updated_at = datetime('now')
     WHERE id = $9`,
    [
      p.company,
      p.rep_name,
      p.value_oneliner,
      p.ideal_opener,
      JSON.stringify(p.catalog),
      JSON.stringify(p.personas),
      JSON.stringify(p.objections),
      p.extra_context,
      p.id,
    ]
  );
}
