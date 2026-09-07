// Running a command on Windows, safely.
//
// npm, pnpm, dropport and caddy are all .cmd shims, and CreateProcess cannot execute
// a batch file — spawning one without a shell fails with ENOENT. That is what stopped
// the installer immediately after cloning the repository.
//
// A shell means cmd.exe receives a command *line* rather than an argument vector, so
// anything containing a space has to be quoted here or it arrives as two arguments.
// Windows home directories are full of spaces, so this is the common case, not the
// edge case: C:\Users\Jane Doe\.remote-ledger\app.
import { platform } from "node:os";

export const isWindows = platform() === "win32";

/** Characters that make cmd.exe treat a word as more than one thing. */
const NEEDS_QUOTES = /[\s&|<>^"]/;

export function quoteArg(value) {
  const s = String(value);
  if (!NEEDS_QUOTES.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * A command and arguments ready for spawnSync with `shell` set on Windows, and
 * untouched everywhere else — quoting a POSIX argv would put literal quotes in it.
 */
export function winSafe(cmd, args, win = isWindows) {
  if (!win) return [cmd, args];
  return [quoteArg(cmd), args.map(quoteArg)];
}
