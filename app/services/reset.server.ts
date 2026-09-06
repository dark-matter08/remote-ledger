// Empty the ledger and start over.
//
// Everything this app knows lives in one SQLite file and two folders, which makes a
// clean slate genuinely achievable — and worth offering, because the alternative is
// what people actually do: delete `data/` from a terminal, take the master key and
// the backups with it, and lose the one copy that could have undone the mistake.
//
// Three rules this is built around:
//
//   1. A backup is taken first, every time, no opt-out. It is written to
//      data/backups/ which nothing here ever deletes, so the very worst outcome of a
//      misclick is a restore, not a loss.
//   2. Nothing is cleared that was not named. The scopes below are independent, the
//      UI shows the live count for each one, and "everything" is just all of them
//      ticked — never a hidden extra.
//   3. What ships with the app comes back. Clearing the boards re-seeds the shipped
//      list rather than leaving an install with nowhere to look.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { getDb, transaction, reseedDefaultBoards, DB_PATH } from "../sqlite.server";
import { takeBackup, type BackupInfo } from "./backup.server";
import { isCrawlRunning, abortCrawl } from "./crawl.server";
import { activeCrawl } from "../db.server";

export type ResetScope =
  | "jobs"
  | "resumes"
  | "knowledge"
  | "email"
  | "history"
  | "boards"
  | "settings"
  | "keys";

interface ScopeDef {
  id: ResetScope;
  label: string;
  /** What goes, in one line, in the user's terms — shown next to the tick box. */
  what: string;
  /** The consequence worth knowing before ticking it. */
  caution?: string;
  /** A bare name empties the table; a pair narrows it to the rows this scope owns. */
  tables: (string | { table: string; where: string })[];
  /** Folders whose *contents* are removed; the folder itself stays. */
  dirs?: string[];
  /** Rows of `secrets` to drop, by name pattern. */
  secrets?: RegExp;
  /** The table whose row count stands for "how much is here". */
  countTable: string;
  countLabel: string;
}

// Off the database's own location rather than the working directory. Both resolve to
// the same folder in a normal install, but this one cannot be pointed at a real `data/`
// by a test or a script that happens to run from the repo root — and the mistake this
// avoids is deleting the wrong person's PDFs.
const DATA = () => dirname(DB_PATH);

