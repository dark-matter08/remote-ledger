// Builds the knowledge graph: one connected web of everything the agent knows about
// YOU (skills, projects) and the JOBS you've engaged (companies, sources, stages),
// plus the KB (scanned/typed projects and your answered questions). Pure data — the
// client renders it with either engine.
import { getDb } from "../sqlite.server";
import { getDefaultProfile } from "../resume/profiles.server";
import { kbItems, kbOpenQuestions } from "./kb.server";

export type NodeType = "self" | "skill" | "project" | "job" | "company" | "source" | "stage" | "qa" | "contact";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  val: number;        // size weight (degree-ish)
  href?: string;      // deep link to the entity's page
  detail?: string;    // shown in the side panel
  meta?: Record<string, any>;
}
export interface GraphLink { source: string; target: string; kind: string }
export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  counts: Record<string, number>;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").trim();
const tokenRe = (skill: string) => {
  const t = skill.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`, "i");
};

export function buildGraph(): GraphData {
  const db = getDb();
  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];
  const addNode = (n: GraphNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return nodes.get(n.id)!; };
  const bump = (id: string, by = 1) => { const n = nodes.get(id); if (n) n.val += by; };
  const link = (source: string, target: string, kind: string) => {
    if (!nodes.has(source) || !nodes.has(target) || source === target) return;
    links.push({ source, target, kind }); bump(source); bump(target);
  };

  const profile = getDefaultProfile();
  const me = profile?.data.contact?.name || "You";
  addNode({ id: "self", type: "self", label: me, val: 6, href: "/resume", detail: profile ? `${profile.data.experience?.length || 0} roles · ${profile.data.projects?.length || 0} projects · ${profile.data.skills?.length || 0} skills` : "No résumé yet" });

  // ---- skills (from résumé + KB tags) ----
  const skillId = (s: string) => `skill:${norm(s)}`;
  const addSkill = (s: string) => {
    const id = skillId(s);
    if (!nodes.has(id)) { addNode({ id, type: "skill", label: s, val: 2, detail: "Skill" }); link("self", id, "knows"); }
    return id;
  };
  for (const s of profile?.data.skills || []) addSkill(s);

  // ---- KB projects + their tags + answered questions ----
  for (const it of kbItems()) {
    const pid = `kbproj:${it.id}`;
    addNode({ id: pid, type: "project", label: it.title, val: 3, href: "/knowledge", detail: it.summary, meta: { source: it.source } });
    link("self", pid, "built");
    for (const t of it.tags || []) link(addSkill(t), pid, "uses");
  }
  // answered questions as small leaves on their KB project
  const answered = db.prepare("SELECT id, item_id, question, answer FROM kb_questions WHERE answer IS NOT NULL").all() as any[];
  for (const q of answered) {
    if (q.item_id == null) continue;
    const pid = `kbproj:${q.item_id}`;
    if (!nodes.has(pid)) continue;
    const qid = `qa:${q.id}`;
    addNode({ id: qid, type: "qa", label: q.question.slice(0, 60), val: 1, detail: `Q: ${q.question}\nA: ${q.answer}` });
    link(pid, qid, "answered");
  }

  // ---- résumé projects ----
  for (const p of profile?.data.projects || []) {
    const pid = `rproj:${norm(p.name)}`;
    addNode({ id: pid, type: "project", label: p.name, val: 3, href: "/resume", detail: (p.bullets || []).join(" · ").slice(0, 240) });
    link("self", pid, "built");
  }

  // ---- jobs + company + source + stage + skill matches ----
  const skillList = [...nodes.values()].filter((n) => n.type === "skill");
  const jobs = db.prepare(`
    SELECT j.id, j.company, j.role, j.source, j.stack, j.fit_score, j.category, substr(COALESCE(j.jd,''),0,2400) jd,
           COALESCE(a.stage,'saved') stage
    FROM jobs j LEFT JOIN applications a ON a.job_id=j.id
    WHERE j.active=1`).all() as any[];

  for (const j of jobs) {
    const jid = `job:${j.id}`;
    addNode({ id: jid, type: "job", label: `${j.company} — ${j.role}`, val: 3, href: `/jobs/${j.id}`, detail: `${j.category} · fit ${j.fit_score} · ${j.stage}`, meta: { fit: j.fit_score, stage: j.stage } });

    if (j.company) { const cid = `company:${norm(j.company)}`; if (!nodes.has(cid)) addNode({ id: cid, type: "company", label: j.company, val: 2 }); link(jid, cid, "at"); }
    if (j.source) { const sid = `source:${norm(j.source)}`; if (!nodes.has(sid)) addNode({ id: sid, type: "source", label: j.source, val: 1 }); link(jid, sid, "via"); }
    const stid = `stage:${j.stage}`; if (!nodes.has(stid)) addNode({ id: stid, type: "stage", label: j.stage, val: 2, detail: "Pipeline stage" }); link(jid, stid, "stage");

    // connect skills the job calls for
    const hay = `${j.stack || ""} ${j.role || ""} ${j.jd || ""}`;
    let matched = 0;
    for (const sk of skillList) {
      if (matched >= 8) break;
      if (tokenRe(sk.label).test(hay)) { link(sk.id, jid, "needs"); matched++; }
    }
  }

  // ---- recruiter / contact people from matched application mail ----
  try {
    const contacts = db.prepare(
      "SELECT from_addr, from_name, job_id, COUNT(*) n, MAX(category) category FROM email_messages WHERE job_id IS NOT NULL AND from_addr IS NOT NULL AND from_addr<>'' GROUP BY from_addr, job_id"
    ).all() as any[];
    for (const c of contacts) {
      const jid = `job:${c.job_id}`;
      if (!nodes.has(jid)) continue;
      const cid = `contact:${norm(c.from_addr)}`;
      if (!nodes.has(cid)) addNode({ id: cid, type: "contact", label: c.from_name || c.from_addr, val: 2, detail: `${c.from_addr}${c.category ? ` · ${c.category}` : ""}` });
      link(cid, jid, "contact");
    }
  } catch { /* email tables may not exist on old DBs */ }

  const counts: Record<string, number> = {};
  for (const n of nodes.values()) counts[n.type] = (counts[n.type] || 0) + 1;
  return { nodes: [...nodes.values()], links, counts };
}
