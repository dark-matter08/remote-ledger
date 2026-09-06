#!/usr/bin/env node
// Run the ledger as a long-lived local service you can reach at a real hostname.
//
// This builds and serves the PRODUCTION app rather than the dev server: it survives
// a closed terminal, does not re-optimise dependencies underneath you, and starts in
// milliseconds. `npm run dev` is still the thing to use while editing, since this one
// only picks up changes when you restart it.
//
// Usage: node scripts/serve.mjs <start|stop|restart|status|logs|host|unhost>
//   start    build, then run in the background
//   restart  rebuild and replace the running process (use after code changes)
//   host     add remoteledger.local to the hosts file (asks for sudo once)
//
// Paths are auto-detected, so this works on any machine after a clone.
import { spawn, execSync, execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { createRequire } from "node:module";

const ACTION = (process.argv[2] || "status").toLowerCase();
const PROJECT = process.cwd();
const WIN = platform() === "win32";

const HOSTNAME = process.env.LEDGER_HOST || "remoteledger.local";
const PORT = Number(process.env.PORT || 5173) || 5173;
const PID_FILE = resolve(PROJECT, "data", "serve.pid");
const LOG = resolve(PROJECT, "logs", "serve.log");
const SERVER_ENTRY = resolve(PROJECT, "build", "server", "index.js");
const BIN = (n) => resolve(PROJECT, "node_modules", ".bin", WIN ? `${n}.cmd` : n);
const HOSTS_FILE = WIN ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts";
const MARKER = "# remote-ledger";

// Starting again after a reboot. A LaunchAgent (macOS) or a systemd *user* unit
// (Linux) rather than anything privileged: this serves an unprivileged port for one
// person, so it belongs in the login session, not the system domain.
const MAC = platform() === "darwin";
const AGENT_LABEL = "dev.remoteledger.server";
const AGENT_PLIST = resolve(homedir(), "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
const SYSTEMD_UNIT = resolve(homedir(), ".config", "systemd", "user", "remote-ledger.service");
const AUTOSTART_FILE = MAC ? AGENT_PLIST : SYSTEMD_UNIT;
const GUI = () => `gui/${process.getuid?.() ?? 501}`;

// launchd opens the job's stdout/stderr itself, before the process exists — and it is
// denied inside the protected folders (Documents, Desktop, Downloads). A project that
// lives in one of those would fail to start with a bare EX_CONFIG and an empty log, so
// the supervised log goes somewhere launchd can always write.
const AGENT_LOG = MAC ? resolve(homedir(), "Library", "Logs", "remote-ledger.log") : LOG;

mkdirSync(resolve(PROJECT, "data"), { recursive: true });
mkdirSync(resolve(PROJECT, "logs"), { recursive: true });

const say = (m) => console.log(m);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---------- process bookkeeping ----------

function readPid() {
  try {
    const n = Number(readFileSync(PID_FILE, "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM"; // exists, just not ours to signal
  }
}

// A recorded pid can be recycled onto something unrelated, and killing a stranger's
// process would be a genuinely bad outcome. Confirm it is still OUR server first.
function isOurServer(pid) {
  if (WIN) return true; // no cheap cmdline probe; the pid file is all we have
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { stdio: "pipe" }).toString();
    return cmd.includes("build/server/index.js") || cmd.includes("react-router-serve");
  } catch {
    return false;
  }
}

function runningPid() {
  const pid = readPid();
  if (!pid || !pidAlive(pid) || !isOurServer(pid)) return null;
  return pid;
}

async function reachable(ms = 15000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// ---------- hosts file ----------

function hostsHasEntry() {
  try {
    return readFileSync(HOSTS_FILE, "utf8")
      .split(/\r?\n/)
      .some((l) => !l.trim().startsWith("#") && new RegExp(`\\s${HOSTNAME}(\\s|$)`).test(l));
  } catch {
    return false;
  }
}

function addHost() {
  if (hostsHasEntry()) return say(`  hosts: ${HOSTNAME} already maps to 127.0.0.1`);
  if (WIN) {
    say(`  Windows: open an Administrator prompt and add this line to ${HOSTS_FILE}`);
    say(`    127.0.0.1  ${HOSTNAME}`);
    return;
  }
  say(`  hosts: adding ${HOSTNAME} -> 127.0.0.1 (sudo will ask for your password)`);
  const line = `127.0.0.1\t${HOSTNAME}\t${MARKER}`;
  execSync(`printf '%s\\n' ${shq(line)} | sudo tee -a ${shq(HOSTS_FILE)} > /dev/null`, { stdio: "inherit" });
  // macOS caches DNS aggressively; a stale negative lookup would look like a bug
  if (platform() === "darwin") {
    try {
      execSync("sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder", { stdio: "ignore" });
    } catch {}
  }
  say(hostsHasEntry() ? `  hosts: added` : `  hosts: FAILED — add "127.0.0.1 ${HOSTNAME}" to ${HOSTS_FILE} by hand`);
}

function removeHost() {
  if (!hostsHasEntry()) return say(`  hosts: no ${HOSTNAME} entry to remove`);
  if (WIN) return say(`  Windows: remove the ${HOSTNAME} line from ${HOSTS_FILE} as Administrator`);
  const inPlace = platform() === "darwin" ? `-i ''` : `-i`;
  execSync(`sudo sed ${inPlace} ${shq(`/${MARKER}/d`)} ${shq(HOSTS_FILE)}`, { stdio: "inherit" });
  say(hostsHasEntry() ? `  hosts: line remains (added by hand?) — remove it yourself` : `  hosts: removed`);
}

// ---------- actions ----------

function build() {
  say("  building…");
  execFileSync(BIN("react-router"), ["build"], { stdio: "inherit", cwd: PROJECT });
}

async function start({ rebuild = true } = {}) {
  const existing = runningPid();
  if (existing) {
    say(`  already running (pid ${existing}) — use "restart" to pick up changes`);
    return url();
  }
  if (rebuild || !existsSync(SERVER_ENTRY)) build();
  if (!existsSync(SERVER_ENTRY)) {
    say(`  no build output at ${SERVER_ENTRY}`);
    process.exit(1);
  }

  const out = openSync(LOG, "a");
  const child = spawn(BIN("react-router-serve"), [SERVER_ENTRY], {
    cwd: PROJECT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
    detached: true, // survives this shell closing
    stdio: ["ignore", out, out],
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));

  if (await reachable()) {
    say(`  started (pid ${child.pid})`);
    url();
  } else {
    say(`  started (pid ${child.pid}) but nothing answered on ${PORT} — check ${LOG}`);
    process.exit(1);
  }
}

function stop({ quiet = false } = {}) {
  const pid = runningPid();
  if (!pid) {
    if (!quiet) say("  not running");
    rmSync(PID_FILE, { force: true });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  // block without shelling out per tick; SIGTERM should land well inside this
  const napShared = new SharedArrayBuffer(4);
  const nap = (ms) => Atomics.wait(new Int32Array(napShared), 0, 0, ms);
  for (let i = 0; i < 40 && pidAlive(pid); i++) nap(100);
  if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  rmSync(PID_FILE, { force: true });
  if (!quiet) say(`  stopped (pid ${pid})`);
}

function url() {
  const shown = PORT === 80 ? `http://${HOSTNAME}` : `http://${HOSTNAME}:${PORT}`;
  say(`  ${hostsHasEntry() ? shown : `http://localhost:${PORT}   (run "host" to enable ${HOSTNAME})`}`);
  return shown;
}

async function status() {
  const pid = runningPid() ?? supervisedPid();
  say(`  process : ${pid ? `running (pid ${pid})` : "stopped"}`);
  say(`  port    : ${PORT} ${pid ? ((await reachable(3000)) ? "responding" : "NOT responding") : ""}`);
  say(`  hostname: ${HOSTNAME} ${hostsHasEntry() ? "-> 127.0.0.1" : "(not in hosts file)"}`);
  const sup = supervisedPid();
  say(
    `  on login: ${
      autostartEnabled()
        ? sup
          ? `enabled (supervised, pid ${sup})`
          : "enabled, but not running right now"
        : 'disabled — run "enable"'
    }`
  );
  say(`  log     : ${autostartEnabled() ? AGENT_LOG : LOG}`);
  if (pid) url();
}

// ---------- start again after a reboot ----------

const xml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The real JavaScript behind `react-router-serve`.
 *
 * Not node_modules/.bin/react-router-serve: package managers put a /bin/sh wrapper
 * there, and launchd cannot execute anything inside a protected folder — a project in
 * ~/Documents dies with "Operation not permitted" before it starts. Running the node
 * binary (which lives outside the project) against the resolved .js sidesteps both:
 * executing node is allowed, and reading the script is only a read.
 */
function serveEntry() {
  try {
    return createRequire(import.meta.url).resolve("@react-router/serve/bin.js");
  } catch {}
  const guess = resolve(PROJECT, "node_modules", "@react-router", "serve", "bin.js");
  return existsSync(guess) ? guess : null;
}

function agentPlist(entry) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(entry)}</string>
    <string>${xml(SERVER_ENTRY)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(PROJECT)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PORT</key><string>${PORT}</string>
    <key>NODE_ENV</key><string>production</string>
    <key>PATH</key><string>${xml(dirname(process.execPath))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(AGENT_LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(AGENT_LOG)}</string>
</dict></plist>
`;
}

function systemdUnit(entry) {
  return `[Unit]
Description=The Remote Ledger
After=network.target

[Service]
ExecStart=${process.execPath} ${entry} ${SERVER_ENTRY}
WorkingDirectory=${PROJECT}
Environment=PORT=${PORT}
Environment=NODE_ENV=production
Environment=PATH=${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function autostartEnabled() {
  return !WIN && existsSync(AUTOSTART_FILE);
}

/** The pid launchd/systemd is supervising, if it is the one running. */
function supervisedPid() {
  if (!autostartEnabled()) return null;
  try {
    if (MAC) {
      const out = execSync(`launchctl list ${AGENT_LABEL} 2>/dev/null`, { encoding: "utf8" });
      const m = /"PID"\s*=\s*(\d+)/.exec(out);
      return m ? Number(m[1]) : null;
    }
    const out = execSync("systemctl --user show remote-ledger -p MainPID --value", { encoding: "utf8" });
    const n = Number(out.trim());
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function enable() {
  if (WIN) {
    say("  Windows has no equivalent here — add a shortcut to shell:startup, or use Task Scheduler.");
    process.exit(1);
  }
  if (!existsSync(SERVER_ENTRY)) build();

  // hand the port over: a manually started copy would win the race on the next boot
  // and leave the supervised one flapping against EADDRINUSE
  stop({ quiet: true });

  const entry = serveEntry();
  if (!entry) {
    say("  cannot find @react-router/serve — run an install first.");
    process.exit(1);
  }
  mkdirSync(dirname(AUTOSTART_FILE), { recursive: true });
  mkdirSync(dirname(AGENT_LOG), { recursive: true });
  writeFileSync(AUTOSTART_FILE, MAC ? agentPlist(entry) : systemdUnit(entry));

  if (MAC) {
    spawnSync("launchctl", ["bootout", GUI(), AUTOSTART_FILE], { stdio: "ignore" }); // may not be loaded
    const r = spawnSync("launchctl", ["bootstrap", GUI(), AUTOSTART_FILE], { stdio: "pipe" });
    if (r.status !== 0) {
      say(`  launchctl refused it: ${String(r.stderr || "").trim() || "unknown error"}`);
      process.exit(1);
    }
  } else {
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    const r = spawnSync("systemctl", ["--user", "enable", "--now", "remote-ledger"], { stdio: "pipe" });
    if (r.status !== 0) {
      say(`  systemctl refused it: ${String(r.stderr || "").trim() || "unknown error"}`);
      process.exit(1);
    }
  }

  if (await reachable()) {
    say(`  starts automatically from now on, and is running (pid ${supervisedPid() ?? "?"}).`);
    url();
  } else {
    say(`  installed, but nothing answered on ${PORT} — check ${AGENT_LOG}`);
    process.exit(1);
  }
  if (!MAC) say("  tip: `loginctl enable-linger $USER` starts it at boot rather than at login.");
  else say(`  note: this starts when you log in. Rebuild after code changes with "restart".`);
}

function disable() {
  if (!autostartEnabled()) {
    say("  automatic start was not enabled");
    return;
  }
  if (MAC) {
    spawnSync("launchctl", ["bootout", GUI(), AUTOSTART_FILE], { stdio: "ignore" });
  } else {
    spawnSync("systemctl", ["--user", "disable", "--now", "remote-ledger"], { stdio: "ignore" });
  }
  rmSync(AUTOSTART_FILE, { force: true });
  if (!MAC) spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  say("  automatic start disabled, and the server stopped.");
}

/** Restart whatever is supervising it, rather than fighting KeepAlive. */
function supervisedRestart() {
  if (MAC) spawnSync("launchctl", ["kickstart", "-k", `${GUI()}/${AGENT_LABEL}`], { stdio: "ignore" });
  else spawnSync("systemctl", ["--user", "restart", "remote-ledger"], { stdio: "ignore" });
}

/** Stop it now. It still comes back at login unless `disable` is run. */
function supervisedStop() {
  if (MAC) spawnSync("launchctl", ["bootout", GUI(), AUTOSTART_FILE], { stdio: "ignore" });
  else spawnSync("systemctl", ["--user", "stop", "remote-ledger"], { stdio: "ignore" });
}

const HELP = `
The Remote Ledger — background server

  node scripts/serve.mjs start     build and run in the background
  node scripts/serve.mjs restart   rebuild and replace it (after code changes)
  node scripts/serve.mjs stop      stop it
  node scripts/serve.mjs status    is it up, and on what address
  node scripts/serve.mjs enable    start it automatically at login, and keep it up
  node scripts/serve.mjs disable   stop doing that
  node scripts/serve.mjs logs      tail the log
  node scripts/serve.mjs host      map ${HOSTNAME} to 127.0.0.1 (sudo)
  node scripts/serve.mjs unhost    remove that mapping (sudo)

Port: set PORT (default ${PORT}). A hosts entry maps a NAME to an address, not a
port, so the address includes the port unless you serve on 80 — and binding 80
needs elevated privileges.
`;

switch (ACTION) {
  case "start":
    addHost();
    await start();
    break;
  case "restart":
    if (supervisedPid()) {
      build(); // the supervisor restarts the process, but not the bundle it serves
      supervisedRestart();
      say((await reachable()) ? "  restarted." : `  restarted, but nothing answered on ${PORT} — check ${LOG}`);
      url();
    } else {
      stop({ quiet: true });
      await start();
    }
    break;
  case "stop":
    if (supervisedPid()) {
      supervisedStop();
      say('  stopped. It still starts again at login — run "disable" to stop that too.');
    } else {
      stop();
    }
    break;
  case "enable":
    addHost();
    await enable();
    break;
  case "disable":
    disable();
    break;
  case "status":
    await status();
    break;
  case "logs": {
    const which = autostartEnabled() && existsSync(AGENT_LOG) ? AGENT_LOG : LOG;
    if (!existsSync(which)) say(`  no log yet at ${which}`);
    else spawn(WIN ? "powershell" : "tail", WIN ? ["-Command", `Get-Content -Wait ${which}`] : ["-f", which], { stdio: "inherit" });
    break;
  }
  case "host":
    addHost();
    break;
  case "unhost":
    removeHost();
    break;
  default:
    say(HELP);
}
