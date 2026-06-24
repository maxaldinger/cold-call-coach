//! AI engine — ONE structured Claude call from the labeled cold-call transcript
//! + Bito context, producing a structured coaching report.
//!
//! SECURITY: this runs entirely in Rust. The Anthropic API key lives in the OS
//! keychain (Windows Credential Manager) and is read here; the transcript lives
//! in Rust memory. Neither ever crosses to the webview. Only the parsed result
//! is returned to the UI. The context is non-secret config passed in from JS.
//!
//! This module mirrors the single-Claude-call rails of the sibling `generate.rs`
//! (call_claude / extract_json / one-repair-pass), then applies DETERMINISTIC
//! Rust guardrails on the parsed report (recompute the overall score from the
//! canonical weights, force a null score on un-analyzable calls, clamp the grade
//! band on any accuracy failure) so the headline number never depends on the
//! model doing arithmetic or self-policing correctly.

use serde::{Deserialize, Serialize};

const KEY_SERVICE: &str = "ai.bito.coldcallcoach";
const KEY_USER: &str = "anthropic_api_key";
const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 8192;
const KEY_USER_OPENAI: &str = "openai_api_key";
const OPENAI_URL: &str = "https://api.openai.com/v1/chat/completions";

/// Canonical per-dimension weights (what determines cold-call outcomes). The
/// overall score is recomputed in Rust from these — never trusted to the model.
const WEIGHTS: &[(&str, u32)] = &[
    ("next_step", 18),
    ("value_articulation_accuracy", 16),
    ("opener_pattern_interrupt", 12),
    ("reason_for_call", 11),
    ("discovery_questions", 10),
    ("objection_handling", 10),
    ("relevance_personalization", 8),
    ("permission_to_continue", 6),
    ("talk_listen_ratio", 5),
    ("tone_pace_filler", 4),
];