export const RESET_SCOPES: ScopeDef[] = [
  {
    id: "jobs",
    label: "Jobs & applications",
    what: "Every posting on the board, the stage each one is at, your notes, the answer bank and the application screenshots.",
    caution: "Also clears the block list, so a crawl can find postings you previously trashed.",
    tables: [
      "jobs", "job_blocks", "applications", "application_events",
      "apply_sessions", "apply_session_jobs", "apply_logs", "apply_questions",
      "answer_bank",
      // `meta` is not a jobs table — it holds a per-job match, answer set and assist
      // log keyed by job id, alongside crawl bookkeeping and a couple of preferences
      // that have nothing to do with any posting. Only the first two belong here.
      {
        table: "meta",
        where:
          "key LIKE 'match:%' OR key LIKE 'answers:%' OR key LIKE 'assist:%' " +
          "OR key IN ('last_crawl','prev_crawl','last_crawl_status','last_careers_crawl')",
      },
    ],
    dirs: ["apply"],
    countTable: "jobs",
    countLabel: "jobs",
  },
  {
    id: "resumes",
    label: "Résumés & generated PDFs",
    what: "Your parsed base résumé, every tailored version, and the PDFs on disk.",
    caution: "You will need the original PDF to hand to set up again.",
    tables: ["resume_profiles", "resume_versions"],
    dirs: ["pdfs"],
    countTable: "resume_profiles",
    countLabel: "résumés",
  },
  {
    id: "knowledge",
    label: "Knowledge base",
    what: "Everything you told the Ledger about your work: entries, notes, open questions, drafted bullets and scanned folders.",
    caution: "This is the only place some of it exists — a folder scan reads code, not a transcript of what you said about it.",
    tables: ["kb_items", "kb_questions", "kb_suggestions", "kb_scans", "kb_sources"],
    countTable: "kb_items",
    countLabel: "entries",
  },
  {
    id: "email",
    label: "Inbox & mailbox passwords",
    what: "Connected mailboxes, the replies read from them, and the saved app passwords.",
    tables: ["email_accounts", "email_messages"],
    secrets: /^email_pw_/,
    countTable: "email_messages",
    countLabel: "messages",
  },
  {
    id: "history",
    label: "Crawl history & AI spend",
    what: "Every run in the Crawl Shell, its log, and the record of what each AI call cost.",
    caution: "Usage and Analytics are rebuilt from these, so both go back to zero.",
    tables: ["crawl_runs", "crawl_logs", "llm_calls"],
    countTable: "crawl_runs",
    countLabel: "runs",
  },
  {
    id: "boards",
    label: "Boards & career pages",
    what: "Every company and job board you track, however it got there — added by you, seeded by the app, or read back out of your own jobs. The four boards that ship with the app are put back.",
    // The marker has to go with them. It records which shipped boards were already
    // seeded, and seeding skips anything it names — so leaving it behind would empty
    // the registry permanently rather than resetting it.
    tables: ["companies", { table: "settings", where: "key='seeded_boards'" }],
    countTable: "companies",
    countLabel: "tracked",
  },
  {
    id: "settings",
    label: "Settings, profile & onboarding",
    what: "Chosen runner and model, budget, schedule, location and target stack — and the flag that says you finished setup.",
    caution: "Clearing this returns you to the opening screen.",
    tables: [
      "settings",
      // The other half of the split above: `meta` also holds preferences and crawl
      // bookkeeping, and those are settings by any reading — so with both scopes ticked
      // the table ends up genuinely empty rather than one stray row short of it.
      {
        table: "meta",
        where: "key NOT LIKE 'match:%' AND key NOT LIKE 'answers:%' AND key NOT LIKE 'assist:%'",
      },
    ],
    countTable: "settings",
    countLabel: "settings",
  },
  {
    id: "keys",
    label: "API keys",
    what: "Every provider key saved on this machine.",
    caution: "Keys set as environment variables are not stored here and are not touched.",
    tables: ["secrets"],
    countTable: "secrets",
    countLabel: "keys",
  },
];

export const ALL_SCOPES = RESET_SCOPES.map((s) => s.id);

export interface ScopePreview {
  id: ResetScope;
  label: string;
  what: string;
  caution?: string;
  count: number;
  countLabel: string;
}

/** How much is actually there, so nothing is ticked blind. */
export function resetPreview(): ScopePreview[] {
  const db = getDb();
  return RESET_SCOPES.map((s) => {
    let count = 0;
    try {
      count = Number((db.prepare(`SELECT COUNT(*) c FROM ${s.countTable}`).get() as any)?.c ?? 0);
    } catch {}
    return { id: s.id, label: s.label, what: s.what, caution: s.caution, count, countLabel: s.countLabel };
  });
}

export interface ResetResult {
  ok: boolean;
  message: string;
  /** Where the pre-reset copy went — the whole reason this is safe. */
  backup?: BackupInfo | null;
  cleared: { scope: ResetScope; rows: number; files: number }[];
  /** True when the settings went with it, so the caller knows to send them to setup. */
  toSetup: boolean;
}

/** Empty a folder's files without removing the folder itself. */
function emptyDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir)) {
    try {
      rmSync(join(dir, entry), { recursive: true, force: true });
      n++;
    } catch {}
  }
  return n;
}

/**
 * Clear the named scopes.
 *
 * A crawl mid-flight is the one thing that can undo this the instant it finishes —
 * it holds jobs in memory and writes them at the end — so a running one is stopped
 * and waited on before a single row is deleted.
 */
