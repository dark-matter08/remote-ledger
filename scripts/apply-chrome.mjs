#!/usr/bin/env node
// Start a Chrome that auto-apply can open tabs in, using YOUR profile rather than a
// blank throwaway browser.
//
// Why a dedicated profile and not the one you already have open: since Chrome 136 the
// remote-debugging port is refused on the default user-data-dir, deliberately, to stop
// malware reading your cookies. There is also no way to switch debugging on for a
// Chrome that is already running. So this starts a second, persistent profile you log
// into once; it keeps its sessions between runs, which is the part that matters.
//
// Usage: node scripts/apply-chrome.mjs <start|status|where>
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { platform, homedir } from "node:os";

const ACTION = (process.argv[2] || "status").toLowerCase();
const PROJECT = process.cwd();
const PORT = Number(process.env.APPLY_CDP_PORT || 9222) || 9222;
const PROFILE = process.env.APPLY_CHROME_PROFILE || resolve(PROJECT, "data", "apply-chrome");
const say = (m) => console.log(m);

function chromePath() {
  const os = platform();
  const candidates =
    os === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : os === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            resolve(homedir(), "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"),
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
  return candidates.find((p) => existsSync(p)) || null;
}

async function cdpUp() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function start() {
  const live = await cdpUp();
  if (live) {
    say(`  already listening on ${PORT} — ${live.Browser}`);
    return;
  }
  const bin = chromePath();
  if (!bin) {
    say("  no Chrome-family browser found. Install Chrome, or set APPLY_CHROME_PROFILE and start it yourself with:");
    say(`    --remote-debugging-port=${PORT} --user-data-dir=<a dir that is NOT your default profile>`);
    process.exit(1);
  }
  mkdirSync(PROFILE, { recursive: true });
  say(`  starting ${bin.split("/").pop()} with debugging on ${PORT}`);
  say(`  profile: ${PROFILE}`);

  const child = spawn(
    bin,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();

  for (let i = 0; i < 25; i++) {
    const v = await cdpUp();
    if (v) {
      say(`  ready — ${v.Browser}`);
      say(`  Log into the job sites you use in THIS window once; the profile keeps them.`);
      say(`  Then set Settings → Auto-apply browser to "my Chrome".`);
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  say(`  started, but nothing answered on ${PORT}. If you passed your DEFAULT profile, Chrome refuses`);
  say(`  the debugging port there (since Chrome 136). Use a separate --user-data-dir.`);
  process.exit(1);
}

async function status() {
  const v = await cdpUp();
  say(`  port    : ${PORT} ${v ? "listening" : "not listening"}`);
  if (v) say(`  browser : ${v.Browser}`);
  say(`  profile : ${PROFILE}${existsSync(PROFILE) ? "" : "  (not created yet)"}`);
  say(`  chrome  : ${chromePath() || "not found"}`);
  if (!v) say(`  start it with: node scripts/apply-chrome.mjs start`);
}

switch (ACTION) {
  case "start":
    await start();
    break;
  case "where":
    say(chromePath() || "not found");
    break;
  default:
    await status();
}