fn weight_for(key: &str) -> u32 {
    WEIGHTS.iter().find(|(k, _)| *k == key).map(|(_, w)| *w).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Context passed in from the JS loadContext() (non-secret config)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct Capability {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub proof_points: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Objection {
    pub objection: String,
    #[serde(default)]
    pub response: String,
}

#[derive(Deserialize)]
pub struct ContextInput {
    pub company: String,
    #[serde(default)]
    pub rep_name: String,
    #[serde(default)]
    pub value_oneliner: String,
    #[serde(default)]
    pub ideal_opener: String,
    #[serde(default)]
    pub catalog: Vec<Capability>,
    #[serde(default)]
    pub personas: Vec<String>,
    #[serde(default)]
    pub objections: Vec<Objection>,
    #[serde(default)]
    pub extra_context: String,
}

// ---------------------------------------------------------------------------
// The structured result (parsed from Claude, returned to the UI)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct EvidenceItem {
    pub idx: u32,
    pub speaker: String, // "You" | "Prospect"
    pub quote: String,
    #[serde(default)]
    pub tag: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct TalkMetrics {
    #[serde(default)]
    pub estimated_rep_talk_pct: Option<u32>,
    #[serde(default)]
    pub longest_rep_monologue_desc: Option<String>,
    #[serde(default)]
    pub prospect_engaged: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Dimension {
    pub key: String,
    pub label: String,
    /// 0-10, or None when status is insufficient_evidence / not_applicable.
    #[serde(default)]
    pub score: Option<u8>,
    pub status: String, // "scored" | "not_applicable" | "insufficient_evidence"
    #[serde(default)]
    pub confidence: String, // "high" | "medium" | "low"
    #[serde(default)]
    pub weight: u32,
    #[serde(default)]
    pub what_happened: String,
    #[serde(default)]
    pub evidence_idx: Vec<u32>,
    #[serde(default)]
    pub what_to_do_better: Option<String>,
    #[serde(default)]
    pub suggested_rephrasing: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ClaimAudit {
    pub claim_quote: String,
    #[serde(default)]
    pub evidence_idx: Vec<u32>,
    pub verdict: String, // accurate | overclaimed | wrong_metric | not_a_bito_capability | unverifiable
    #[serde(default)]
    pub matched_fact: Option<String>,
    #[serde(default)]
    pub correction: Option<String>,
}

/// One MEDDPICC line. The qualification scorecard is secondary to the coaching;
/// on a cold call most letters will be "missing", which is expected and honest.
#[derive(Serialize, Deserialize, Clone)]
pub struct MeddpiccItem {
    pub letter: String, // M | E | D | D | P | I | C | C
    pub status: String, // covered | weak | missing
    #[serde(default)]
    pub note: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct WentWell {
    pub point: String,
    #[serde(default)]
    pub evidence_idx: Vec<u32>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct HighestLeverageFix {
    pub title: String,
    pub dimension_key: String,
    #[serde(default)]
    pub what_happened: String,
    #[serde(default)]
    pub why_it_matters: String,
    #[serde(default)]
    pub do_this_instead: String,
    #[serde(default)]
    pub evidence_idx: Vec<u32>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PrioritizedFix {
    pub issue: String,
    #[serde(default)]
    pub do_this_instead: String,
    #[serde(default)]
    pub dimension_key: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct MissedOpportunity {
    pub signal: String,
    #[serde(default)]
    pub what_to_do: String,
    #[serde(default)]
    pub evidence_idx: Vec<u32>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CoachingReport {
    pub call_classification: String,
    pub analyzable: bool,
    #[serde(default)]
    pub confidence: String,
    #[serde(default)]
    pub headline: String,
    /// None on thin/voicemail calls — never a fabricated number.
    #[serde(default)]
    pub overall_score: Option<u8>,
    #[serde(default)]
    pub grade_band: String,
    #[serde(default)]
    pub score_basis: Vec<String>,
    #[serde(default)]
    pub evidence: Vec<EvidenceItem>,
    #[serde(default)]
    pub talk_metrics: TalkMetrics,
    #[serde(default)]
    pub dimensions: Vec<Dimension>,
    #[serde(default)]
    pub claim_audit: Vec<ClaimAudit>,
    /// MEDDPICC qualification snapshot (8 entries, M/E/D/D/P/I/C/C).
    #[serde(default)]
    pub meddpicc: Vec<MeddpiccItem>,
    #[serde(default)]
    pub what_went_well: Vec<WentWell>,
    /// Optional: may be None when analyzable is false and nothing is actionable.
    #[serde(default)]
    pub highest_leverage_fix: Option<HighestLeverageFix>,
    #[serde(default)]
    pub prioritized_fixes: Vec<PrioritizedFix>,
    #[serde(default)]
    pub missed_opportunities: Vec<MissedOpportunity>,
    #[serde(default)]
    pub drill: Option<String>,
    #[serde(default)]
    pub coaching_summary: String,
    #[serde(default)]
    pub caveats: Option<String>,
}

// ---------------------------------------------------------------------------
// Keychain (Windows Credential Manager via keyring)
// ---------------------------------------------------------------------------

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, KEY_USER).map_err(|e| format!("keychain error: {e}"))
}

pub fn read_api_key() -> Result<String, String> {
    let k = key_entry()?
        .get_password()
        .map_err(|_| "no Anthropic API key set — add it in Settings".to_string())?;
    if k.trim().is_empty() {
        return Err("the saved Anthropic API key is empty".into());
    }
    Ok(k)
}

pub fn save_api_key(key: &str) -> Result<(), String> {
    let k = key.trim();
    if k.is_empty() {
        return Err("API key is empty".into());
    }
    key_entry()?
        .set_password(k)
        .map_err(|e| format!("could not save key to keychain: {e}"))
}

pub fn has_api_key() -> bool {
    key_entry()
        .ok()
        .and_then(|e| e.get_password().ok())
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false)
}

fn openai_key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, KEY_USER_OPENAI).map_err(|e| format!("keychain error: {e}"))
}

pub fn read_openai_key() -> Result<String, String> {
    let k = openai_key_entry()?
        .get_password()
        .map_err(|_| "no OpenAI API key set — add it in Settings".to_string())?;
    if k.trim().is_empty() {
        return Err("the saved OpenAI API key is empty".into());
    }
    Ok(k)
}

pub fn save_openai_key(key: &str) -> Result<(), String> {
    let k = key.trim();
    if k.is_empty() {
        return Err("API key is empty".into());
    }
    openai_key_entry()?
        .set_password(k)
        .map_err(|e| format!("could not save key to keychain: {e}"))
}

pub fn has_openai_key() -> bool {
    openai_key_entry()
        .ok()
        .and_then(|e| e.get_password().ok())
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/// The Bito ground-truth catalog block ({bito_facts}) — same shape as generate.rs.
fn build_bito_facts(ctx: &ContextInput) -> String {
    let mut p = String::new();
    for c in &ctx.catalog {
        p.push_str(&format!("- {}: {}", c.name, c.description));
        if !c.proof_points.is_empty() {
            p.push_str(&format!(" Proof points: {}.", c.proof_points.join("; ")));
        }
        p.push('\n');
    }
    if p.is_empty() {
        p.push_str("(no catalog provided)\n");
    }
    p
}

/// The cold-call answer key ({extra_context}): one-line value prop, ideal opener,
/// and the objection→ideal-response pairs. Empty fields are omitted so the prompt
/// degrades gracefully.
fn build_extra_context(ctx: &ContextInput) -> String {
    let mut p = String::new();
    if !ctx.value_oneliner.trim().is_empty() {
        p.push_str(&format!("One-line value prop: {}\n", ctx.value_oneliner.trim()));
    }
    if !ctx.ideal_opener.trim().is_empty() {
        p.push_str(&format!(
            "Ideal opener (a model pattern-interrupt; the prospect/rep names are already filled in): {}\n",
            ctx.ideal_opener.trim()
        ));
    }
    let objs: Vec<&Objection> = ctx
        .objections
        .iter()
        .filter(|o| !o.objection.trim().is_empty())
        .collect();
    if !objs.is_empty() {
        p.push_str("Common objections + ideal responses (the objection-handling answer key):\n");
        for o in objs {
            p.push_str(&format!("- \"{}\" -> {}\n", o.objection.trim(), o.response.trim()));
        }
    }
    if !ctx.extra_context.trim().is_empty() {
        p.push_str(&format!("Additional notes: {}\n", ctx.extra_context.trim()));
    }
    if p.is_empty() {
        p.push_str("(no extra cold-call context provided — grade against the base catalog only)\n");
    }
    p
}

pub fn build_system_prompt(ctx: &ContextInput, prospect: &str, date: &str) -> String {
    let personas = if ctx.personas.is_empty() {
        "(none provided)".to_string()
    } else {
        ctx.personas.join(", ")
    };
    let prospect_disp = if prospect.trim().is_empty() {
        "unknown".to_string()
    } else {
        prospect.trim().to_string()
    };
    // Fills {rep} tokens inside the seeded ideal-opener (carried in via
    // {extra_context}) so the example opener renders concrete. Replaced AFTER
    // {extra_context} is inserted, by design.
    let rep = if ctx.rep_name.trim().is_empty() {
        "the rep".to_string()
    } else {
        ctx.rep_name.trim().to_string()
    };

    SYSTEM_TEMPLATE
        .replace("{company}", &ctx.company)
        .replace("{bito_facts}", &build_bito_facts(ctx))
        .replace("{personas}", &personas)
        .replace("{extra_context}", &build_extra_context(ctx))
        .replace("{prospect}", &prospect_disp)
        .replace("{rep}", &rep)
        .replace("{date}", date)
        .replace("{output_json_example}", OUTPUT_EXAMPLE)
}

fn build_user(transcript: &str, prospect: &str, date: &str, company: &str) -> String {
    let prospect_disp = if prospect.trim().is_empty() {
        "unknown"
    } else {
        prospect.trim()
    };
    format!(
        "Prospect: {prospect_disp}\nDate: {date}\n\nLabeled cold-call transcript (lines are [You] = the {company} rep being coached, [Prospect] = the person called):\n{transcript}\n\nClassify the call, build the evidence array, then return the coaching report as a single STRICT JSON object matching the schema. No prose, no markdown fences."
    )
}

// ---------------------------------------------------------------------------
// The Claude call + defensive parse + repair
// ---------------------------------------------------------------------------

async fn call_claude(key: &str, model: &str, system: &str, user: &str) -> Result<String, String> {
    let body = serde_json::json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": [{ "type": "text", "text": system, "cache_control": { "type": "ephemeral" } }],
        "messages": [{ "role": "user", "content": user }],
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(ANTHROPIC_URL)
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network error calling Claude: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("error reading Claude response: {e}"))?;

    if !status.is_success() {
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| truncate(&text, 300));
        return Err(format!("Claude API error ({}): {msg}", status.as_u16()));
    }

    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Claude response was not JSON: {e}"))?;
    let out = v["content"]
        .as_array()
        .and_then(|arr| {
            arr.iter().find_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str())
                } else {
                    None
                }
            })
        })
        .ok_or_else(|| "Claude response contained no text content".to_string())?;
    Ok(out.to_string())
}

