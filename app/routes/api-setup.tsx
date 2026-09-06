// GET/POST /api/setup — the proofs behind the onboarding steps.
//
// Every step in the wizard ends with something that either works or does not, and the
// only honest way to say which is to do it: make a real model call, fetch the real
// boards, read the real crawl log. A green tick that came from checking a setting is
// how someone gets to the end of setup and finds nothing works.
//
// Its own route rather than the /setup action so the checks are fetchers — the page
// keeps its state, and the crawl poll does not re-run the wizard's own loader, which
// shells out to `which` four times.
import type { Route } from "./+types/api-setup";
import { runLLM } from "../llm/runner.server";
import { fetchAllFeeds } from "../services/feeds.server";
import { getCrawlRun, crawlLogs } from "../db.server";
import { setSetting } from "../sqlite.server";

/** Poll for a crawl the wizard started, so step 5 shows progress in place. */
export async function loader({ request }: Route.LoaderArgs) {
  const runId = Number(new URL(request.url).searchParams.get("run") || 0);
  if (!runId) return Response.json({ run: null, logs: [] });
  const run = getCrawlRun(runId);
  // the tail is all the wizard has room for; the Crawl Shell has the rest
  const logs = run ? crawlLogs(runId).slice(-14) : [];
  return Response.json({ run, logs });
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  // A real call through the real runner, with the real budget and logging attached.
  // The question is not "is a key present" — it is "does this answer".
  if (intent === "test-runner") {
    const runnerId = String(form.get("runner") || "") || undefined;
    const model = String(form.get("model") || "") || undefined;
    const t0 = Date.now();
    try {
      const r = await runLLM({
        purpose: "misc",
        maxTokens: 64,
        temperature: 0,
        system: "Answer in one short sentence. No preamble.",
        prompt: "In one sentence, what is a résumé for?",
        runnerId,
        model,
      });
      const answer = r.text.trim().slice(0, 300);
      if (!answer)
        return Response.json({
          ok: false,
          msg: `${r.runner} answered, but with nothing in it. Try another model.`,
        });
      setSetting("setup_runner_tested", new Date().toISOString());
      return Response.json({
        ok: true,
        msg: `${r.runner} · ${r.model} answered in ${(r.durationMs / 1000).toFixed(1)}s`,
        answer,
        cost: r.usage.metered ? r.usage.costUsd : 0,
        metered: r.usage.metered,
      });
    } catch (e: any) {
      return Response.json({
        ok: false,
        msg: String(e?.message || e).slice(0, 400),
        elapsed: Date.now() - t0,
      });
    }
  }

  // The keyless boards, read live. Free, ~2s, and it proves the one path that works
  // with no runner at all — which is what someone with no key or CLI actually has.
  if (intent === "test-feeds") {
    try {
      const sweep = await fetchAllFeeds(AbortSignal.timeout(25_000));
      setSetting("setup_feeds_tested", new Date().toISOString());
      return Response.json({
        ok: sweep.postings.length > 0,
        msg: sweep.postings.length
          ? `${sweep.postings.length} live postings from ${sweep.perFeed.filter((f) => f.count).length} board(s).`
          : "The boards answered, but with nothing in them. Check this machine's internet connection.",
        perFeed: sweep.perFeed,
        errors: sweep.errors,
        sample: sweep.postings.slice(0, 5).map((p) => ({ company: p.company, title: p.title, source: p.source })),
      });
    } catch (e: any) {
      return Response.json({ ok: false, msg: `Could not reach the boards: ${String(e?.message || e).slice(0, 200)}` });
    }
  }

  return Response.json({ ok: false, msg: "unknown check" }, { status: 400 });
}
