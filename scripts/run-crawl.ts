// Run a single crawl from the CLI (used by `npm run crawl` and the OS scheduler).
import { runCrawl } from "../app/services/crawl.server";

runCrawl()
  .then((r) => {
    console.log(`[${new Date().toISOString()}] crawl:`, JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  })
  .catch((e) => {
    console.error("crawl failed:", e);
    process.exit(1);
  });