/// True if `model` is an OpenAI model (vs an Anthropic/Claude one). Routing is by
/// name so a free-text model field "just works" for whatever ID OpenAI ships.
pub fn is_openai(model: &str) -> bool {
    let m = model.trim().to_ascii_lowercase();
    m.starts_with("gpt") || m.starts_with("chatgpt") || m.starts_with("o1") || m.starts_with("o3") || m.starts_with("o4")
}

/// OpenAI chat-completions call. `effort` (if non-empty) maps to reasoning_effort
/// (the instant/medium/high speed level). max_tokens is intentionally omitted so
/// the request shape stays valid across GPT-5.x variants.
async fn call_openai(
    key: &str,
    model: &str,
    effort: &str,
    system: &str,
    user: &str,
    json_mode: bool,
) -> Result<String, String> {
    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
    });
    if json_mode {
        body["response_format"] = serde_json::json!({ "type": "json_object" });
    }
    if !effort.trim().is_empty() {
        body["reasoning_effort"] = serde_json::json!(effort.trim());
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(OPENAI_URL)
        .header("authorization", format!("Bearer {key}"))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network error calling OpenAI: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("error reading OpenAI response: {e}"))?;

    if !status.is_success() {
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| truncate(&text, 300));
        return Err(format!("OpenAI API error ({}): {msg}", status.as_u16()));
    }

    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("OpenAI response was not JSON: {e}"))?;
    let out = v["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| "OpenAI response contained no message content".to_string())?;
    Ok(out.to_string())
}

/// Route an LLM call to OpenAI or Anthropic by model name. `key` is already the
/// right provider's key (the caller picks it via `is_openai`).
async fn call_llm(
    key: &str,
    model: &str,
    effort: &str,
    system: &str,
    user: &str,
    json_mode: bool,
) -> Result<String, String> {
    if is_openai(model) {
        call_openai(key, model, effort, system, user, json_mode).await
    } else {
        call_claude(key, model, system, user).await
    }
}

/// Strip markdown fences / preamble and slice to the outermost JSON braces.
pub fn extract_json(raw: &str) -> String {
    let mut t = raw.trim();
    if let Some(rest) = t.strip_prefix("```json") {
        t = rest.trim();
    } else if let Some(rest) = t.strip_prefix("```") {
        t = rest.trim();
    }
    t = t.trim_end_matches("```").trim();
    if let (Some(start), Some(end)) = (t.find('{'), t.rfind('}')) {
        if end >= start {
            return t[start..=end].to_string();
        }
    }
    t.to_string()
}

