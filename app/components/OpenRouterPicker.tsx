// Settings → OpenRouter. Browses the whole OpenRouter catalogue — every model it
// fronts, sorted into price tiers with Free first, because free is the reason this
// tab exists. Filter by tier, vendor and capability, then set one as the model the
// OpenRouter runner uses.
import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { RefreshCw, Search } from "lucide-react";
import { Select } from "./Select";

interface OrModel {
  id: string;
  name: string;
  vendor: string;
  vendorLabel: string;
  blurb: string;
  tier: "free" | "router" | "budget" | "standard" | "premium";
  free: boolean;
  inUsd: number | null;
  outUsd: number | null;
  context: number;
  maxOutput: number | null;
  vision: boolean;
  audio: boolean;
  tools: boolean;
  reasoning: boolean;
  jsonMode: boolean;
  intelligence: number | null;
  created: number;
}

interface Catalog {
  models: OrModel[];
  tiers: { id: string; label: string; blurb: string }[];
  vendors: { id: string; label: string; count: number }[];
  counts: { total: number; free: number };
  fetchedAt: string;
  stale: boolean;
  error?: string;
}

const CAPS = [
  { id: "jsonMode", label: "JSON mode", hint: "Honours response_format — best for résumé + match work" },
  { id: "tools", label: "Tools", hint: "Supports tool / function calling" },
  { id: "reasoning", label: "Reasoning", hint: "Exposes a thinking budget" },
  { id: "vision", label: "Vision", hint: "Accepts images" },
  { id: "long", label: "200K+ context", hint: "Fits a long job description plus your whole résumé" },
] as const;
type Cap = (typeof CAPS)[number]["id"];

const PAGE = 60;