export async function performReset(scopes: ResetScope[]): Promise<ResetResult> {
  const wanted = RESET_SCOPES.filter((s) => scopes.includes(s.id));
  if (!wanted.length)
    return { ok: false, message: "Nothing was selected to clear.", cleared: [], toSetup: false };

  if (isCrawlRunning()) {
    const run = activeCrawl();
    if (run) abortCrawl(run.id);
    for (let i = 0; i < 12 && isCrawlRunning(); i++) await new Promise((r) => setTimeout(r, 250));
    if (isCrawlRunning())
      return {
        ok: false,
        message: "A crawl is still running. Stop it in the Crawl Shell, then clear.",
        cleared: [],
        toSetup: false,
      };
  }

  // Before anything, and never conditional: this is what makes the rest reversible.
  const backup = takeBackup("before-reset");
  if (!backup)
    return {
      ok: false,
      message: "Could not write a backup first, so nothing was cleared. Check that data/backups is writable.",
      cleared: [],
      toSetup: false,
    };

  const db = getDb();
  const cleared: ResetResult["cleared"] = [];

  // Clearing the settings wipes the seed marker as collateral, and putting the shipped
  // boards back on top of a registry the user kept would resurrect every default they
  // had deliberately deleted. Hold it across the wipe unless the boards are going too.
  const keepSeed =
    scopes.includes("settings") && !scopes.includes("boards")
      ? ((db.prepare("SELECT value FROM settings WHERE key='seeded_boards'").get() as { value: string } | undefined)?.value ?? null)
      : null;

  transaction(() => {
    for (const s of wanted) {
      let rows = 0;
      for (const t of s.tables) {
        const table = typeof t === "string" ? t : t.table;
        const where = typeof t === "string" ? "" : ` WHERE ${t.where}`;
        try {
          rows += Number(db.prepare(`DELETE FROM ${table}${where}`).run().changes ?? 0);
        } catch {} // a table a much older ledger never created
      }
      if (s.secrets) {
        const names = (db.prepare("SELECT name FROM secrets").all() as { name: string }[])
          .filter((r) => s.secrets!.test(r.name));
        const drop = db.prepare("DELETE FROM secrets WHERE name=?");
        for (const n of names) rows += Number(drop.run(n.name).changes ?? 0);
      }
      cleared.push({ scope: s.id, rows, files: 0 });
    }
    if (keepSeed !== null)
      db.prepare("INSERT INTO settings (key,value) VALUES ('seeded_boards',?)").run(keepSeed);
  });

  // Files after the rows commit: an orphaned PDF is litter, a row pointing at a
  // deleted file is a broken download.
  for (const s of wanted) {
    if (!s.dirs) continue;
    const entry = cleared.find((c) => c.scope === s.id)!;
    for (const d of s.dirs) entry.files += emptyDir(resolve(DATA(), d));
  }

  // The shipped boards are part of the product, not of your data: clearing the
  // registry has to put them back or the install is left with nowhere to look.
  if (scopes.includes("boards")) reseedDefaultBoards();

  // Reclaim the space now rather than leaving a 4 MB file holding nothing. Neither
  // statement can run inside a transaction, hence out here — and in WAL mode the
  // vacuum lands in the log, so without the checkpoint the file on disk stays exactly
  // as large as it was and "cleared" looks like a lie to anyone who checks.
  try { db.exec("VACUUM"); } catch {}
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}

  const rows = cleared.reduce((n, c) => n + c.rows, 0);
  const files = cleared.reduce((n, c) => n + c.files, 0);
  return {
    ok: true,
    message:
      `Cleared ${rows.toLocaleString()} row${rows === 1 ? "" : "s"}` +
      (files ? ` and ${files} file${files === 1 ? "" : "s"}` : "") +
      `. A copy of everything as it was is in ${backup.path}.`,
    backup,
    cleared,
    toSetup: scopes.includes("settings"),
  };
}