pub fn parse_report(raw: &str) -> Result<CoachingReport, String> {
    let json = extract_json(raw);
    serde_json::from_str::<CoachingReport>(&json).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Deterministic post-process guardrails (do NOT trust the model's arithmetic
// or self-policing — recompute the headline number + bands in Rust).
// ---------------------------------------------------------------------------

fn band_for(score: u8) -> &'static str {
    match score {
        80..=100 => "strong",
        60..=79 => "solid",
        40..=59 => "developing",
        _ => "needs_work",
    }
}

/// Rank for clamping: higher = better. Used only to cap a band downward.
fn band_rank(band: &str) -> u8 {
    match band {
        "strong" => 4,
        "solid" => 3,
        "developing" => 2,
        "needs_work" => 1,
        _ => 0, // insufficient_signal
    }
}

fn post_process(mut r: CoachingReport) -> CoachingReport {
    // Backfill the canonical weight for every dimension by key (don't trust the
    // model to echo weights correctly).
    for d in r.dimensions.iter_mut() {
        d.weight = weight_for(&d.key);
    }

    // Thin-call floor: a non-analyzable call can never carry a real number.
    if !r.analyzable {
        r.overall_score = None;
        r.grade_band = "insufficient_signal".to_string();
        r.score_basis.clear();
        // A thin / no-signal report must not carry a model-authored leverage fix.
        r.highest_leverage_fix = None;
        return r;
    }

    // Recompute the overall score from per-dimension scores + canonical weights,
    // over ONLY status=="scored" dimensions with a real score. Renormalize.
    let mut num = 0.0f64;
    let mut den = 0u32;
    let mut basis: Vec<String> = Vec::new();
    for d in &r.dimensions {
        if d.status == "scored" {
            if let Some(s) = d.score {
                let w = weight_for(&d.key);
                if w > 0 {
                    num += (w as f64) * (s.min(10) as f64) / 10.0;
                    den += w;
                    basis.push(d.key.clone());
                }
            }
        }
    }

    if den == 0 {
        // Analyzable but nothing actually scored — treat as no signal.
        r.overall_score = None;
        r.grade_band = "insufficient_signal".to_string();
        r.score_basis.clear();
        // A thin / no-signal report must not carry a model-authored leverage fix.
        r.highest_leverage_fix = None;
        return r;
    }

    let overall = (100.0 * num / den as f64).round().clamp(0.0, 100.0) as u8;
    r.overall_score = Some(overall);
    r.score_basis = basis;
    let mut band = band_for(overall).to_string();

    // Accuracy guardrail: any wrong_metric / not_a_bito_capability claim caps the
    // band at "developing" — a technical buyer who catches one false claim
    // discounts the rest.
    let accuracy_fail = r.claim_audit.iter().any(|c| {
        c.verdict == "wrong_metric" || c.verdict == "not_a_bito_capability"
    });
    if accuracy_fail && band_rank(&band) > band_rank("developing") {
        band = "developing".to_string();
    }
    r.grade_band = band;

    r
}

/// Assemble the prompt, call Claude, parse defensively with ONE repair pass, then
/// apply the deterministic guardrails. On any hard failure the caller keeps the
/// transcript so the user can retry — nothing is lost.
pub async fn run_coaching(
    key: &str,
    model: &str,
    effort: &str,
    ctx: &ContextInput,
    prospect: &str,
    date: &str,
    transcript: &str,
) -> Result<CoachingReport, String> {
    let system = build_system_prompt(ctx, prospect, date);
    let user = build_user(transcript, prospect, date, &ctx.company);

    let raw = call_llm(key, model, effort, &system, &user, true).await?;
    let report = match parse_report(&raw) {
        Ok(r) => r,
        Err(_) => {
            // One repair pass — the system prompt (with schema) is reused.
            let repair = format!(
                "Your previous reply was supposed to be a single valid JSON object matching the \
                 schema, but it failed to parse. Return ONLY the corrected JSON object — no prose, no \
                 markdown fences.\n\nPrevious reply:\n{raw}"
            );
            let raw2 = call_llm(key, model, effort, &system, &repair, true).await?;
            parse_report(&raw2)
                .map_err(|e| format!("the model returned invalid JSON even after a repair pass: {e}"))?
        }
    };

    Ok(post_process(report))
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

// ---------------------------------------------------------------------------
// Website → positioning (Settings auto-fill): fetch a company's own site and
// have Claude extract a structured positioning profile to seed the editable
// context. The extracted fields map 1:1 onto the editable ContextProfile.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct SiteContext {
    #[serde(default)]
    pub company: String,
    #[serde(default)]
    pub value_oneliner: String,
    #[serde(default)]
    pub ideal_opener: String,
    #[serde(default)]
    pub catalog: Vec<Capability>,
    #[serde(default)]
    pub personas: Vec<String>,
    #[serde(default)]
    pub objections: Vec<Objection>,
}

/// Crude HTML → text: drop <script>/<style> blocks, strip tags, decode a few
/// common entities, collapse whitespace, and cap length so the LLM call stays
/// cheap. Good enough to feed an extraction prompt.
fn html_to_text(html: &str) -> String {
    use regex::Regex;
    let script = Regex::new(r"(?is)<script[^>]*>.*?</script>").unwrap();
    let style = Regex::new(r"(?is)<style[^>]*>.*?</style>").unwrap();
    let tag = Regex::new(r"(?s)<[^>]+>").unwrap();
    let s = script.replace_all(html, " ");
    let s = style.replace_all(&s, " ");
    let s = tag.replace_all(&s, " ");
    let s = s
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate(&collapsed, 40_000)
}

/// Fetch a URL and reduce it to readable text.
async fn fetch_site_text(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; ColdCallCoach/0.1)")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("could not build HTTP client: {e}"))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("could not fetch {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("the site returned HTTP {}", resp.status().as_u16()));
    }
    let html = resp
        .text()
        .await
        .map_err(|e| format!("could not read the site body: {e}"))?;
    let text = html_to_text(&html);
    if text.trim().is_empty() {
        return Err("the page had no readable text (it may be a JS-only app)".into());
    }
    Ok(text)
}

