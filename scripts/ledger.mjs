#!/usr/bin/env node
// The whole thing in one command, for someone who would rather not learn what a
// terminal is.
//
//   npm run ledger start     set it up and leave it running, for good
//   npm run ledger restart   take the latest code and come back up on it
//   npm run ledger stop
//   npm run ledger status
//   npm run ledger logs
//
// This orchestrates; it does not reimplement. serve.mjs already knows how to build,
// run detached and come back after a reboot, and dropport already knows how to put a
// real hostname and a trusted certificate in front of a port. What was missing was
// the step that does both, in the right order, and installs what is not there yet.
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { delimiter, dirname, resolve, join } from "node:path";
import { platform } from "node:os";
import { winSafe } from "./win.mjs";

const ACTION = (process.argv[2] || "help").toLowerCase();
const PROJECT = process.cwd();
const MAC = platform() === "darwin";
const WIN = platform() === "win32";

// A bare name would become <name>.dp.local anyway; spelling it out means the value
// you set is the address you get.
const DOMAIN = process.env.LEDGER_DOMAIN || "remoteledger.dp.local";
const PORT = Number(process.env.PORT || 5173) || 5173;
const SERVE = resolve(PROJECT, "scripts", "serve.mjs");
const LOGS = resolve(PROJECT, "logs");

mkdirSync(LOGS, { recursive: true });

const say = (m = "") => console.log(m);
const step = (m) => say(`\n▸ ${m}`);
// These get returned, not just printed — `return ok(...)` is the shape every check
// below uses, so console.log's undefined would read as failure on the way out.
const ok = (m) => { say(`  ✓ ${m}`); return true; };
const warn = (m) => { say(`  ! ${m}`); return false; };

function run(cmd, args, opts = {}) {
  const [c, a] = winSafe(cmd, args);
  const r = spawnSync(c, a, { stdio: "inherit", cwd: PROJECT, shell: WIN, ...opts });
  return r.status === 0;
}

function capture(cmd, args, opts = {}) {
  const [c, a] = winSafe(cmd, args);
  const r = spawnSync(c, a, { encoding: "utf8", cwd: PROJECT, shell: WIN, ...opts });
  return r.status === 0 ? String(r.stdout || "") : null;
}

const napBuf = new SharedArrayBuffer(4);
const nap = (ms) => Atomics.wait(new Int32Array(napBuf), 0, 0, ms);

/**
 * Does the browser's answer match ours? curl without -k validates the whole chain,
 * so exit 0 here means a real browser will not warn either.
 */
function certTrusted() {
  // /dev/null does not exist on Windows; the equivalent sink is NUL
  const sink = WIN ? "NUL" : "/dev/null";
  const r = spawnSync("curl", ["-sS", "-o", sink, "--max-time", "10", `https://${DOMAIN}`], { stdio: "ignore", shell: WIN });
  return r.status === 0;
}

/**
 * Trust the local certificate authority, and check that it took.
 *
 * `dropport trust` asks the RUNNING proxy for its CA over its admin API, so it fails
 * if the proxy is still coming up — and `dropport up` exits 0 even when it reports
 * the proxy is not answering, so nothing upstream catches that. This is the step that
 * decides whether the browser shows a padlock or a full-page warning, so it is worth
 * retrying and worth verifying rather than assuming.
 */
function ensureTrust() {
  if (certTrusted()) return ok("certificate already trusted");
  for (const waitMs of [0, 3000, 6000]) {
    if (waitMs) {
      say(`  the proxy may still be starting — waiting ${waitMs / 1000}s and trying again…`);
      nap(waitMs);
    }
    run("dropport", ["trust"]);
    if (certTrusted()) return ok("certificate trusted — the browser will not warn");
  }
  warn(`the certificate is still untrusted, so ${DOMAIN} will show a browser warning.`);
  say("    The app itself is fine — this is only the certificate.");
  // dropport before 0.2.3 asked Node whether the certificate was trusted. Node ships
  // its own CA bundle and misreports the failure, so `trust` answered "already
  // trusted — nothing to do" and skipped the work on exactly the machines that
  // needed it. If that is what you just saw above, this is why.
  say("    If it said \"already trusted — nothing to do\" each time, dropport is out of date:");
  say("      npm install -g github:dark-matter08/dropport && npm run ledger trust");
  say("    Otherwise `dropport doctor` will say why.");
  return false;
}

function have(bin) {
  const r = spawnSync(WIN ? "where" : "which", [bin], { stdio: "ignore" });
  return r.status === 0;
}

// ---------- prerequisites ----------

