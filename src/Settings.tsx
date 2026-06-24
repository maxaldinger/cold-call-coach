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
  const [model, setModel] = useState(() => localStorage.getItem("ccc.model") || "claude-sonnet-4-6");
  const [aec, setAec] = useState(() => localStorage.getItem("ccc.aec") === "1");

  // Website auto-fill (Settings → drop a URL → LLM fills the positioning fields).
  const [siteUrl, setSiteUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<string | null>(null);

  useEffect(() => {
    invoke<boolean>("has_api_key")
      .then(setKeyPresent)
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
  const onAec = (v: boolean) => {
    setAec(v);
    localStorage.setItem("ccc.aec", v ? "1" : "0");
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
      const model = localStorage.getItem("ccc.model") || "claude-sonnet-4-6";
      const s = await invoke<SiteContext>("parse_company_site", { url, model });
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

        <Field label="Model" hint="Default Sonnet 4.6. Bump to Opus 4.8 for max-quality coaching.">
          <select className="device-select" value={model} onChange={(e) => onModel(e.target.value)}>
            <option value="claude-sonnet-4-6">claude-sonnet-4-6 (default)</option>
            <option value="claude-opus-4-8">claude-opus-4-8 (max quality)</option>
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