/// Fetch a company's website and have Claude extract a positioning profile.
/// The URL fetch is the only outbound request beyond the Claude call.
pub async fn parse_company_site(
    key: &str,
    model: &str,
    effort: &str,
    url: &str,
) -> Result<SiteContext, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("enter a website URL first".into());
    }
    let normalized = if url.starts_with("http://") || url.starts_with("https://") {
        url.to_string()
    } else {
        format!("https://{url}")
    };
    let text = fetch_site_text(&normalized).await?;
    let user = format!(
        "Company website URL: {normalized}\n\nExtracted page text (may be truncated):\n{text}\n\nReturn ONLY the JSON object."
    );
    let raw = call_llm(key, model, effort, SITE_SYSTEM_TEMPLATE, &user, true).await?;
    let json = extract_json(&raw);
    serde_json::from_str::<SiteContext>(&json)
        .map_err(|e| format!("could not parse the model's positioning JSON: {e}"))
}

const SITE_SYSTEM_TEMPLATE: &str = r#"You are a B2B positioning analyst. From the text of a company's OWN website, extract a crisp, accurate positioning profile to seed a sales rep's call-context. You output STRICT JSON ONLY — no prose, no explanations, no markdown code fences.

Extract ONLY what the website actually supports. Do NOT invent capabilities, metrics, customers, integrations, or claims that are not on the page — leave a field short or empty rather than guessing. Proof points (metrics like "45% faster") must be taken from the page, never fabricated.

Return EXACTLY this JSON object (no extra keys, no markdown fences):
{
  "company": "<the company name>",
  "value_oneliner": "<one crisp, outcome-led sentence a busy buyer would repeat — the company's core value prop, in their framing>",
  "ideal_opener": "<a short, human cold-call opener a rep could use for this product; use {prospect} and {rep} as name placeholders>",
  "catalog": [
    { "name": "<product/capability name>", "description": "<one line>", "proof_points": ["<a metric/claim taken verbatim-ish from the site, or omit if none>"] }
  ],
  "personas": ["<the buyer roles this product targets, inferred from the site>"],
  "objections": [
    { "objection": "<a realistic objection for this product/category>", "response": "<an ideal response grounded ONLY in what the site supports>" }
  ]
}

Keep catalog to the 2-5 most important capabilities, personas to the roles the site implies, and objections to 2-4 realistic ones with grounded responses. Output the JSON object only."#;

// ---------------------------------------------------------------------------
// The prompt (designed via the design-cold-call-coach workflow). {placeholders}
// are filled by build_system_prompt via String::replace (NOT format!), so the
// literal braces in the JSON example below are safe.
// ---------------------------------------------------------------------------

const SYSTEM_TEMPLATE: &str = r#"You are the cold-call coaching engine for {company}, an enterprise software vendor selling AI developer-productivity tooling to engineering orgs. You receive ONE speaker-labeled transcript of a single cold call placed by a {company} sales rep, and you return ONE structured coaching report that evaluates how well the rep ran the call. This is POST-CALL feedback. You output STRICT JSON ONLY — no prose, no explanations, no markdown code fences, no trailing commentary.

The transcript lines are labeled [You] (the {company} sales rep being coached) and [Prospect] (the person they cold-called). Speaker labels are derived from separate audio sources (the rep's mic vs the prospect's voice on system audio) and are RELIABLE and load-bearing: a [Prospect] line can never be scored as the rep's behavior, and a [You] line can never be counted as a prospect pain, agreement, or objection. Today's date is {date}. The prospect, if known, is: {prospect}.

================ BITO GROUND-TRUTH CATALOG — THE ONLY ALLOWED SOURCE OF TRUTH ABOUT {company} ================
Everything below is a closed world. You may judge the rep's product claims ONLY against these facts. You must NEVER assert, confirm, correct with, or imply any {company} capability, metric, integration, or claim that is not present here — not to praise the rep, not to correct them, and not in any suggested rephrasing. If a rep claim cannot be matched to a fact below, it is 'unverifiable' — never 'accurate' and never 'inaccurate'.

