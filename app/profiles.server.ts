// Job profiles: one per line of work you are searching for.
//
// There used to be exactly one search, held as three rows in `settings`
// (profile_field, profile_location, profile_stack). Everything downstream read
// them — the crawl prompt, the relevance vocabulary in app/fields.ts, the feed
// filters, the scorer — so a second line of work meant overwriting the first and
// losing it. This is that, made plural.
//
// The three settings rows are still written through from the default profile, so
// an install part-way through an update cannot read nothing. They are removed in
// the release after this one.
import { getDb, getSetting, setSetting, transaction } from "./sqlite.server";
import { DEFAULT_FIELD } from "./fields";
import { DEFAULT_BOARDS } from "./default-boards";

export interface Profile {
  id: string;
  name: string;
  field: string;
  location: string;
  stack: string;
  prompt: string | null;
  resume_profile_id: string | null;
  active: number;
  sort_order: number;
  last_crawled_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Legible, stable, and unique — the id is used to namespace job ids. */
export function profileSlug(name: string, taken: string[] = []): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "profile";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

export function listProfiles(): Profile[] {
  return getDb()
    .prepare("SELECT * FROM profiles ORDER BY sort_order, created_at")
    .all() as unknown as Profile[];
}

/** The ones a crawl searches for. An inactive profile is kept, just not searched. */
export function activeProfiles(): Profile[] {
  return listProfiles().filter((p) => p.active);
}

export function getProfile(id: string): Profile | null {
  return (getDb().prepare("SELECT * FROM profiles WHERE id=?").get(id) as unknown as Profile) || null;
}

/**
 * The profile a page should show when it has not been told which.
 *
 * Never null once the migration has run — but an install whose profiles were all
 * deleted would otherwise land on a page with nothing to render, so this makes one
 * rather than leaving the app in a state with no way out.
 */
export function currentProfile(): Profile {
  const chosen = getSetting("current_profile");
  if (chosen) {
    const p = getProfile(chosen);
    if (p) return p;
  }
  const first = listProfiles()[0];
  if (first) return first;
  return createProfile({ name: "My search", field: DEFAULT_FIELD });
}

export function setCurrentProfile(id: string | null) {
  setSetting("current_profile", id || "");
}

export function createProfile(input: {
  name: string;
  field: string;
  location?: string;
  stack?: string;
  prompt?: string | null;
  resume_profile_id?: string | null;
}): Profile {
  const now = new Date().toISOString();
  const id = profileSlug(input.name, listProfiles().map((p) => p.id));
  const order = (listProfiles().at(-1)?.sort_order ?? -1) + 1;
  getDb()
    .prepare(
      `INSERT INTO profiles (id, name, field, location, stack, prompt, resume_profile_id, active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    )
    .run(
      id,
      input.name.trim() || "Untitled",
      input.field || DEFAULT_FIELD,
      input.location || "",
      input.stack || "",
      input.prompt ?? null,
      input.resume_profile_id ?? null,
      order,
      now,
      now
    );
  const made = getProfile(id)!;
  seedBoardsFor(id);
  syncLegacySettings(made);
  return made;
}

/**
 * Give a new profile the shipped boards.
 *
 * Boards belong to a profile now, so a profile created with none has nowhere to
 * crawl — it would run, find nothing, and look broken. It gets the same starting
 * list a fresh install gets.
 *
 * Deletions still stick: the seeding is per-URL against this profile's own rows, so
 * a board removed from one profile is not handed back by another profile's creation.
 */
export function seedBoardsFor(profileId: string) {
  const db = getDb();
  const has = db.prepare("SELECT 1 FROM companies WHERE profile_id=? AND careers_url=?");
  const insert = db.prepare(
    "INSERT INTO companies (name,kind,ats,slug,careers_url,active,note,created_at,profile_id) VALUES (?,'board',NULL,NULL,?,1,?,?,?)"
  );
  const now = new Date().toISOString();
  for (const b of DEFAULT_BOARDS) {
    if (!has.get(profileId, b.url)) insert.run(b.name, b.url, b.note, now, profileId);
  }
}

export function updateProfile(id: string, patch: Partial<Omit<Profile, "id" | "created_at">>): Profile | null {
  const cur = getProfile(id);
  if (!cur) return null;
  const cols = ["name", "field", "location", "stack", "prompt", "resume_profile_id", "active", "sort_order"] as const;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const c of cols) {
    if (patch[c] === undefined) continue;
    sets.push(`${c}=?`);
    vals.push(patch[c] as unknown);
  }
  if (!sets.length) return cur;
  sets.push("updated_at=?");
  vals.push(new Date().toISOString(), id);
  getDb().prepare(`UPDATE profiles SET ${sets.join(", ")} WHERE id=?`).run(...(vals as never[]));
  const next = getProfile(id)!;
  syncLegacySettings(next);
  return next;
}

/**
 * Remove a profile, and decide what happens to what it found.
 *
 * `keepJobs` leaves the postings behind under no profile, which sounds tidy and is
 * not: they would be invisible on every board and impossible to act on. So the
 * choice is between moving them to another profile or deleting them with it, and
 * the caller has to say which.
 */
export function deleteProfile(id: string, opts: { moveTo?: string; deleteJobs?: boolean }): { jobs: number } {
  const p = getProfile(id);
  if (!p) return { jobs: 0 };
  const db = getDb();
  return transaction(() => {
    const n = (db.prepare("SELECT count(*) AS n FROM jobs WHERE profile_id=?").get(id) as { n: number }).n;
    if (opts.moveTo && getProfile(opts.moveTo)) {
      db.prepare("UPDATE jobs SET profile_id=? WHERE profile_id=?").run(opts.moveTo, id);
      db.prepare("UPDATE companies SET profile_id=? WHERE profile_id=?").run(opts.moveTo, id);
    } else {
      db.prepare("DELETE FROM jobs WHERE profile_id=?").run(id);
      db.prepare("DELETE FROM companies WHERE profile_id=?").run(id);
    }
    db.prepare("DELETE FROM profiles WHERE id=?").run(id);
    if (getSetting("current_profile") === id) setSetting("current_profile", "");
    const left = listProfiles()[0];
    if (left) syncLegacySettings(left);
    return { jobs: n };
  });
}

/**
 * Keep the old settings rows in step with the profile in use.
 *
 * Nothing new should read these. They exist so that a machine running a half-updated
 * copy — one whose code still reaches for profile_field — reads the truth rather than
 * an empty string. Deleted in the release after this one.
 */
/** Records that a crawl has just searched for this profile, so a rotation is fair. */
export function touchProfileCrawled(id: string) {
  getDb().prepare("UPDATE profiles SET last_crawled_at=? WHERE id=?").run(new Date().toISOString(), id);
}

export function syncLegacySettings(p: Profile) {
  setSetting("profile_field", p.field);
  setSetting("profile_location", p.location);
  setSetting("profile_stack", p.stack);
}
