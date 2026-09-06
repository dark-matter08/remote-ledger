// Ollama setup, as a resource route.
//
// Separate from the Settings action because this tab is live: a pull takes minutes and
// reports progress, so the UI polls the loader instead of round-tripping the whole
// settings page. The action handles the one-shot operations.
import {
  installOllama,
  ollamaStatus,
  pullStates,
  removeModel,
  startDaemon,
  startPull,
  testModel,
} from "../services/ollama.server";
import { setSetting } from "../sqlite.server";
import { OLLAMA_MODELS, sameModel } from "../ollama";
import type { Route } from "./+types/api-ollama";

export async function loader() {
  return Response.json(
    { status: await ollamaStatus(), pulls: pullStates() },
    { headers: { "cache-control": "no-store" } }
  );
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const model = String(form.get("model") || "").trim();
  // echoed on every reply so the tab can attribute a result to the row it came from
  const reply = (body: Record<string, unknown>) => Response.json({ intent, model, ...body });

  if (intent === "install") {
    const r = await installOllama();
    // installing puts the binary on disk; it does not start the daemon
    if (r.ok) await startDaemon();
    return reply({ ok: r.ok, msg: r.ok ? "Ollama installed." : "Install failed.", output: r.output });
  }

  if (intent === "start") {
    const ok = await startDaemon();
    return reply({ ok, msg: ok ? "Ollama is running." : "Could not start Ollama — try `ollama serve` in a terminal." });
  }

  if (intent === "pull") {
    if (!model) return reply({ ok: false, msg: "Pick a model first." });
    // a pull against a stopped daemon fails instantly and confusingly
    if (!(await startDaemon())) return reply({ ok: false, msg: "Ollama is not running." });
    startPull(model);
    return reply({ ok: true, msg: `Pulling ${model}…` });
  }

  if (intent === "remove") {
    const r = await removeModel(model);
    return reply({ ok: r.ok, msg: r.ok ? `Removed ${model}.` : r.error || "Could not remove it." });
  }

  if (intent === "test") {
    const r = await testModel(model);
    return reply({
      ok: r.ok,
      msg: r.ok ? `${model} answered in ${(r.ms / 1000).toFixed(1)}s: "${r.reply}"` : `${model} failed: ${r.error}`,
    });
  }

  if (intent === "use") {
    if (!model) return reply({ ok: false, msg: "Pick a model first." });
    // An embedding model cannot answer a prompt, so making it the default runner
    // would break every call in the app with a 400 nobody would connect back to here.
    const known = OLLAMA_MODELS.find((m) => sameModel(m.id, model));
    if (known?.caps.includes("embedding")) {
      return reply({
        ok: false,
        msg: `${model} only produces embeddings — it cannot answer prompts. Pick a chat model to run the Ledger.`,
      });
    }
    setSetting("model_ollama-api", model);
    setSetting("default_runner", "ollama-api");
    return reply({ ok: true, msg: `The Ledger now runs on ${model}, locally.` });
  }

  return reply({ ok: false, msg: `Unknown intent "${intent}".` });
}