// Whatever launched this script is what the project is already installed with;
// switching managers mid-clone is how a lockfile ends up fighting itself.
function packageManager() {
  const ua = String(process.env.npm_config_user_agent || "");
  if (ua.startsWith("pnpm")) return "pnpm";
  if (ua.startsWith("yarn")) return "yarn";
  if (ua.startsWith("npm")) return "npm";
  if (existsSync(resolve(PROJECT, "pnpm-lock.yaml")) && have("pnpm")) return "pnpm";
  return "npm";
}

function installDeps({ force = false } = {}) {
  if (!force && existsSync(resolve(PROJECT, "node_modules", ".bin"))) return true;
  const pm = packageManager();
  step(`Installing dependencies with ${pm} — this takes a minute the first time`);
  return run(pm, ["install"]);
}

/** Caddy does the proxying and the certificates; dropport is a wrapper around it. */
/**
 * Where the Windows installers put caddy.exe.
 *
 * winget updates the PATH for *future* processes, so a caddy installed a moment ago
 * is invisible to `where` in this one. Same trap that made the installer report git
 * as missing right after installing it.
 */
function caddyOnDisk() {
  if (!WIN) return false;
  const candidates = [
    // winget's "Command line alias added" lands here
    resolve(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "caddy.exe"),
    resolve(process.env.USERPROFILE || "", "scoop", "shims", "caddy.exe"),
    "C:\\ProgramData\\chocolatey\\bin\\caddy.exe",
    resolve(process.env.ProgramFiles || "C:\\Program Files", "Caddy", "caddy.exe"),
    resolve(process.env.LOCALAPPDATA || "", "Programs", "Caddy", "caddy.exe"),
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) return false;
  process.env.PATH = `${dirname(found)}${delimiter}${process.env.PATH || ""}`;
  return true;
}

function ensureCaddy() {
  if (have("caddy") || caddyOnDisk()) return ok("Caddy is installed");

  step("Installing Caddy (it serves the https address)");
  if (MAC && have("brew")) {
    if (run("brew", ["install", "caddy"])) return ok("Caddy installed");
  } else if (WIN) {
    // winget ships with Windows 10 and 11; scoop and chocolatey are common enough to
    // be worth trying before giving up.
    //
    // Its exit code is not the answer to "did this work". It reports non-zero for
    // "Path environment variable modified; restart your shell", which is what it says
    // after a *successful* install — so gating on the status threw away a Caddy that
    // was sitting right there. Run it, then look on disk, which is the only thing
    // that actually settles it.
    if (have("winget")) {
      run("winget", ["install", "--id", "CaddyServer.Caddy", "-e", "--source", "winget",
        "--accept-source-agreements", "--accept-package-agreements"]);
      if (have("caddy") || caddyOnDisk()) return ok("Caddy installed");
    }
    if (have("scoop")) {
      run("scoop", ["install", "caddy"]);
      if (have("caddy") || caddyOnDisk()) return ok("Caddy installed");
    }
    if (have("choco")) {
      run("choco", ["install", "caddy", "-y"]);
      if (have("caddy") || caddyOnDisk()) return ok("Caddy installed");
    }
  } else if (!MAC) {
    // Each of these asks for a password; announce it rather than surprising anyone.
    say("  this needs your password, to install a system package");
    if (have("apt-get") && run("sudo", ["apt-get", "install", "-y", "caddy"])) return ok("Caddy installed");
    if (have("dnf") && run("sudo", ["dnf", "install", "-y", "caddy"])) return ok("Caddy installed");
    if (have("pacman") && run("sudo", ["pacman", "-S", "--noconfirm", "caddy"])) return ok("Caddy installed");
  }

  warn("could not install Caddy automatically.");
  say("    Install it once, then run this command again:");
  say(MAC ? "      brew install caddy" : WIN ? "      winget install CaddyServer.Caddy" : "      see https://caddyserver.com/docs/install");
  return false;
}

function ensureDropport() {
  if (have("dropport")) return ok("dropport is installed");
  step("Installing dropport (it gives the app its web address)");
  const pm = packageManager() === "pnpm" ? "pnpm" : "npm";
  const fromGit = pm === "pnpm"
    ? ["add", "-g", "github:dark-matter08/dropport"]
    : ["install", "-g", "github:dark-matter08/dropport"];
  // Windows support landed in the repository before the registry had it, and an
  // install of the published copy there would fail in a way that looks like a bug in
  // this script. Take it from source on Windows until the two agree.
  if (WIN && run(pm, fromGit)) return ok("dropport installed from source");
  const args = pm === "pnpm" ? ["add", "-g", "dropport"] : ["install", "-g", "dropport"];
  if (run(pm, args)) return ok("dropport installed");
  // the registry copy can lag the repo, and a global install can be refused outright
  if (run(pm, pm === "pnpm" ? ["add", "-g", "github:dark-matter08/dropport"] : ["install", "-g", "github:dark-matter08/dropport"]))
    return ok("dropport installed from source");
  warn("could not install dropport automatically.");
  say(`    Run this once, then try again:  ${pm} install -g dropport`);
  return false;
}

