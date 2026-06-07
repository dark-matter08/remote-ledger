#!/usr/bin/env node
// Cross-platform installer for an OS-level crawl schedule. Generates the schedule
// from AUTO-DETECTED paths (no hardcoding), so it works on any machine after clone.
// The built-in in-app scheduler already covers "while the app runs"; this is the
// optional background option.
//
// Usage: node scripts/os-scheduler.mjs <install|uninstall|status|run> [hours]
import { execSync } from "node:child_process";
import { writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir, platform } from "node:os";

const ACTION = process.argv[2] || "status";
const HOURS = Number(process.argv[3] || "4") || 4;
const PROJECT = process.cwd();
const NODE = process.execPath;
const TSX = resolve(PROJECT, "node_modules", ".bin", platform() === "win32" ? "tsx.cmd" : "tsx");
const ENTRY = resolve(PROJECT, "scripts", "run-crawl.ts");
const LABEL = "com.remoteledger.crawl";
const LOG = resolve(PROJECT, "logs", "os-crawl.log");
mkdirSync(resolve(PROJECT, "logs"), { recursive: true });

function sh(cmd) {
  try {
    return execSync(cmd, { stdio: "pipe" }).toString().trim();
  } catch (e) {
    return (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
  }
}

// ---------- macOS (launchd) ----------
function mac() {
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${TSX}</string><string>${ENTRY}</string>
  </array>
  <key>StartInterval</key><integer>${HOURS * 3600}</integer>
  <key>RunAtLoad</key><false/>
  <key>WorkingDirectory</key><string>${PROJECT}</string>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string></dict>
</dict></plist>`;
  if (ACTION === "install") {
    writeFileSync(plistPath, plist);
    sh(`launchctl unload "${plistPath}" 2>/dev/null`);
    console.log(sh(`launchctl load "${plistPath}"`) || `Loaded ${LABEL} (every ${HOURS}h).`);
    console.log("Installed:", plistPath);
  } else if (ACTION === "uninstall") {
    sh(`launchctl unload "${plistPath}" 2>/dev/null`);
    if (existsSync(plistPath)) rmSync(plistPath);
    console.log("Uninstalled", LABEL);
  } else if (ACTION === "status") {
    console.log(sh(`launchctl list | grep ${LABEL}`) || "Not loaded.");
  }
}

// ---------- Linux (systemd user units) ----------
function linux() {
  const dir = join(homedir(), ".config", "systemd", "user");
  const svc = join(dir, `${LABEL}.service`);
  const tmr = join(dir, `${LABEL}.timer`);
  if (ACTION === "install") {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      svc,
      `[Unit]\nDescription=Remote Ledger crawl\n[Service]\nType=oneshot\nWorkingDirectory=${PROJECT}\nExecStart=${TSX} ${ENTRY}\n`
    );
    writeFileSync(
      tmr,
      `[Unit]\nDescription=Remote Ledger crawl timer\n[Timer]\nOnUnitActiveSec=${HOURS}h\nOnBootSec=10min\nPersistent=true\n[Install]\nWantedBy=timers.target\n`
    );
    sh("systemctl --user daemon-reload");
    console.log(sh(`systemctl --user enable --now ${LABEL}.timer`) || `Enabled ${LABEL}.timer (every ${HOURS}h).`);
  } else if (ACTION === "uninstall") {
    sh(`systemctl --user disable --now ${LABEL}.timer`);
    [svc, tmr].forEach((f) => existsSync(f) && rmSync(f));
    sh("systemctl --user daemon-reload");
    console.log("Uninstalled", LABEL);
  } else if (ACTION === "status") {
    console.log(sh(`systemctl --user status ${LABEL}.timer --no-pager`) || "Not installed.");
  }
}

// ---------- Windows (Task Scheduler) ----------
function win() {
  if (ACTION === "install") {
    const cmd = `schtasks /Create /SC HOURLY /MO ${HOURS} /TN "${LABEL}" /TR "\\"${TSX}\\" \\"${ENTRY}\\"" /F`;
    console.log(sh(cmd) || "Task created.");
  } else if (ACTION === "uninstall") {
    console.log(sh(`schtasks /Delete /TN "${LABEL}" /F`));
  } else if (ACTION === "status") {
    console.log(sh(`schtasks /Query /TN "${LABEL}"`) || "Not found.");
  }
}

if (ACTION === "run") {
  console.log("Running one crawl…");
  execSync(`"${TSX}" "${ENTRY}"`, { stdio: "inherit", cwd: PROJECT });
} else {
  const p = platform();
  if (p === "darwin") mac();
  else if (p === "linux") linux();
  else if (p === "win32") win();
  else console.log("Unsupported platform:", p, "— use the in-app scheduler instead.");
}
