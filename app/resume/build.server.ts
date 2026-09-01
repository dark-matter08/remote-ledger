// Build a résumé out of the Knowledge Base.
//
// The KB knows what you have BUILT — projects, company experience, the skills that
// show up in your code. It does not know who you ARE: name, contact and education
// exist only on a résumé you parsed. So a build always starts from a base profile
// for identity and grafts the selected KB material on, rather than pretending it
// can conjure a résumé from nothing.
//
// Until now this connection existed only sideways: accepting a drafted bullet on
// /knowledge appended it to whichever profile happened to be default, with no
// selection and no preview. This makes it something you drive.
import { getDb } from "../sqlite.server";
import { getProfile, getDefaultProfile, saveProfile, listProfiles } from "./profiles.server";
import type { Resume, ResumeExperience, ResumeProject } from "./types";

export interface KbBuildSource {
  id: number;
  kind: string; // project | experience | skill | fact
  title: string;
  summary: string;
  tags: string[];
  role: string | null;
  start_date: string | null;
  end_date: string | null;
  location: string | null;
  bullets: string[];
}

const safeTags = (raw: unknown): string[] => {
  try {
    const v = JSON.parse(String(raw || "[]"));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

/**
 * Everything in the KB that could go on a résumé, with the bullets already drafted
 * for it. Dismissed bullets are excluded: you already said no to those.
 */
export function kbBuildSources(): KbBuildSource[] {
  const db = getDb();
  const items = db.prepare("SELECT * FROM kb_items ORDER BY updated_at DESC").all() as any[];
  const bulletsFor = db.prepare(
    "SELECT bullet FROM kb_suggestions WHERE item_id=? AND status <> 'dismissed' ORDER BY status='accepted' DESC, id"
  );
  return items.map((i) => ({
    id: i.id,
    kind: i.kind,
    title: i.title,
    summary: i.summary || "",
    tags: safeTags(i.tags),
    role: i.role ?? null,
    start_date: i.start_date ?? null,
    end_date: i.end_date ?? null,
    location: i.location ?? null,
    bullets: (bulletsFor.all(i.id) as { bullet: string }[]).map((b) => b.bullet),
  }));
}

/** Every distinct skill the KB has seen, most common first. */
export function kbAllSkills(): string[] {
  const counts = new Map<string, { label: string; n: number }>();
  for (const s of kbBuildSources()) {
    for (const t of s.tags) {
      const k = t.toLowerCase();
      const hit = counts.get(k);
      if (hit) hit.n++;
      else counts.set(k, { label: t, n: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)).map((v) => v.label);
}

const norm = (s: string) => s.toLowerCase().trim();

function toExperience(s: KbBuildSource): ResumeExperience {
  return {
    company: s.title,
    role: s.role || "",
    start: s.start_date || "",
    end: s.end_date || "",
    location: s.location || "",
    bullets: [...s.bullets],
  };
}
function toProject(s: KbBuildSource): ResumeProject {
  return { name: s.title, bullets: [...s.bullets] };
}

/** Add an entry without creating a second copy of something already there. */
function mergeExperience(into: ResumeExperience[], add: ResumeExperience): void {
  const hit = into.find((e) => norm(e.company || "") === norm(add.company));
  if (!hit) {
    into.unshift(add);
    return;
  }
  hit.role ||= add.role;
  hit.start ||= add.start;
  hit.end ||= add.end;
  hit.location ||= add.location;
  hit.bullets = hit.bullets || [];
  for (const b of add.bullets) if (!hit.bullets.includes(b)) hit.bullets.push(b);
}
function mergeProject(into: ResumeProject[], add: ResumeProject): void {
  const hit = into.find((p) => norm(p.name || "") === norm(add.name));
  if (!hit) {
    into.unshift(add);
    return;
  }
  hit.bullets = hit.bullets || [];
  for (const b of add.bullets) if (!hit.bullets.includes(b)) hit.bullets.push(b);
}

export type BuildInclude = "base-plus" | "kb-only";

/**
 * Compose a résumé from chosen KB items.
 *
 * include "base-plus" keeps everything already on the base profile and adds the
 * selection; "kb-only" keeps identity and education but rebuilds the experience,
 * projects and skills purely from what you picked — which is what you want when
 * your strongest evidence is your own projects rather than your job history.
 */
export function composeFromKb(
  base: Resume,
  picks: KbBuildSource[],
  skills: string[],
  include: BuildInclude
): Resume {
  const experience: ResumeExperience[] = include === "base-plus" ? structuredClone(base.experience || []) : [];
  const projects: ResumeProject[] = include === "base-plus" ? structuredClone(base.projects || []) : [];

  for (const p of picks) {
    if (p.kind === "experience") mergeExperience(experience, toExperience(p));
    else mergeProject(projects, toProject(p));
  }

  const seen = new Set<string>();
  const merged: string[] = [];
  const addSkill = (s: string) => {
    const k = norm(s);
    if (!k || seen.has(k)) return;
    seen.add(k);
    merged.push(s);
  };
  if (include === "base-plus") (base.skills || []).forEach(addSkill);
  skills.forEach(addSkill);

  return {
    contact: base.contact,
    summary: base.summary,
    education: base.education || [],
    experience,
    projects,
    skills: merged,
  };
}

export function buildResumeFromKb(o: {
  baseProfileId?: string | null;
  itemIds: number[];
  skills?: string[];
  include?: BuildInclude;
  mode: "new" | "merge";
  targetProfileId?: string | null;
  name?: string;
  makeDefault?: boolean;
}): { profileId?: string; added?: number; error?: string } {
  const profiles = listProfiles();
  if (!profiles.length)
    return { error: "Upload or paste a résumé first — the Knowledge Base has your work, but not your name, contact details or education." };

  // merging writes into the target itself; a new profile borrows identity from the base
  const identitySource =
    o.mode === "merge"
      ? o.targetProfileId
        ? getProfile(o.targetProfileId)
        : getDefaultProfile()
      : o.baseProfileId
        ? getProfile(o.baseProfileId)
        : getDefaultProfile();
  if (!identitySource) return { error: "That résumé profile no longer exists." };

  const wanted = new Set(o.itemIds.map(Number));
  const picks = kbBuildSources().filter((s) => wanted.has(s.id));
  const skills = (o.skills || []).map((s) => s.trim()).filter(Boolean);
  if (!picks.length && !skills.length) return { error: "Pick at least one project, role, or skill to include." };

  // merging is always additive — it must never delete what is already on the profile
  const include: BuildInclude = o.mode === "merge" ? "base-plus" : (o.include ?? "base-plus");
  const data = composeFromKb(identitySource.data, picks, skills, include);

  const name =
    o.mode === "merge"
      ? identitySource.name
      : (o.name || "").trim() || `${identitySource.name} + knowledge base`;

  const profileId = saveProfile({
    id: o.mode === "merge" ? identitySource.id : undefined,
    name,
    data,
    makeDefault: o.makeDefault,
  });
  return { profileId, added: picks.length };
}

// --- picking what is relevant to one job ------------------------------------

const STOP = new Set(
  "the a an and or of to for with in on at by from as is are be we you your our their this that will can must have has".split(" ")
);
function tokens(s: string): Set<string> {
  return new Set(
    String(s || "")
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((t) => t.length > 1 && !STOP.has(t))
  );
}

/**
 * Rank KB items against a job, without spending a token. Tags carry the most signal
 * (they are the concrete stack), so they are weighted hardest; the bullets and
 * summary describe what was actually done and count for less.
 */
export function rankKbForJob(
  jobText: string,
  limit = 6
): { source: KbBuildSource; score: number }[] {
  const jd = tokens(jobText);
  if (!jd.size) return [];
  const scored = kbBuildSources().map((source) => {
    // plain, explicit overlap counts — nothing here should need debugging later
    let score = 0;
    for (const t of source.tags) for (const w of tokens(t)) if (jd.has(w)) score += 3;
    for (const w of tokens(source.summary)) if (jd.has(w)) score += 1;
    for (const b of source.bullets) for (const w of tokens(b)) if (jd.has(w)) score += 1;
    return { source, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.source.title.localeCompare(b.source.title))
    .slice(0, limit);
}
