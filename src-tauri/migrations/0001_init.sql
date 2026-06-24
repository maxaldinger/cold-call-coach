-- Cold Call Coach — initial schema (v1)
--
-- HARD RULE (carried from Tell): there is no transcript column and no raw-audio
-- column anywhere in this database. The transcript exists in memory only, is
-- used to produce the coaching report, and is then discarded. Do not add one.
--
-- This is a fresh database for a brand-new app (sqlite:coldcallcoach.db). There
-- is no deployed v0 to migrate from, so the whole schema lives in this one
-- migration. Future changes are append-only numbered migrations — never edit a
-- shipped migration in place (sqlx checksums it; a mismatch blocks app start).

PRAGMA foreign_keys = ON;

-- Company-context layer that powers the coaching prompt. A single active row in
-- practice, but kept as a table so it is editable from Settings and versionable.
CREATE TABLE IF NOT EXISTS context_profile (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    company           TEXT NOT NULL,
    rep_name          TEXT NOT NULL DEFAULT '',
    value_oneliner    TEXT NOT NULL DEFAULT '',   -- crisp one-line value prop
    ideal_opener      TEXT NOT NULL DEFAULT '',   -- model pattern-interrupt opener
    catalog_json      TEXT NOT NULL,              -- Bito products + proof points
    personas_json     TEXT NOT NULL,              -- ICP / personas for relevance
    objections_json   TEXT NOT NULL DEFAULT '[]', -- [{objection, response}] answer key
    extra_context     TEXT NOT NULL DEFAULT '',   -- freeform coaching notes
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per coached cold call. Note: NO transcript column. overall_score is
-- nullable — a voicemail / too-thin call has no number by design.
CREATE TABLE IF NOT EXISTS call (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    prospect      TEXT NOT NULL,                  -- who was called (user-entered)
    call_date     TEXT NOT NULL,                  -- YYYY-MM-DD (local)
    model         TEXT NOT NULL DEFAULT '',       -- Claude model that scored it
    overall_score INTEGER,                        -- 0-100, NULL on thin calls
    grade_band    TEXT NOT NULL DEFAULT '',       -- strong|solid|developing|needs_work|insufficient_signal
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The full coaching report, stored as one opaque JSON payload (the serialized
-- CoachingReport). Keeping it as a blob means the DB never couples to the
-- report's internal schema — a reopened call deserializes the same Rust/TS
-- struct and renders identically, with no recomputation.
CREATE TABLE IF NOT EXISTS coaching_report (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id       INTEGER NOT NULL REFERENCES call(id) ON DELETE CASCADE,
    payload_json  TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_report_call ON coaching_report(call_id);
