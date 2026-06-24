import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Capability, ContextProfile, Objection, saveProfile } from "./context";

// Mirrors the Rust coaching::SiteContext returned by parse_company_site.
interface SiteContext {
  company: string;
  value_oneliner: string;
  ideal_opener: string;
  catalog: Capability[];
  personas: string[];
  objections: Objection[];
}

// Curated model presets for the scoring call. The backend routes by name
// (gpt*/o* → OpenAI, claude-* → Anthropic), so any ID works — these are just the
// sensible picks. "Custom…" reveals a free-text field for anything else.
// Verified against OpenAI's lineup (June 2026): the fast/cheap tier is GPT-5.4
// (mini/nano) — there is no gpt-5.5-mini/nano. gpt-5.4-mini is the default: fast,
// cheap, and reliable on the strict-JSON rubric; nano is cheapest/fastest but
// shakier on the harder bits (claim audit, MEDDPICC, voicemail detection).
interface ModelPreset {
  id: string;
  label: string;
  note: string;
}
const MODEL_PRESETS: ModelPreset[] = [
  { id: "gpt-5.4-nano", label: "GPT-5.4 nano", note: "Fastest & cheapest — may need a retry on the strict JSON" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini  ·  recommended", note: "Fast, cheap, reliable for scoring — the default" },
  { id: "gpt-5.4", label: "GPT-5.4", note: "Sharper judgment, a bit slower and pricier" },
  { id: "gpt-5.5", label: "GPT-5.5", note: "Best coaching quality, slowest and priciest" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", note: "Anthropic — fast; needs your Anthropic key" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", note: "Anthropic — high quality; needs your Anthropic key" },
];
const CUSTOM_MODEL = "__custom__";

export function Settings({
  profile,
  onSaved,
  onClose,
}: {
  profile: ContextProfile;
  onSaved: (p: ContextProfile) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ContextProfile>(profile);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // API key + model are app config, separate from the company-context draft.
  // The key is write-only (→ OS keychain via set_api_key); we only ever learn
  // whether one exists, never read it back. The model preference lives in
  // localStorage so the analyze flow can pick it up without a round-trip.
  const [keyInput, setKeyInput] = useState("");
  const [keyPresent, setKeyPresent] = useState(false);
  const [keyMsg, setKeyMsg] = useState<string | null>(null);
  const [openaiKeyInput, setOpenaiKeyInput] = useState("");
  const [openaiKeyPresent, setOpenaiKeyPresent] = useState(false);
  const [openaiKeyMsg, setOpenaiKeyMsg] = useState<string | null>(null);
  const [model, setModel] = useState(() => localStorage.getItem("ccc.model") || "gpt-5.4-mini");
  // When the saved model isn't one of the presets, drop into free-text mode.
  const [customModel, setCustomModel] = useState(
    () => !MODEL_PRESETS.some((p) => p.id === (localStorage.getItem("ccc.model") || "gpt-5.4-mini")),
  );
  const [effort, setEffort] = useState(() => localStorage.getItem("ccc.effort") || "low");
  const [aec, setAec] = useState(() => localStorage.getItem("ccc.aec") === "1");

  // Website auto-fill (Settings → drop a URL → LLM fills the positioning fields).
  const [siteUrl, setSiteUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<string | null>(null);

  // Working hours — when the call pet expects you dialing (it only decays then).
  const [workStart, setWorkStart] = useState(() => localStorage.getItem("ccc.workStart") || "9");
  const [workEnd, setWorkEnd] = useState(() => localStorage.getItem("ccc.workEnd") || "17");
  const [workWeekends, setWorkWeekends] = useState(
    () => localStorage.getItem("ccc.workWeekends") === "1",
  );

  useEffect(() => {
    invoke<boolean>("has_api_key")
      .then(setKeyPresent)
      .catch(() => {});
    invoke<boolean>("has_openai_key")
      .then(setOpenaiKeyPresent)
      .catch(() => {});
  }, []);

  const saveKey = async () => {
    setKeyMsg(null);
    try {
      await invoke("set_api_key", { key: keyInput.trim() });
      setKeyPresent(true);
      setKeyInput("");
      setKeyMsg("Saved to your OS keychain.");
    } catch (e) {
      setKeyMsg(String(e));
    }
  };
  const onModel = (m: string) => {
    setModel(m);
    localStorage.setItem("ccc.model", m);
  };
  const onModelSelect = (v: string) => {
    if (v === CUSTOM_MODEL) {
      setCustomModel(true); // keep the current id; let them type a new one
    } else {
      setCustomModel(false);
      onModel(v);
    }
  };
  const onAec = (v: boolean) => {
    setAec(v);
    localStorage.setItem("ccc.aec", v ? "1" : "0");
  };
  const onEffort = (e: string) => {
    setEffort(e);
    localStorage.setItem("ccc.effort", e);
  };
  const saveOpenaiKey = async () => {
    setOpenaiKeyMsg(null);
    try {
      await invoke("set_openai_key", { key: openaiKeyInput.trim() });
      setOpenaiKeyPresent(true);
      setOpenaiKeyInput("");
      setOpenaiKeyMsg("Saved to your OS keychain.");
    } catch (e) {
      setOpenaiKeyMsg(String(e));
    }
  };

  const autofill = async () => {
    const url = siteUrl.trim();
    if (!url) {
      setFetchMsg("Enter your website URL first.");
      return;
    }
    setFetching(true);
    setFetchMsg(null);
    try {
      const model = localStorage.getItem("ccc.model") || "gpt-5.4-mini";
      const effort = localStorage.getItem("ccc.effort") || "low";
      const s = await invoke<SiteContext>("parse_company_site", { url, model, effort });
      // Fill what came back; keep existing values where the site gave nothing.
      setDraft((d) => ({
        ...d,
        company: s.company?.trim() || d.company,
        value_oneliner: s.value_oneliner?.trim() || d.value_oneliner,
        ideal_opener: s.ideal_opener?.trim() || d.ideal_opener,
        catalog: s.catalog && s.catalog.length ? s.catalog : d.catalog,
        personas: s.personas && s.personas.length ? s.personas : d.personas,
        objections: s.objections && s.objections.length ? s.objections : d.objections,
      }));
      setSaved(false);
      setFetchMsg("Filled from your site — review the fields below, then Save.");
    } catch (e) {
      setFetchMsg(String(e));
    } finally {
      setFetching(false);
    }
  };

  const set = (patch: Partial<ContextProfile>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setSaved(false);
  };

  const setCap = (i: number, patch: Partial<Capability>) =>
    set({ catalog: draft.catalog.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const addCap = () =>
    set({ catalog: [...draft.catalog, { name: "", description: "", proof_points: [] }] });
  const removeCap = (i: number) => set({ catalog: draft.catalog.filter((_, j) => j !== i) });

  const setObj = (i: number, patch: Partial<Objection>) =>
    set({ objections: draft.objections.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  const addObj = () => set({ objections: [...draft.objections, { objection: "", response: "" }] });
  const removeObj = (i: number) => set({ objections: draft.objections.filter((_, j) => j !== i) });

  // Drop empties + trim before persisting.
  const clean = (p: ContextProfile): ContextProfile => ({
    ...p,
    catalog: p.catalog
      .map((c) => ({ ...c, proof_points: c.proof_points.map((s) => s.trim()).filter(Boolean) }))
      .filter((c) => c.name.trim() || c.description.trim()),
    personas: p.personas.map((s) => s.trim()).filter(Boolean),
    objections: p.objections
      .map((o) => ({ objection: o.objection.trim(), response: o.response.trim() }))
      .filter((o) => o.objection || o.response),
  });

  const save = async () => {
    setSaving(true);
    setError(null);
    const cleaned = clean(draft);
    try {
      await saveProfile(cleaned);
      setDraft(cleaned);
      onSaved(cleaned);
      setSaved(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings">
      <div className="settings-head">
        <div>
          <h2>Bito context</h2>
          <p className="settings-sub">
            Powers the coaching — the value the coach grades your pitch against, and the objection
            answer key. Seeded with Bito; edit anytime.
          </p>
        </div>
        <div className="settings-actions">
          {saved && <span className="saved-pill">Saved</span>}
          <button className="ghost-btn" onClick={onClose}>
            Close
          </button>
          <button className="save-btn" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          Could not save: <code>{error}</code>
        </div>
      )}

      <div className="settings-body">
        <div className="field key-field">
          <label className="field-label">Anthropic API key</label>
          <p className="field-hint">
            Stored in your OS keychain (Windows Credential Manager) — never in the database, the
            source, or a file. The key stays in Rust; it never enters this window.{" "}
            {keyPresent ? "✓ A key is currently saved." : "No key saved yet — scoring a call needs one."}
          </p>
          <div className="card-row">
            <input
              className="s-input"
              type="password"
              autoComplete="off"
              placeholder={keyPresent ? "•••••• saved — paste a new key to replace" : "sk-ant-…"}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <button className="ghost-btn" onClick={saveKey} disabled={!keyInput.trim()}>
              Save key
            </button>
          </div>
          {keyMsg && <p className="field-hint key-msg">{keyMsg}</p>}
        </div>

        <div className="field key-field">
          <label className="field-label">OpenAI API key</label>
          <p className="field-hint">
            Needed for GPT models (e.g. gpt-5.4-mini). Stored in your OS keychain, same as above.{" "}
            {openaiKeyPresent ? "✓ A key is currently saved." : "No key saved yet."}
          </p>
          <div className="card-row">
            <input
              className="s-input"
              type="password"
              autoComplete="off"
              placeholder={openaiKeyPresent ? "•••••• saved — paste a new key to replace" : "sk-…"}
              value={openaiKeyInput}
              onChange={(e) => setOpenaiKeyInput(e.target.value)}
            />
            <button className="ghost-btn" onClick={saveOpenaiKey} disabled={!openaiKeyInput.trim()}>
              Save key
            </button>
          </div>
          {openaiKeyMsg && <p className="field-hint key-msg">{openaiKeyMsg}</p>}
        </div>

        <Field
          label="Model"
          hint="Which model scores your calls. GPT routes to OpenAI, Claude to Anthropic — set the matching API key above. gpt-5.4-mini is the recommended default: fast, cheap, and reliable on the scoring rubric."
        >
          <select
            className="device-select"
            value={customModel ? CUSTOM_MODEL : model}
            onChange={(e) => onModelSelect(e.target.value)}
          >
            {MODEL_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value={CUSTOM_MODEL}>Custom…</option>
          </select>
          {customModel ? (
            <input
              className="s-input"
              style={{ marginTop: 8 }}
              value={model}
              onChange={(e) => onModel(e.target.value)}
              placeholder="gpt-5.4-mini"
              spellCheck={false}
            />
          ) : (
            <p className="field-hint" style={{ marginTop: 6, marginBottom: 0 }}>
              {MODEL_PRESETS.find((p) => p.id === model)?.note}
            </p>
          )}
        </Field>

        <Field
          label="Level"
          hint="OpenAI reasoning effort — Instant = fastest/cheapest, High = most thorough. (Ignored by Claude models.)"
        >
          <select className="device-select" value={effort} onChange={(e) => onEffort(e.target.value)}>
            <option value="low">Instant (fastest)</option>
            <option value="medium">Medium</option>
            <option value="high">High (most thorough)</option>
          </select>
        </Field>

        <Field
          label="Not wearing headphones?"
          hint="First-pass acoustic echo cancellation: cancels the prospect's voice bleeding into your mic so their words aren't double-counted as yours. Applied when you run a “Clean + de-echo” pass after the call. Leave OFF if you wear headphones (no bleed to cancel)."
        >
          <label className="toggle-row">
            <input type="checkbox" checked={aec} onChange={(e) => onAec(e.target.checked)} />
            <span>Cancel the prospect's bleed from my mic</span>
          </label>
        </Field>

        <Field
          label="Working hours"
          hint="When your call pet expects you dialing (24-hour). It only gets hungry during these hours and naps evenings/weekends."
        >
          <div className="card-row work-hours">
            <input
              className="s-input work-hour"
              type="number"
              min={0}
              max={23}
              value={workStart}
              onChange={(e) => {
                setWorkStart(e.target.value);
                localStorage.setItem("ccc.workStart", e.target.value);
              }}
            />
            <span className="work-sep">to</span>
            <input
              className="s-input work-hour"
              type="number"
              min={1}
              max={24}
              value={workEnd}
              onChange={(e) => {
                setWorkEnd(e.target.value);
                localStorage.setItem("ccc.workEnd", e.target.value);
              }}
            />
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={workWeekends}
                onChange={(e) => {
                  setWorkWeekends(e.target.checked);
                  localStorage.setItem("ccc.workWeekends", e.target.checked ? "1" : "0");
                }}
              />
              <span>include weekends</span>
            </label>
          </div>
        </Field>

        <div className="field shorthand-callout">
          <div className="callout-head">
            <span className="callout-badge">AUTO-FILL</span>
            <div>
              <label className="field-label">Fill positioning from your website</label>
              <p className="field-hint">
                Paste your company site URL — an LLM reads it and fills in the value prop,
                capabilities, personas, and objections below. Review and Save afterward. Uses your
                API key + one Claude call.
              </p>
            </div>
          </div>
          <div className="card-row">
            <input
              className="s-input"
              placeholder="https://bito.ai"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              disabled={fetching}
            />
            <button className="ghost-btn" onClick={autofill} disabled={fetching || !siteUrl.trim()}>
              {fetching ? "Reading…" : "Auto-fill"}
            </button>
          </div>
          {fetchMsg && <p className="field-hint key-msg">{fetchMsg}</p>}
        </div>

        <Field label="Company">
          <input
            className="s-input"
            value={draft.company}
            onChange={(e) => set({ company: e.target.value })}
          />
        </Field>

        <Field label="Your name" hint="Fills {rep} in the ideal opener; addresses the coaching to you.">
          <input
            className="s-input"
            placeholder="e.g. Max Aldinger"
            value={draft.rep_name}
            onChange={(e) => set({ rep_name: e.target.value })}
          />
        </Field>

        <Field
          label="One-line value prop"
          hint="The crisp, outcome-led pitch a busy eng leader would repeat. The coach grades your value articulation against this and only suggests rephrasings within it."
        >
          <textarea
            className="s-textarea"
            rows={3}
            value={draft.value_oneliner}
            onChange={(e) => set({ value_oneliner: e.target.value })}
          />
        </Field>

        <Field
          label="Ideal opener"
          hint="A model pattern-interrupt opener. {prospect} and {rep} are illustrative fill-ins. Anchors the opener + permission scoring."
        >
          <textarea
            className="s-textarea"
            rows={3}
            value={draft.ideal_opener}
            onChange={(e) => set({ ideal_opener: e.target.value })}
          />
        </Field>

        <Section
          title="Solution catalog"
          hint="What Bito actually does — the ONLY source of truth the coach checks your product claims against. Keep it accurate."
          onAdd={addCap}
          addLabel="+ Capability"
        >
          {draft.catalog.map((cap, i) => (
            <div className="card" key={i}>
              <div className="card-row">
                <input
                  className="s-input"
                  placeholder="Capability name"
                  value={cap.name}
                  onChange={(e) => setCap(i, { name: e.target.value })}
                />
                <button className="x-btn" onClick={() => removeCap(i)} title="Remove">
                  ×
                </button>
              </div>
              <textarea
                className="s-textarea"
                rows={2}
                placeholder="Description"
                value={cap.description}
                onChange={(e) => setCap(i, { description: e.target.value })}
              />
              <textarea
                className="s-textarea mono"
                rows={2}
                placeholder="Proof points (one per line) — e.g. PRs close ~45% faster"
                value={cap.proof_points.join("\n")}
                onChange={(e) => setCap(i, { proof_points: e.target.value.split("\n") })}
              />
            </div>
          ))}
        </Section>

        <Section
          title="Common objections → ideal responses"
          hint="The objection-handling answer key. The coach grades how you handled pushback against these, and only suggests responses within Bito's real facts."
          onAdd={addObj}
          addLabel="+ Objection"
        >
          {draft.objections.map((o, i) => (
            <div className="card" key={i}>
              <div className="card-row">
                <input
                  className="s-input"
                  placeholder="Objection — e.g. We already use Copilot"
                  value={o.objection}
                  onChange={(e) => setObj(i, { objection: e.target.value })}
                />
                <button className="x-btn" onClick={() => removeObj(i)} title="Remove">
                  ×
                </button>
              </div>
              <textarea
                className="s-textarea"
                rows={2}
                placeholder="Ideal response"
                value={o.response}
                onChange={(e) => setObj(i, { response: e.target.value })}
              />
            </div>
          ))}
        </Section>

        <Field label="ICP / personas" hint="One per line. Who you cold-call — used to grade relevance/personalization.">
          <textarea
            className="s-textarea"
            rows={4}
            value={draft.personas.join("\n")}
            onChange={(e) => set({ personas: e.target.value.split("\n") })}
          />
        </Field>

        <Field
          label="Extra coaching context"
          hint="Anything else the coach should know — current campaign, a promo, a competitor to watch for. Optional."
        >
          <textarea
            className="s-textarea"
            rows={4}
            placeholder="e.g. This quarter we're leading with onboarding/ramp for teams scaling headcount."
            value={draft.extra_context}
            onChange={(e) => set({ extra_context: e.target.value })}
          />
        </Field>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {hint && <p className="field-hint">{hint}</p>}
      {children}
    </div>
  );
}

function Section({
  title,
  hint,
  onAdd,
  addLabel,
  children,
}: {
  title: string;
  hint?: string;
  onAdd: () => void;
  addLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <div className="section-head">
        <div>
          <label className="field-label">{title}</label>
          {hint && <p className="field-hint">{hint}</p>}
        </div>
        <button className="ghost-btn" onClick={onAdd}>
          {addLabel}
        </button>
      </div>
      <div className="cards">{children}</div>
    </div>
  );
}