function fmtContext(n: number): string {
  if (!n) return "—";
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function fmtUsd(n: number | null): string {
  if (n === null) return "var";
  if (n === 0) return "0";
  if (n < 0.01) return n.toFixed(4).replace(/0+$/, "");
  if (n < 1) return n.toFixed(2);
  return n < 10 ? n.toFixed(1) : String(Math.round(n));
}

function price(m: OrModel): string {
  if (m.free) return "FREE";
  if (m.inUsd === null || m.outUsd === null) return "varies";
  return `$${fmtUsd(m.inUsd)} / $${fmtUsd(m.outUsd)}`;
}

export function OpenRouterPicker({
  selected,
  freeOnly,
  freeFallback,
  fallbacks,
  hasKey,
}: {
  selected: string;
  freeOnly: boolean;
  freeFallback: boolean;
  fallbacks: string;
  hasKey: boolean;
}) {
  const fetcher = useFetcher();
  const save = useFetcher();
  const [tier, setTier] = useState<string>("free");
  const [vendor, setVendor] = useState("");
  const [caps, setCaps] = useState<Cap[]>([]);
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);

  // load once on mount; the route answers from the disk cache, so this is cheap
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    fetcher.load("/api/openrouter");
  }, [fetcher]);

  const cat = fetcher.data as Catalog | undefined;
  const loading = fetcher.state === "loading";
  // the model the runner will use right now — the saved one, or whatever we just set
  const current = (save.formData?.get("model") as string) || selected;

  const shown = useMemo(() => {
    const all = cat?.models ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((m) => {
      if (tier !== "all" && m.tier !== tier) return false;
      if (vendor && m.vendor !== vendor) return false;
      for (const c of caps) {
        if (c === "long" ? m.context < 200_000 : !m[c]) return false;
      }
      if (needle && !`${m.id} ${m.name} ${m.blurb}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [cat, tier, vendor, caps, q]);

  useEffect(() => setLimit(PAGE), [tier, vendor, caps, q]);

  const toggleCap = (c: Cap) => setCaps((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));

  // this tab submits through fetchers so picking a model does not throw you back to
  // the Runners tab — which means the route's actionData never fires, and the
  // confirmation has to come from the fetcher itself
  const msg = (save.data as { ok?: boolean; msg?: string } | undefined)?.msg;

  return (
    <>
      {msg && save.state === "idle" && <div className="notice ok">{msg}</div>}
      <div className="panel">
        <h3>Run the Ledger for free</h3>
        <p className="hint">
          One key, every major lab — and a tier that costs nothing per token
        </p>
        <p style={{ marginTop: 0 }}>
          OpenRouter puts {cat ? cat.counts.total : "hundreds of"} models behind a single endpoint, and{" "}
          <strong>{cat ? cat.counts.free : "a number"} of them are free to call</strong>. A free key is
          enough to crawl jobs, tailor a r&eacute;sum&eacute;, write a cover letter and run interview prep
          &mdash; the whole Ledger, at $0. Get one at{" "}
          <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="entry-title-link">
            openrouter.ai/keys
          </a>
          , then paste it below. Free models are rate-limited rather than metered, so they are slower
          under load, not billed.
        </p>

        <save.Form method="post" className="field" style={{ display: "grid", gridTemplateColumns: "150px 1fr auto auto", gap: 10, alignItems: "end" }}>
          <label style={{ margin: 0 }}>
            OpenRouter key {hasKey ? <span className="badge ok">set</span> : <span className="badge off">unset</span>}
          </label>
          <input type="password" name="value" placeholder={hasKey ? "•••••••• (saved)" : "sk-or-v1-…"} autoComplete="off" />
          <input type="hidden" name="name" value="openrouter_api_key" />
          <button className="ghost-btn" name="intent" value="set-key">Save</button>
          <button className="ghost-btn" name="intent" value="clear-key">Clear</button>
        </save.Form>
      </div>

      <save.Form method="post" className="panel">
        <input type="hidden" name="intent" value="openrouter-save" />
        <h3>How OpenRouter spends</h3>
        <p className="hint">Guardrails for the free tier</p>
        <div className="field">
          <label style={{ margin: 0, textTransform: "none", letterSpacing: 0, fontSize: 13 }}>
            <input type="checkbox" name="openrouter_free_only" defaultChecked={freeOnly} /> Free models
            only &mdash; refuse any OpenRouter model that charges per token
          </label>
        </div>
        <div className="field">
          <label style={{ margin: 0, textTransform: "none", letterSpacing: 0, fontSize: 13 }}>
            <input type="checkbox" name="openrouter_free_fallback" defaultChecked={freeFallback} /> When a
            free model is rate-limited, automatically try the next free model
          </label>
        </div>
        <div className="field">
          <label>Fallback chain (optional, comma-separated model ids)</label>
          <input type="text" name="openrouter_fallbacks" defaultValue={fallbacks} placeholder="leave blank to let the Ledger pick free fallbacks" />
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn" disabled={save.state !== "idle"}>Save</button>
          <span className="hint" style={{ margin: 0 }}>
            Current model:{" "}
            {/* model ids are lower-case and get copied around — don't shout them */}
            <strong style={{ textTransform: "none", letterSpacing: 0, fontSize: 12 }}>{current || "not set"}</strong>
          </span>
        </div>
      </save.Form>

      <div className="panel">
        <h3>
          Model catalogue{" "}
          {cat ? <span className="badge ok">{cat.counts.free} free</span> : null}{" "}
          {cat ? <span className="badge off">{cat.counts.total} total</span> : null}
        </h3>
        <p className="hint">Pick the model the OpenRouter runner uses</p>

        {cat?.stale && (
          <div className="notice warn">
            Showing a cached catalogue{cat.error ? ` — ${cat.error}` : ""}. Refresh when you are back online.
          </div>
        )}

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
          <div className="field" style={{ margin: 0, flex: "1 1 240px", position: "relative" }}>
            <label>Search</label>
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="name, vendor, or what it is good at"
              style={{ paddingLeft: 30 }}
            />
            <Search size={13} style={{ position: "absolute", left: 10, bottom: 11, opacity: 0.45 }} />
          </div>
          <div className="field" style={{ margin: 0, flex: "0 0 200px" }}>
            <label>Vendor</label>
            <Select
              name="or_vendor"
              value={vendor}
              onChange={setVendor}
              options={[
                { value: "", label: `All vendors (${cat?.vendors.length ?? 0})` },
                ...(cat?.vendors ?? []).map((v) => ({ value: v.id, label: `${v.label} (${v.count})` })),
              ]}
            />
          </div>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => fetcher.load("/api/openrouter?refresh=1")}
            disabled={loading}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <RefreshCw size={13} /> {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        <div className="tabs" style={{ marginTop: 0 }}>
          <button type="button" className={`tab ${tier === "all" ? "on" : ""}`} onClick={() => setTier("all")}>
            All
          </button>
          {(cat?.tiers ?? []).map((t) => (
            <button
              key={t.id}
              type="button"
              title={t.blurb}
              className={`tab ${tier === t.id ? "on" : ""}`}
              onClick={() => setTier(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "10px 0 4px" }}>
          {CAPS.map((c) => (
            <button
              key={c.id}
              type="button"
              title={c.hint}
              className={`chip ${caps.includes(c.id) ? "on" : ""}`}
              onClick={() => toggleCap(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>

        <p className="hint" style={{ margin: "10px 0" }}>
          {cat
            ? `${shown.length} model${shown.length === 1 ? "" : "s"}${
                tier === "free" ? " · nothing here costs a cent" : ""
              } · prices are USD per million tokens, input / output`
            : "Loading the catalogue…"}
        </p>

        {cat && shown.length === 0 && (
          <p className="hint">Nothing matches those filters. Widen the tier or clear a capability.</p>
        )}

        {shown.length > 0 && (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Price / M</th>
                <th>Context</th>
                <th>Can do</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, limit).map((m) => (
                <tr key={m.id} style={m.id === current ? { background: "var(--card)" } : undefined}>
                  <td>
                    <div style={{ fontWeight: 600 }}>
                      {m.name.replace(/\s*\(free\)\s*$/i, "")}{" "}
                      {m.free ? <span className="badge ok">free</span> : null}
                    </div>
                    <div className="hint" style={{ margin: "3px 0 0", textTransform: "none", letterSpacing: 0 }}>
                      {m.id}
                    </div>
                    {m.blurb ? (
                      <div style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 4, maxWidth: 460 }}>
                        {m.blurb}
                      </div>
                    ) : null}
                  </td>
                  <td style={{ fontFamily: "var(--mono)", fontSize: 12, whiteSpace: "nowrap" }}>{price(m)}</td>
                  <td style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{fmtContext(m.context)}</td>
                  <td style={{ display: "flex", gap: 4, flexWrap: "wrap", maxWidth: 170 }}>
                    {m.jsonMode ? <span className="badge off">json</span> : null}
                    {m.tools ? <span className="badge off">tools</span> : null}
                    {m.reasoning ? <span className="badge off">think</span> : null}
                    {m.vision ? <span className="badge off">vision</span> : null}
                    {m.intelligence !== null ? (
                      <span className="badge warn" title="Artificial Analysis intelligence index — higher is smarter">
                        AA {Math.round(m.intelligence)}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {m.id === current ? (
                      <span className="badge on">in use</span>
                    ) : (
                      <save.Form method="post">
                        <input type="hidden" name="intent" value="openrouter-use" />
                        <input type="hidden" name="model" value={m.id} />
                        <button className="back-link" disabled={save.state !== "idle"}>use this</button>
                      </save.Form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {shown.length > limit && (
          <button type="button" className="ghost-btn" style={{ marginTop: 12 }} onClick={() => setLimit((l) => l + PAGE)}>
            Show {Math.min(PAGE, shown.length - limit)} more of {shown.length}
          </button>
        )}
      </div>
    </>
  );
}