## Solution catalog (capabilities + verbatim proof points)
{bito_facts}

## Buyer personas (for the relevance/personalization check)
{personas}

## The wedge
AI Architect (the codebase-intelligence knowledge graph) is the CORE WEDGE — nearly every capability ladders back to it. Reward a rep who correctly laddered value back to it; flag a rep who pitched standalone features the facts say depend on it.

## Extra cold-call context (one-line value prop, ideal opener, common objections + ideal responses)
{extra_context}
==============================================================================================================

WHAT TO PRODUCE
First CLASSIFY the call, then GRADE only what has signal.

call_classification is one of: real_conversation | voicemail | gatekeeper_only | immediate_decline | too_short | non_call_audio. Set analyzable=true ONLY for real_conversation (and for an immediate_decline that still contains a real exchange to judge graceful disengagement). voicemail, gatekeeper_only, too_short, and non_call_audio set analyzable=false.

THE EVIDENCE SPINE (this is how fabrication is made structurally impossible):
Before scoring anything, build a FLAT `evidence` array of the transcript lines you will cite: each item is { "idx": <int, 0-based>, "speaker": "You"|"Prospect", "quote": "<a VERBATIM substring of an actual transcript line>", "tag": "<optional short label, e.g. opener / objection / close>" }. Every quote MUST be copied verbatim from the transcript with the correct speaker. You must NEVER author a line into `evidence` that is not in the transcript. Then EVERY dimension score, every claim_audit row, every strength, and every missed opportunity references this array by `evidence_idx` (an array of ints). A scored dimension with an empty evidence_idx is invalid output.

THE RUBRIC — score each of these 10 dimensions 0-10, or null when there is insufficient evidence:
1. opener_pattern_interrupt — the first 1-3 [You] lines: human, non-scripted opener that honestly acknowledges the cold interruption and earns the next 20s, vs 'how are you today' / immediate pitch. Score only from the opener lines; null if the rep never spoke.
2. reason_for_call — a specific, credible, persona-relevant reason for calling THIS person now, stated early; a bare product name with no why-you-why-now does not count.
3. permission_to_continue — an explicit micro-ask AND honoring the answer. A graceful disengage on a hard 'no' scores HIGH here, not low.
4. value_articulation_accuracy — (a) crispness of value (outcome-led, ladders to AI Architect) AND (b) ACCURACY vs the catalog. ACCURACY GATES THE CEILING: any claim_audit verdict of wrong_metric or not_a_bito_capability caps this at 4; any overclaimed caps it at 6; 8-10 requires crisp value AND all checkable claims accurate. If the rep made NO product claims, set status=insufficient_evidence.
5. relevance_personalization — tailored to the persona's likely pains vs one-size; credit only personalization actually voiced.
6. discovery_questions — 2-4 sharp open questions that surface real pain; leading/rhetorical do not count.
7. objection_handling — acknowledge -> reframe -> clean re-ask, no arguing/caving/over-claiming. If NO objection occurred, status=not_applicable (NEVER invent one).
8. talk_listen_ratio — monologue bloat / failure to create space, from the line counts. Distinguish 'rep monologued' from 'prospect refused to engage'.
9. tone_pace_filler — TEXT-ONLY: filler, hedging, run-ons. Lowest weight. Must carry a 'text-only, approximate' caveat; never invent stammering not present.
10. next_step — exactly ONE specific, time-bound, PROSPECT-AGREED next step. A unilateral rep assertion is at most 'proposed', not 'secured'.

SCORING MODEL
Each dimension carries score (0-10 or null), status (scored | not_applicable | insufficient_evidence), and confidence (high|medium|low). overall_score (0-100) is the weighted average over ONLY status=scored dimensions, renormalized: round(100 * sum(weight_i * score_i/10) / sum(weight_i)). Weights: next_step 18, value_articulation_accuracy 16, opener_pattern_interrupt 12, reason_for_call 11, discovery_questions 10, objection_handling 10, relevance_personalization 8, permission_to_continue 6, talk_listen_ratio 5, tone_pace_filler 4. Emit score_basis = the keys that counted. grade_band derives from overall_score: strong 80-100 | solid 60-79 | developing 40-59 | needs_work 0-39 | insufficient_signal when null. ACCURACY GUARDRAIL: if any claim_audit verdict is wrong_metric or not_a_bito_capability, grade_band cannot exceed 'developing' and highest_leverage_fix MUST target the accuracy problem. (Note: the overall_score, grade_band, and score_basis are also recomputed deterministically after you respond — emit your best values, but the math is enforced server-side.)

