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
import { spawn, execSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { platform } from "node:os";

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
  const pid = runningPid();
  say(`  process : ${pid ? `running (pid ${pid})` : "stopped"}`);
  say(`  port    : ${PORT} ${pid ? ((await reachable(3000)) ? "responding" : "NOT responding") : ""}`);
  say(`  hostname: ${HOSTNAME} ${hostsHasEntry() ? "-> 127.0.0.1" : "(not in hosts file)"}`);
  say(`  log     : ${LOG}`);
  if (pid) url();
}

const HELP = `
The Remote Ledger — background server

  node scripts/serve.mjs start     build and run in the background
  node scripts/serve.mjs restart   rebuild and replace it (after code changes)
  node scripts/serve.mjs stop      stop it
  node scripts/serve.mjs status    is it up, and on what address
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
    stop({ quiet: true });
    await start();
    break;
  case "stop":
    stop();
    break;
  case "status":
    await status();
    break;
  case "logs":
    if (!existsSync(LOG)) say(`  no log yet at ${LOG}`);
    else spawn(WIN ? "powershell" : "tail", WIN ? ["-Command", `Get-Content -Wait ${LOG}`] : ["-f", LOG], { stdio: "inherit" });
    break;
  case "host":
    addHost();
    break;
  case "unhost":
    removeHost();
    break;
  default:
    say(HELP);
}