/**
 * Register the name and start the proxy. dropport keeps its registry in
 * ~/.dropport/apps.json and installs a launchd daemon (macOS) or systemd unit, so
 * both the routes and the proxy itself are already there after a reboot — there is
 * nothing for this script to arrange beyond running it once.
 */
function setupDropport() {
  // The installer offers the https address as a choice, and a choice you cannot
  // decline is a label. Everything still works without it — the app just answers on
  // a port instead of a name.
  if (process.env.LEDGER_SKIP_PROXY === "1") {
    step("Skipping the https address, as asked");
    return null;
  }
  if (!ensureCaddy() || !ensureDropport()) {
    warn("skipping the https address — the app still runs, just with a port in the URL.");
    return null;
  }

  step(`Pointing https://${DOMAIN} at the app`);
  if (!run("dropport", ["add", DOMAIN, String(PORT)])) {
    warn(`dropport could not register ${DOMAIN}`);
    return null;
  }
  // up and trust each ask for a password: one binds 80/443, one adds the local
  // certificate authority so the browser stops warning. Both are announced by dropport.
  if (!run("dropport", ["up"])) {
    warn("dropport could not start the proxy — try `dropport doctor`");
    return null;
  }

  step("Trusting the local certificate authority");
  const trusted = ensureTrust();
  // The address works either way; an untrusted certificate is a warning to click
  // through, not a broken app. Say which one they have.
  return trusted ? `https://${DOMAIN}` : `https://${DOMAIN}  (certificate not trusted yet — see above)`;
}

// ---------- git ----------

const gitDirty = () => Boolean(capture("git", ["status", "--porcelain"])?.trim());

/**
 * Throw away local edits, exactly as asked — but write them to logs/ on the way out.
 * On a machine that only ever runs the app there is nothing here worth keeping, and
 * on the one machine where there is, dropping it silently would be unforgivable.
 */
function discardLocalChanges() {
  if (!gitDirty()) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const patch = join(LOGS, `discarded-${stamp}.patch`);
  const diff = capture("git", ["diff", "HEAD"]);
  if (diff?.trim()) {
    writeFileSync(patch, diff);
    say(`  local edits saved to ${patch} before being dropped`);
  }
  // only when there is something to stash: on a clean tree `git stash` saves nothing
  // and the drop that follows would take an older, unrelated stash with it
  if (run("git", ["stash", "--include-untracked"], { stdio: "ignore" })) {
    run("git", ["stash", "drop"], { stdio: "ignore" });
    ok("local changes discarded");
  }
}

/**
 * `git pull` refuses when an untracked file would be overwritten by an incoming one
 * — a generated lockfile is the usual culprit, and it stops a non-technical user
 * dead. Move the offenders aside and try once more.
 */
function pullWithRetry() {
  const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() || "main";

  // Fetch, then merge the remote-tracking ref rather than pulling.
  //
  // `git pull` merges whatever is in .git/FETCH_HEAD, and the running app checks for
  // updates by fetching too — so a check landing mid-pull rewrites that file under
  // us and the merge dies with "Cannot fast-forward to multiple branches". origin/
  // <branch> is a real ref, updated atomically, and reading it cannot be raced.
  const fetched = spawnSync("git", ["fetch", "origin", branch], { encoding: "utf8", cwd: PROJECT });
  if (fetched.status !== 0) {
    say(String(fetched.stderr || "").trim());
    return false;
  }
  const first = spawnSync("git", ["merge", "--ff-only", `origin/${branch}`], { encoding: "utf8", cwd: PROJECT });
  const output = `${first.stdout || ""}${first.stderr || ""}`;
  say(output.trim());
  if (first.status === 0) return true;

  if (!/untracked working tree files would be overwritten/i.test(output)) return false;
  const files = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(error|Please|Aborting|Updating|hint)/i.test(l) && !l.includes(" "));
  if (!files.length) return false;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const parked = join(LOGS, `replaced-${stamp}`);
  step(`Moving ${files.length} file(s) aside so the update can land`);
  for (const f of files) {
    const from = resolve(PROJECT, f);
    if (!existsSync(from)) continue;
    const to = join(parked, f);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    say(`  ${f} -> ${to}`);
  }
  return run("git", ["merge", "--ff-only", `origin/${branch}`]);
}

const lockPrint = () =>
  ["pnpm-lock.yaml", "package-lock.json", "package.json"]
    .map((f) => (existsSync(resolve(PROJECT, f)) ? readFileSync(resolve(PROJECT, f), "utf8").length : 0))
    .join(":");