THE BITO CLAIM AUDIT (the accuracy heart)
Extract EVERY product/value claim the [You] rep made about {company}, verbatim, and for each emit a row: { claim_quote, evidence_idx, verdict, matched_fact, correction }. verdict is one of:
- accurate — the claim matches a catalog capability or proof point.
- overclaimed — directionally right but inflated beyond the proof point (e.g. '70% faster PRs' when the fact is ~45%).
- wrong_metric — wrong number/metric/direction (e.g. attributing the ~89% merge-time figure to the wrong thing).
- not_a_bito_capability — pitched something {company} does not do per the catalog (e.g. 'we auto-fix and merge for you', 'we store your code in our cloud' contradicting the security posture).
- unverifiable — plausible but the facts neither confirm nor deny it.
matched_fact = the exact catalog capability/proof-point/security fact it maps to, or null. correction = drawn ONLY from the provided facts (a verbatim restatement of the real fact), null if accurate or unverifiable. If the rep made no product claims, emit an empty array (not null). NEVER invent the 'correct' number — only echo what the catalog provides.

TRANSCRIPTION CAVEAT (critical — the transcript is imperfect local speech-to-text)
This transcript is produced by LOCAL speech-to-text and routinely garbles proper nouns, ESPECIALLY the company/product name "{company}", which often appears as a homophone or near-miss (e.g. "{company}" heard as "Biddow", "Beato", or mis-split). The rep almost certainly SAID the name correctly. NEVER flag the rep for "mispronouncing" or "misstating" the brand based on the transcript's spelling, NEVER create a claim_audit row for a brand-name transcription artifact, and NEVER dock points for it. Treat any phonetically-plausible rendering of the company name AS "{company}". Apply the same leniency to garbled tool names, person names, and numbers that are obviously transcription noise — judge the rep on what they plainly meant, not the STT spelling.

THE MEDDPICC SCORECARD (a qualification snapshot — secondary to the coaching)
Also produce a "meddpicc" array of EXACTLY 8 entries, in this order and with these letters: M (Metrics), E (Economic buyer), D (Decision criteria), D (Decision process), P (Paper process), I (Identify pain), C (Champion), C (Competition). Each entry is { "letter", "status", "note" }: status is one of covered | weak | missing, and note is ONE grounded line. This is a COLD call — most elements will NOT have surfaced, so mark them "missing" honestly; NEVER invent qualification signal a transcript line doesn't support. Attribute correctly: a pain or buying signal counts only if a [Prospect] line states it, never a [You] pitch line. covered = clearly established on the call; weak = hinted/partial; missing = not surfaced (the norm on a cold call).

ACTION-FIRST REPORTING (this is what the rep actually reads)
- headline: one honest sentence in a coaching voice, defensible from the transcript.
- highest_leverage_fix: the SINGLE change with the biggest payoff next call — { title, dimension_key, what_happened (verbatim quote), why_it_matters (one line), do_this_instead (a concrete line the rep could say verbatim next time, strictly within {company} facts), evidence_idx }. Chosen as argmax over scored dimensions of weight*(10-score), UNLESS the accuracy guardrail forces it to the accuracy problem. May be null only when analyzable=false and nothing is actionable.
- dimensions[]: each of the 10 with { key, label, score, status, confidence, weight, what_happened (grounded observation or 'no evidence in transcript'), evidence_idx, what_to_do_better, suggested_rephrasing }.
- claim_audit[]: as above.
- meddpicc[]: exactly 8 entries (M, E, D, D, P, I, C, C in order) — see the MEDDPICC scorecard section.
- what_went_well[]: 1-3 specific, quoted strengths (never generic praise), each with evidence_idx.
- prioritized_fixes[]: up to 3 ordered fixes BEYOND the highest_leverage_fix, each { issue, do_this_instead, dimension_key }, ranked by impact.
- missed_opportunities[]: pains/buying-signals the [Prospect] raised that the rep didn't act on, each tied to a prospect line by evidence_idx (empty array if none).
- talk_metrics: { estimated_rep_talk_pct, longest_rep_monologue_desc, prospect_engaged } stated plainly so the headline ratio is auditable.
- drill: one optional one-line practice rep tied to the highest_leverage_fix (null if none).
- coaching_summary: 2-4 honest, motivating sentences the rep reads first.
- caveats: REQUIRED when analyzable=false OR overall confidence is low — a plain-language statement of why the report is thin and what it can/can't conclude.

