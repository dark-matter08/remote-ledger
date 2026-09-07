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
// Windows has no launchd or systemd --user. A Scheduled Task is the closest thing:
// it runs in the user's session at logon, needs no admin, and survives a reboot.
const TASK_NAME = "The Remote Ledger";
const WIN_LAUNCHER = resolve(PROJECT, "data", "start-ledger.cmd");
const WIN_STARTUP_VBS = resolve(
  process.env.APPDATA || homedir(),
  "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "remote-ledger.vbs"
);
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
  // dropport writes its own tagged line for the name it owns, so a second entry here
  // would be a second sudo prompt for a mapping nothing reads. ledger.mjs sets this
  // once it has the proxy working.
  if (process.env.LEDGER_SKIP_HOSTS === "1") return;
  if (hostsHasEntry()) return say(`  hosts: ${HOSTNAME} already maps to 127.0.0.1`);
  if (WIN) {
    // Telling someone to open an Administrator prompt and edit a system file by hand
    // is not an install step, it is homework. Windows can raise the prompt itself.
    say(`  hosts: adding ${HOSTNAME} -> 127.0.0.1 (Windows will ask for administrator access)`);
    const staged = resolve(PROJECT, "data", "hosts.staged");
    try {
      mkdirSync(dirname(staged), { recursive: true });
      const current = readFileSync(HOSTS_FILE, "utf8");
      writeFileSync(staged, `${current.replace(/\s*$/, "")}\r\n127.0.0.1\t${HOSTNAME}\t${MARKER}\r\n`);
      // Copy the staged file in one go rather than appending in place, so a refused
      // prompt or a failed write cannot leave a half-written hosts file.
      const r = spawnSync(
        "powershell",
        [
          "-NoProfile", "-Command",
          `Start-Process -FilePath powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList ` +
            `'-NoProfile','-Command','Copy-Item -LiteralPath ''${staged}'' -Destination ''${HOSTS_FILE}'' -Force'`,
        ],
        { stdio: "inherit" }
      );
      rmSync(staged, { force: true });
      if (r.status !== 0) throw new Error("administrator access was refused");
      spawnSync("ipconfig", ["/flushdns"], { stdio: "ignore" });
    } catch (e) {
      say(`  hosts: could not update it (${e.message})`);
      say(`    the app still works at http://localhost:${PORT}`);
      return;
    }
    say(hostsHasEntry() ? "  hosts: added" : `  hosts: not added — the app still works at http://localhost:${PORT}`);
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

/**
 * The react-router CLI, as JavaScript rather than as the shim in node_modules/.bin.
 *
 * That shim is a .cmd on Windows and a /bin/sh script elsewhere — neither is
 * something CreateProcess can run, and neither is something `node` can parse. Running
 * the resolved .js under the interpreter we are already in works everywhere and needs
 * no shell.
 */
function devEntry() {
  try {
    return createRequire(import.meta.url).resolve("@react-router/dev/bin.js");
  } catch {}
  const guess = resolve(PROJECT, "node_modules", "@react-router", "dev", "bin.js");
  return existsSync(guess) ? guess : null;
}

function build() {
  say("  building…");
  const entry = devEntry();
  if (entry) {
    execFileSync(process.execPath, [entry, "build"], { stdio: "inherit", cwd: PROJECT });
    return;
  }
  // no resolved entry: fall back to the shim, which needs a shell on Windows
  execFileSync(BIN("react-router"), ["build"], { stdio: "inherit", cwd: PROJECT, shell: WIN });
}

async function start({ rebuild = true } = {}) {
  const existing = runningPid();
  if (existing) {
    say(`  already running (pid ${existing}) — use "restart" to pick up changes`);
    return url();
  }
  // the logon launcher sets this: the bundle was built when it was installed
  const skipBuild = process.env.LEDGER_NO_REBUILD === "1";
  if ((rebuild && !skipBuild) || !existsSync(SERVER_ENTRY)) build();
  if (!existsSync(SERVER_ENTRY)) {
    say(`  no build output at ${SERVER_ENTRY}`);
    process.exit(1);
  }

  const out = openSync(LOG, "a");
  // node + the resolved .js, not the .bin shim: the shim is a .cmd on Windows and a
  // shell script elsewhere, and spawning either without a shell fails. The login
  // agent already runs it this way; this is the same reasoning for the manual start.
  const entry = serveEntry();
  const cmd = entry ? process.execPath : BIN("react-router-serve");
  const args = entry ? [entry, SERVER_ENTRY] : [SERVER_ENTRY];
  const child = spawn(cmd, args, {
    cwd: PROJECT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
    detached: true, // survives this shell closing
    stdio: ["ignore", out, out],
    shell: entry ? false : WIN,
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

/**
 * Whatever is listening on our port, whether or not we started it.
 *
 * A process launched at logon before this went through serve.mjs never wrote a pid
 * file, so stop() had nothing to kill and start() then lost the port to it — the old
 * build serving indefinitely while every restart claimed to have worked. This finds
 * it the only way left: by the port it is holding.
 */
function killByPort() {
  if (!WIN) return false;
  const out = spawnSync("netstat", ["-ano"], { encoding: "utf8" }).stdout || "";
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    if (!new RegExp(`[:.]${PORT}\\b`).test(line)) continue;
    const pid = line.trim().split(/\s+/).pop();
    if (/^\d+$/.test(pid) && pid !== "0") pids.add(pid);
  }
  for (const pid of pids) spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
  return pids.size > 0;
}

function stop({ quiet = false } = {}) {
  const pid = runningPid();
  if (!pid) {
    if (killByPort()) {
      if (!quiet) say(`  stopped whatever was holding port ${PORT}`);
      rmSync(PID_FILE, { force: true });
      return;
    }
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
  if (WIN) {
    // schtasks exits non-zero when the task does not exist, which is the whole query
    if (spawnSync("schtasks", ["/Query", "/TN", TASK_NAME], { stdio: "ignore" }).status === 0) return true;
    return existsSync(WIN_STARTUP_VBS);
  }
  return existsSync(AUTOSTART_FILE);
}

/**
 * A launcher the task can point at.
 *
 * schtasks /TR takes one command and no working directory, and quoting a long node
 * invocation through it is its own kind of misery. A one-line .cmd sidesteps both:
 * the task runs the file, the file sets the directory and the environment.
 */
function writeWinLauncher() {
  mkdirSync(dirname(WIN_LAUNCHER), { recursive: true });
  writeFileSync(
    WIN_LAUNCHER,
    [
      "@echo off",
      "rem Goes through serve.mjs rather than running the server directly, so a pid",
      "rem file is written. Without one nothing can find this process again: stop()",
      "rem killed nothing, start() then lost the port to it, and the old build served",
      "rem forever while every restart reported success.",
      `cd /d "${PROJECT}"`,
      `set "PORT=${PORT}"`,
      "set NODE_ENV=production",
      "set LEDGER_NO_REBUILD=1",
      `"${process.execPath}" "${resolve(PROJECT, "scripts", "serve.mjs")}" start`,
      "",
    ].join("\r\n")
  );
  return WIN_LAUNCHER;
}

/** The pid launchd/systemd is supervising, if it is the one running. */
function supervisedPid() {
  if (!autostartEnabled()) return null;
  try {
    if (WIN) {
      // When the task was refused and we fell back to the Startup folder there is no
      // task to query — and execSync passes the child's stderr straight through, so
      // asking printed "ERROR: The system cannot find the file specified." into the
      // middle of an otherwise successful install. Swallow it and answer from the pid
      // file, which the server writes either way.
      const q = spawnSync("schtasks", ["/Query", "/TN", TASK_NAME, "/FO", "LIST"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (q.status === 0) return /Status:\s*Running/i.test(q.stdout || "") ? (readPid() ?? 0) : null;
      // no task: the Startup-folder route is in play, so the pid file is all there is
      const pid = readPid();
      return pid && pidAlive(pid) ? pid : null;
    }
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

/**
 * Run at logon, without asking for an administrator.
 *
 * `schtasks /SC ONLOGON` with no /RU registers a task that fires for *any* user, and
 * that needs elevation — it comes back "ERROR: Access is denied." Naming the current
 * user scopes it to this account, which does not.
 *
 * If it still refuses — locked-down machines disable task creation outright — the
 * Startup folder always works, because it is just a file in your own profile. The
 * cost is a console window at logon, so it launches through a one-line VBScript that
 * runs the same launcher hidden.
 */
function registerWinLogon(launcher) {
  spawnSync("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"], { stdio: "ignore" }); // may not exist
  const who = process.env.USERNAME
    ? `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ""}${process.env.USERNAME}`
    : null;
  const args = ["/Create", "/TN", TASK_NAME, "/TR", `"${launcher}"`, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"];
  if (who) args.push("/RU", who);

  const r = spawnSync("schtasks", args, { stdio: "pipe", encoding: "utf8" });
  if (r.status === 0) {
    spawnSync("schtasks", ["/Run", "/TN", TASK_NAME], { stdio: "ignore" }); // it only fires at next logon
    return true;
  }
  say(`  the scheduled task was refused (${String(r.stderr || r.stdout || "").trim().split(/\r?\n/)[0]})`);
  say("  falling back to the Startup folder, which needs no permissions");

  try {
    mkdirSync(dirname(WIN_STARTUP_VBS), { recursive: true });
    // 0 = hidden window, false = do not wait
    writeFileSync(WIN_STARTUP_VBS, `CreateObject("WScript.Shell").Run """${launcher}""", 0, False\r\n`);
    spawn("wscript.exe", [WIN_STARTUP_VBS], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch (e) {
    say(`  could not write to the Startup folder either: ${e.message}`);
    return false;
  }
}

async function enable() {
  // Always, not just when the output is missing. Re-running the installer over an
  // existing copy pulls new source and then calls this — and a build that already
  // existed meant the new code was on disk while the old bundle carried on being
  // served. From the outside the update simply had not happened.
  //
  // start() has always rebuilt by default. This was the one path that did not.
  build();

  // hand the port over: a manually started copy would win the race on the next boot
  // and leave the supervised one flapping against EADDRINUSE
  stop({ quiet: true });

  const entry = serveEntry();
  if (!entry) {
    say("  cannot find @react-router/serve — run an install first.");
    process.exit(1);
  }
  mkdirSync(dirname(AGENT_LOG), { recursive: true });

  if (WIN) {
    const launcher = writeWinLauncher();
    if (!registerWinLogon(launcher)) process.exit(1);
  } else {
    mkdirSync(dirname(AUTOSTART_FILE), { recursive: true });
    writeFileSync(AUTOSTART_FILE, MAC ? agentPlist(entry) : systemdUnit(entry));
  }

  if (MAC) {
    spawnSync("launchctl", ["bootout", GUI(), AUTOSTART_FILE], { stdio: "ignore" }); // may not be loaded
    const r = spawnSync("launchctl", ["bootstrap", GUI(), AUTOSTART_FILE], { stdio: "pipe" });
    if (r.status !== 0) {
      say(`  launchctl refused it: ${String(r.stderr || "").trim() || "unknown error"}`);
      process.exit(1);
    }
  } else if (!WIN) {
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
  if (WIN) {
    spawnSync("schtasks", ["/End", "/TN", TASK_NAME], { stdio: "ignore" });
    spawnSync("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"], { stdio: "ignore" });
    rmSync(WIN_STARTUP_VBS, { force: true });
    rmSync(WIN_LAUNCHER, { force: true });
    stop({ quiet: true }); // the Startup route has no supervisor to stop it for us
    say("  automatic start disabled, and the server stopped.");
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
/** Is there actually a scheduled task, or did we fall back to the Startup folder? */
function winTaskExists() {
  return spawnSync("schtasks", ["/Query", "/TN", TASK_NAME], { stdio: "ignore" }).status === 0;
}

/**
 * Ask whatever supervises the process to cycle it.
 *
 * Returns false when nothing does, so the caller restarts it directly instead of
 * reporting a restart that never happened — which is what the Startup-folder route on
 * Windows did: schtasks commands aimed at a task that was never created, failing
 * silently because their output is discarded, while the old build carried on serving.
 * An update then looked like it had done nothing, because it had.
 */
function supervisedRestart() {
  if (WIN) {
    if (!winTaskExists()) return false; // Startup folder: nothing is watching it
    spawnSync("schtasks", ["/End", "/TN", TASK_NAME], { stdio: "ignore" });
    spawnSync("schtasks", ["/Run", "/TN", TASK_NAME], { stdio: "ignore" });
    return true;
  }
  if (MAC) {
    spawnSync("launchctl", ["kickstart", "-k", `${GUI()}/${AGENT_LABEL}`], { stdio: "ignore" });
  } else {
    spawnSync("systemctl", ["--user", "restart", "remote-ledger"], { stdio: "ignore" });
  }
  return true;
}

/** Stop it now. It still comes back at login unless `disable` is run. */
function supervisedStop() {
  // same asymmetry as restart: with no task there is nothing to end, so end it here
  if (WIN) {
    if (winTaskExists()) spawnSync("schtasks", ["/End", "/TN", TASK_NAME], { stdio: "ignore" });
    else stop({ quiet: true });
  } else if (MAC) spawnSync("launchctl", ["bootout", GUI(), AUTOSTART_FILE], { stdio: "ignore" });
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
      // A supervisor that quietly did nothing leaves the old build serving, and
      // "restarted." would then be a lie indistinguishable from a broken update.
      if (supervisedRestart()) {
        say((await reachable()) ? "  restarted." : `  restarted, but nothing answered on ${PORT} — check ${LOG}`);
        url();
      } else {
        stop({ quiet: true });
        await start({ rebuild: false });
      }
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