// ---------- actions ----------

function serve(action, env = {}) {
  return run(process.execPath, [SERVE, action], { env: { ...process.env, ...env } });
}

async function start() {
  say("Setting up The Remote Ledger. This can take a few minutes the first time.");
  if (!installDeps()) {
    warn("dependency install failed — nothing else can run until that works.");
    process.exit(1);
  }

  const address = setupDropport();

  step("Starting the app, and making it come back on its own after a restart");
  // `enable` builds, installs the login agent and starts it. With the proxy up, the
  // extra hosts line serve.mjs would add is a second password prompt for a name
  // nothing asks for.
  let up = serve("enable", address ? { LEDGER_SKIP_HOSTS: "1" } : {});
  if (!up) {
    warn("could not install the background service — trying a plain start instead");
    up = serve("start");
  }
  if (!up) {
    warn("the app did not come up. `npm run ledger logs` will say why.");
    process.exit(1);
  }

  say("");
  say("──────────────────────────────────────────────");
  if (address) {
    say(`  The Remote Ledger is running at  ${address}`);
    say("");
    say("  It starts on its own every time you log in, and the address");
    say("  keeps working after a restart. Nothing to run again.");
  } else {
    say(`  The Remote Ledger is running at  http://localhost:${PORT}`);
    say("");
    say("  The https address needs Caddy — see the note above. Everything");
    say("  else works, and it still starts on its own after a restart.");
  }
  say("");
  say("  To take an update later:  npm run ledger restart");
  say("──────────────────────────────────────────────");
}

async function restart() {
  step("Fetching the latest version");
  discardLocalChanges();

  const before = lockPrint();
  if (!pullWithRetry()) {
    warn("could not take the update. The app has been left exactly as it was.");
    say("    Try again in a moment, or send this output to whoever maintains it.");
    process.exit(1);
  }
  if (lockPrint() !== before) installDeps({ force: true });

  step("Restarting");
  if (!serve("restart")) {
    warn("the restart did not come up cleanly — `npm run ledger logs` will say why");
    process.exit(1);
  }
  const head = capture("git", ["log", "-1", "--pretty=%h %s"])?.trim();
  say("");
  ok(`up to date${head ? ` — now on ${head}` : ""}`);
}

/** Everything `start` decides from, without doing any of it. */
function doctor() {
  const dep = existsSync(resolve(PROJECT, "node_modules", ".bin"));
  const rows = [
    ["node", process.version],
    ["package manager", packageManager()],
    ["dependencies", dep ? "installed" : "missing — start will install them"],
    ["caddy", have("caddy") ? (capture("caddy", ["version"]) || "").split("\n")[0].trim() || "present" : "missing — start will try to install it"],
    ["dropport", have("dropport") ? "present" : "missing — start will install it"],
    ["git", have("git") ? (capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]) || "").trim() : "missing — restart cannot update"],
    ["certificate", have("dropport") ? (certTrusted() ? "trusted" : "NOT trusted — run `npm run ledger trust`") : "n/a"],
  ];
  say("What `npm run ledger start` finds on this machine:\n");
  for (const [k, v] of rows) say(`  ${k.padEnd(17)}${v}`);
  say(`\n  it would serve       https://${DOMAIN}  ->  127.0.0.1:${PORT}`);
  say("");
  serve("status");
}

const HELP = `
The Remote Ledger

  npm run ledger start     install what is missing, then run it for good
  npm run ledger restart   take the latest version and restart
  npm run ledger stop      stop it (it still returns when you log in)
  npm run ledger status    is it running, and where
  npm run ledger logs      watch what it is doing
  npm run ledger trust     fix the browser's certificate warning
  npm run ledger doctor    what start will find, without changing anything

Address: ${DOMAIN} (set LEDGER_DOMAIN to change it, PORT for the port).
`;

switch (ACTION) {
  case "start":
  case "install":
    await start();
    break;
  case "restart":
  case "update":
    await restart();
    break;
  case "stop":
    serve("stop");
    break;
  case "status":
    serve("status");
    if (have("dropport")) run("dropport", ["status"]);
    break;
  case "logs":
    serve("logs");
    break;
  case "trust":
    step("Trusting the local certificate authority");
    if (!have("dropport")) warn("dropport is not installed — run `npm run ledger start` first.");
    else if (ensureTrust()) {
      say("");
      say(`  Reload https://${DOMAIN}. If the tab still warns, close and reopen it —`);
      say("  a tab that already failed keeps showing the old error.");
    }
    break;
  case "doctor":
    doctor();
    break;
  default:
    say(HELP);
}
