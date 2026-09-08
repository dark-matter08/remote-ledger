// Built-in scheduler: runs while the app runs. Ticks every 30 min and runs a crawl
// when one is due (now - last_crawl >= interval). Reads settings each tick, so
// enabling/disabling or changing the interval takes effect without a restart.
import { getSetting } from "../sqlite.server";
import { getMeta, trashStaleJobs } from "../db.server";
import { runCrawl } from "./crawl.server";
import { activeProfiles } from "../profiles.server";
import { runDueBackup } from "./backup.server";
import { runDueCommunityShare } from "./contribute.server";
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
    try { runDueBackup(); } catch (e) { console.error("[scheduler] backup error:", e); }
    try { runDueSources(); } catch (e) { console.error("[scheduler] kb rescan error:", e); }
    try { runDueEmailSync(); } catch (e) { console.error("[scheduler] email sync error:", e); }
    // opt-in, once a day, and a no-op for anyone who has not switched it on
    try { await runDueCommunityShare(); } catch (e) { console.error("[scheduler] community share error:", e); }
    if (getSetting("scheduler_enabled") === "false") return;
    const hours = Number(getSetting("scheduler_interval_hours") || "4") || 4;
    // Each profile is its own search on its own clock, using its own last_crawled_at
    // rather than one shared last_crawl. Two profiles are two crawls — the honest cost
    // of looking for two things — and each gets the whole configured budget instead of
    // a fraction of it.
    //
    // One per tick, most overdue first. Crawling is the expensive thing this app does,
    // and starting several at once would multiply that spike rather than spread it; the
    // next tick takes the next profile.
    const overdue = activeProfiles()
      .filter((p) => !p.last_crawled_at || Date.now() - new Date(p.last_crawled_at).getTime() >= hours * 3600 * 1000)
      .sort((a, b) => String(a.last_crawled_at || "").localeCompare(String(b.last_crawled_at || "")));
    if (overdue.length) {
      const p = overdue[0];
      console.log(`[scheduler] crawl due for "${p.name}" — running${overdue.length > 1 ? ` (${overdue.length - 1} more waiting)` : ""}`);
      const r = await runCrawl("find", "scheduler", p.id);
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