HARD ANTI-HALLUCINATION RULES (the #1 risk — follow exactly)
1. Every score, observation, strength, missed opportunity, and claim_audit row MUST reference at least one entry in `evidence` by evidence_idx. A scored dimension with empty evidence_idx is invalid. Prefer verbatim quotes over paraphrase.
2. `evidence` quotes are VERBATIM substrings of transcript lines, tagged with the correct speaker ([You]->'You', [Prospect]->'Prospect'). Never author a line into evidence. Misattributing a speaker is a hard error.
3. suggested_rephrasing, do_this_instead, and drill are the COACH's recommendations — frame them as suggestions, never as something the rep actually said, and never insert them into `evidence`. They must stay strictly within {company} facts and may not promise outcomes/metrics/features absent from the catalog (a model line may quote a real proof point but may not improve on it).
4. {company} accuracy is judged ONLY against the catalog/proof-points/personas/security posture above. You are FORBIDDEN from introducing any {company} capability, metric, integration, or claim not present there — including in any correction field. A claim you cannot check is 'unverifiable', not a guess.
5. Never report a next step, booked meeting, agreement, objection, attendee, title, company, date, or pricing that a specific transcript line does not state. A next step is 'secured' only if a [Prospect] line agrees; absence of a stage is 'missing'/'insufficient_evidence', never backfilled.
6. No prosody claims: tone_pace_filler and all tonal notes are TEXT-ONLY (filler words, hedging, run-ons) and must disclaim that vocal tone/pace are not directly observable.
7. Do not invent the prospect's identity, seniority, or pains. Judge relevance only from what the prospect revealed or the rep voiced; if the role is unknown, judge conservatively and lower confidence.
8. Use null / insufficient_evidence / not_applicable LIBERALLY and without penalty when signal is thin — absent dimensions are EXCLUDED from the average, never scored 0. Fabricating a plausible-but-unsupported score is the worst possible failure; an honest null is correct.
9. If analyzable=false (voicemail, gatekeeper_only, too_short, non_call_audio), DO NOT emit any status=scored dimension or a non-null overall_score. Produce the degraded shape: overall_score=null, grade_band='insufficient_signal', the gradeable fragments only (a voicemail's opener and any real Bito claims CAN still be claim-audited and noted), and a populated caveats string. A full scorecard on a voicemail is a hallucination.
10. Output STRICT JSON ONLY matching the schema below — no prose, no markdown fences.

OUTPUT — return EXACTLY this JSON object (same keys, no markdown fences):
{output_json_example}"#;

const OUTPUT_EXAMPLE: &str = r#"{
  "call_classification": "<one of: real_conversation | voicemail | gatekeeper_only | immediate_decline | too_short | non_call_audio>",
  "analyzable": "<bool — true only when there is a real exchange to score; false for voicemail/gatekeeper/too_short/non_call_audio>",
  "confidence": "<high|medium|low — overall confidence given how much transcript signal backed the report>",
  "headline": "<one honest coaching-voice sentence, defensible from the transcript>",
  "overall_score": "<int 0-100, or null when analyzable is false / too thin>",
  "grade_band": "<strong|solid|developing|needs_work|insufficient_signal — derived from overall_score, never independent>",
  "score_basis": ["<dimension keys that were status=scored and actually counted toward overall_score>"],
  "evidence": [
    { "idx": 0, "speaker": "<You|Prospect>", "quote": "<VERBATIM substring of a transcript line>", "tag": "<optional short label e.g. opener/objection/close>" }
  ],
  "talk_metrics": {
    "estimated_rep_talk_pct": "<int 0-100 estimated from line/word counts, or null if not derivable>",
    "longest_rep_monologue_desc": "<plain description e.g. 'one ~40s unbroken stretch in the pitch', or null>",
    "prospect_engaged": "<bool — did the prospect meaningfully participate>"
  },
  "dimensions": [
    {
      "key": "<one of the 10 rubric keys>",
      "label": "<human label>",
      "score": "<int 0-10, or null when insufficient evidence>",
      "status": "<scored|not_applicable|insufficient_evidence>",
      "confidence": "<high|medium|low>",
      "weight": "<the fixed weight for this dimension>",
      "what_happened": "<grounded observation, or 'no evidence in transcript'>",
      "evidence_idx": ["<ints into the evidence array; required and non-empty when status=scored>"],
      "what_to_do_better": "<concrete next-time guidance, or null when scored well / N/A>",
      "suggested_rephrasing": "<a better line the rep could say verbatim, within Bito facts, or null>"
    }
  ],
  "claim_audit": [
    {
      "claim_quote": "<verbatim Bito claim the [You] rep made>",
      "evidence_idx": ["<ints into the evidence array>"],
      "verdict": "<accurate|overclaimed|wrong_metric|not_a_bito_capability|unverifiable>",
      "matched_fact": "<the catalog capability/proof-point/security fact it maps to, or null>",
      "correction": "<facts-only restatement of the real fact; null if accurate or unverifiable>"
    }
  ],
  "meddpicc": [
    { "letter": "<M|E|D|D|P|I|C|C, in that order>", "status": "<covered|weak|missing>", "note": "<one grounded line; 'missing' if not surfaced>" }
  ],
  "what_went_well": [
    { "point": "<specific strength, never generic praise>", "evidence_idx": ["<ints>"] }
  ],
  "highest_leverage_fix": {
    "title": "<short title of the single biggest-payoff change>",
    "dimension_key": "<the rubric key it maps to>",
    "what_happened": "<verbatim quote of the moment>",
    "why_it_matters": "<one line on why this is the highest leverage here>",
    "do_this_instead": "<a concrete line the rep could say verbatim next time, strictly within Bito facts>",
    "evidence_idx": ["<ints>"]
  },
  "prioritized_fixes": [
    { "issue": "<the problem>", "do_this_instead": "<concrete rephrasing or drill>", "dimension_key": "<rubric key>" }
  ],
  "missed_opportunities": [
    { "signal": "<a pain/buying-signal the [Prospect] raised>", "what_to_do": "<how the rep should have acted>", "evidence_idx": ["<ints to a Prospect line>"] }
  ],
  "drill": "<one one-line practice rep tied to the highest_leverage_fix, or null>",
  "coaching_summary": "<2-4 honest, motivating sentences the rep reads first>",
  "caveats": "<plain-language statement of what this report could NOT assess and why; required when analyzable is false or confidence is low, else null>"
}"#;
