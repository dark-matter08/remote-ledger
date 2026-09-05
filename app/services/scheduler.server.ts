// Built-in scheduler: runs while the app runs. Ticks every 30 min and runs a crawl
// when one is due (now - last_crawl >= interval). Reads settings each tick, so
// enabling/disabling or changing the interval takes effect without a restart.
import { getSetting } from "../sqlite.server";
import { getMeta, trashStaleJobs } from "../db.server";
import { runCrawl } from "./crawl.server";
import { runDueSources } from "./kb.server";
import { runDueEmailSync } from "./email.server";

declare global {
  // eslint-disable-next-line no-var
  var __ledgerSched: NodeJS.Timeout | undefined;
}

const TICK_MS = 30 * 60 * 1000;

async function tick() {
  try {
    // sweep before crawling, so a fresh crawl is not judged against yesterday's clutter
    try {
      const days = Number(getSetting("stale_trash_days") ?? "14");
      if (days > 0) {
        const r = trashStaleJobs(days, (m) => console.log("[stale]", m));
        if (r.trashed) console.log(`[scheduler] trashed ${r.trashed} stale job(s) (untouched ${days}+ days)`);
      }
    } catch (e) { console.error("[scheduler] stale sweep error:", e); }
    try { runDueSources(); } catch (e) { console.error("[scheduler] kb rescan error:", e); }
    try { runDueEmailSync(); } catch (e) { console.error("[scheduler] email sync error:", e); }
    if (getSetting("scheduler_enabled") === "false") return;
    const hours = Number(getSetting("scheduler_interval_hours") || "4") || 4;
    const last = getMeta("last_crawl");
    const due = !last || Date.now() - new Date(last).getTime() >= hours * 3600 * 1000;
    if (due) {
      console.log("[scheduler] crawl due — running");
      const r = await runCrawl("find", "scheduler");
      console.log("[scheduler] crawl done:", JSON.stringify(r));
    }
  } catch (e) {
    console.error("[scheduler] tick error:", e);
  }
}

// idempotent: safe to call from any loader; starts exactly one timer per process
export function ensureScheduler(): void {
  if (global.__ledgerSched) return;
  global.__ledgerSched = setInterval(tick, TICK_MS);
  // a delayed first check so we don't crawl during boot
  setTimeout(tick, 60 * 1000);
}
