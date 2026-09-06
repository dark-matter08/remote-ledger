// Settings → Search. Installing and running SearXNG is minutes of work, so the tab
// polls this rather than blocking on a form post.
import {
  installSearxng,
  removeSearxng,
  searxngLogTail,
  searxngStatus,
  startSearxng,
  stopSearxng,
  type InstallStep,
} from "../services/searxng.server";
import { searchAvailable, searchProvider, searchWeb } from "../services/search.server";
import { getSetting, setSetting } from "../sqlite.server";
import { setSecret } from "../secrets.server";
import type { Route } from "./+types/api-search";

// An install outlives the request that began it. Progress lives here; the UI polls.
let install: { running: boolean; steps: InstallStep[]; ok: boolean | null; startedAt: number } | null = null;

export async function loader() {
  const status = await searxngStatus();
  const avail = await searchAvailable();
  return Response.json(
    {
      status,
      provider: searchProvider(),
      searxngUrl: getSetting("searxng_url") || "",
      available: avail.ok,
      why: avail.why,
      install: install ? { running: install.running, steps: install.steps, ok: install.ok } : null,
      log: status.installed && !status.running ? searxngLogTail(12) : "",
    },
    { headers: { "cache-control": "no-store" } }
  );
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const reply = (b: Record<string, unknown>) => Response.json({ intent, ...b });

  if (intent === "provider") {
    const p = String(form.get("provider") || "none");
    setSetting("search_provider", p);
    return reply({ ok: true, msg: p === "none" ? "Web search turned off." : `Search provider set to ${p}.` });
  }

  if (intent === "url") {
    setSetting("searxng_url", String(form.get("url") || "").trim());
    return reply({ ok: true, msg: "SearXNG address saved." });
  }

  if (intent === "key") {
    const name = String(form.get("name") || "");
    const value = String(form.get("value") || "").trim();
    if (!name || !value) return reply({ ok: false, msg: "Nothing to save." });
    setSecret(name, value);
    setSetting(`${name}_set`, "true");
    return reply({ ok: true, msg: "Key saved." });
  }

  if (intent === "install") {
    if (install?.running) return reply({ ok: true, msg: "Already installing." });
    install = { running: true, steps: [], ok: null, startedAt: Date.now() };
    void (async () => {
      const r = await installSearxng((s) => install?.steps.push(s));
      if (install) {
        install.ok = r.ok;
        install.running = false;
      }
      if (r.ok) {
        await startSearxng();
        // installing it is the whole point of choosing it; do not make them pick twice
        if (searchProvider() === "none") setSetting("search_provider", "searxng");
      }
    })();
    return reply({ ok: true, msg: "Installing SearXNG — this takes a few minutes." });
  }

  if (intent === "start") {
    const ok = await startSearxng();
    return reply({ ok, msg: ok ? "SearXNG is running." : "It did not come up — check the log below." });
  }

  if (intent === "stop") {
    const was = stopSearxng();
    return reply({ ok: true, msg: was ? "SearXNG stopped." : "It was not running." });
  }

  if (intent === "remove") {
    removeSearxng();
    install = null;
    return reply({ ok: true, msg: "Removed SearXNG and everything it installed." });
  }

  if (intent === "test") {
    const q = String(form.get("q") || "remote typescript engineer").trim();
    try {
      const t = Date.now();
      const r = await searchWeb(q, { limit: 5 });
      return reply({
        ok: r.length > 0,
        msg: r.length
          ? `${r.length} result(s) in ${((Date.now() - t) / 1000).toFixed(1)}s`
          : "The search ran but returned nothing.",
        results: r,
      });
    } catch (e: any) {
      return reply({ ok: false, msg: String(e?.message || e).slice(0, 300) });
    }
  }

  return reply({ ok: false, msg: `Unknown intent "${intent}".` });
}
