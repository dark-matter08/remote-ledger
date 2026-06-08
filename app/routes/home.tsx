import { useEffect, useMemo, useState } from "react";
import { Link, useFetcher, redirect } from "react-router";
import { ChevronDown, Archive } from "lucide-react";
import type { Route } from "./+types/home";
import { Shell } from "../components/Shell";
import { getSetting } from "../sqlite.server";
import { ensureScheduler } from "../services/scheduler.server";
import { getLedger, updateNotes, setStage, archiveJob } from "../db.server";
import { QUICK_STAGES, STAGE_LABEL, type Job, type Stage, type Category } from "../stages";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "The Remote & Ledger" },
    { name: "description", content: "Remote-eligible roles, tailored and tracked — set in type." },
  ];
}

export async function loader() {
  // first run → onboarding wizard
  if (getSetting("setup_complete") !== "true") throw redirect("/setup");
  ensureScheduler();
  return { ...getLedger(), location: getSetting("profile_location") || "Remote" };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");
  const id = String(form.get("id") || "");
  if (intent === "stage") setStage(id, String(form.get("stage")) as Stage);
  else if (intent === "archive") archiveJob(id);
  else if (intent === "notes") updateNotes(id, String(form.get("notes") || ""));
  return { ok: true };
}

const CATEGORY_META: Record<Category, { title: string; tag: string; cls: string }> = {
  high: { title: "High Probability", tag: "Type A · Apply now", cls: "sh-high" },
  medium: { title: "Medium Probability", tag: "Type B · Strong fit, higher bar", cls: "sh-medium" },
  stretch: { title: "Stretch", tag: "Type C · Worth a shot", cls: "sh-stretch" },
};
const ORDER: Category[] = ["high", "medium", "stretch"];

const STACK_TAGS: { label: string; test: RegExp }[] = [
  { label: "Node/TS", test: /node|typescript|\bts\b|react|express|nest|fullstack|full-stack|full stack/i },
  { label: "Infra", test: /terraform|docker|k8s|kubernetes|devops|cloud|aws|gcp|ci\/cd|sre|ansible|infra/i },
  { label: "AI/LLM", test: /\bai\b|llm|\bml\b|training|rlhf/i },
];

function fmtCrawl(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "unknown";
  const m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${m[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDisc(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
}

function FitMeter({ value }: { value: number }) {
  return (
    <div className="meter-row">
      <div className="meter" aria-hidden>
        <span className="fill" style={{ ["--target" as any]: `${value}%` }} />
      </div>
      <span className="meter-val">{value}/100</span>
    </div>
  );
}

function StageDropdown({
  job,
  open,
  onOpenChange,
  onStamp,
}: {
  job: Job;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onStamp: (label: string) => void;
}) {
  const fetcher = useFetcher();
  const pending = fetcher.formData?.get("stage") as Stage | undefined;
  const current = (pending as Stage) || job.stage;
  function choose(s: Stage) {
    onOpenChange(false);
    if (s !== job.stage) {
      fetcher.submit({ intent: "stage", id: job.id, stage: s }, { method: "post" });
      if (s === "applied" || s === "interview" || s === "offer") onStamp(STAGE_LABEL[s]);
    }
  }
  function archive() {
    onOpenChange(false);
    fetcher.submit({ intent: "archive", id: job.id }, { method: "post" });
  }
  return (
    <div className={`dd st-${current}`} data-open={open ? "" : undefined} onClick={(e) => e.stopPropagation()}>
      <button type="button" className="dd-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => onOpenChange(!open)}>
        <span className="dd-dot" />
        <span className="dd-label">{STAGE_LABEL[current]}</span>
        <span className="dd-caret"><ChevronDown size={13} /></span>
      </button>
      {open && (
        <ul className="dd-menu" role="listbox">
          {QUICK_STAGES.map((s) => (
            <li key={s} role="option" aria-selected={s === current} className={`st-${s}`} onClick={() => choose(s)}>
              <span className="dd-dot" />
              {STAGE_LABEL[s]}
            </li>
          ))}
          <li role="option" className="dd-archive" onClick={archive}>
            <Archive size={13} /> Archive
          </li>
        </ul>
      )}
    </div>
  );
}

function Entry({ job, index, openId, setOpenId }: { job: Job; index: number; openId: string | null; setOpenId: (id: string | null) => void }) {
  const open = openId === job.id;
  const [stamp, setStamp] = useState<{ label: string; key: number } | null>(null);
  const closed = job.stage === "rejected" || job.stage === "withdrawn";
  const standing =
    job.stage === "applied" || job.stage === "interview" || job.stage === "offer" ? STAGE_LABEL[job.stage] : null;
  return (
    <article className={`entry ${job.category} ${open ? "is-open" : ""} ${closed ? "passed" : ""}`}>
      <span className="accent" />
      {job.is_new && (
        <span className="hot">Hot off<br />the press</span>
      )}
      {stamp ? (
        <div key={stamp.key} className="status-stamp slam">{stamp.label}</div>
      ) : standing ? (
        <div className="status-stamp">{standing}</div>
      ) : null}
      <div className="num">№ {pad2(index)} <span className="disc" title={`Discovered ${job.first_seen}`}>· disc. {fmtDisc(job.first_seen)}</span></div>
      <h3>
        <Link to={`/jobs/${job.id}`} className="entry-title-link">{job.company}</Link>
      </h3>
      <div className="role">{job.role}</div>
      <FitMeter value={job.fit_score} />
      <div className="fine">
        {job.stack}
        {job.eligibility ? (<><br />{job.eligibility}</>) : null}
        {job.closes_at ? (<><br /><span className="closes">▲ Closes {job.closes_at}</span></>) : null}
      </div>
      <div className="actions">
        <a className="stamp" href={job.apply_url} target="_blank" rel="noreferrer">Apply ▸</a>
        <StageDropdown job={job} open={open} onOpenChange={(o) => setOpenId(o ? job.id : null)} onStamp={(l) => setStamp({ label: l, key: Date.now() })} />
        <Link to={`/jobs/${job.id}`} className="ghost-btn">Open ▸</Link>
      </div>
    </article>
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const data = loaderData;
  const [cats, setCats] = useState<Set<Category>>(new Set(["high", "medium", "stretch"]));
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [hidePassed, setHidePassed] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"fit" | "closing" | "company">("fit");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (t && t.closest(".dd")) return;
      setOpenId(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenId(null);
    }
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  function toggleCat(c: Category) {
    setCats((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next.size ? next : new Set(ORDER);
    });
  }
  function toggleTag(t: string) {
    setTags((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  const sections = useMemo(() => {
    const query = q.trim().toLowerCase();
    return ORDER.filter((c) => cats.has(c)).map((c) => {
      let jobs = data.groups[c] || [];
      jobs = jobs.filter((j) => {
        if (hidePassed && (j.stage === "rejected" || j.stage === "withdrawn")) return false;
        const hay = `${j.company} ${j.role} ${j.stack ?? ""} ${j.eligibility ?? ""} ${j.source ?? ""}`;
        if (query && !hay.toLowerCase().includes(query)) return false;
        if (tags.size) {
          for (const t of tags) {
            const m = STACK_TAGS.find((x) => x.label === t);
            if (m && !m.test.test(hay)) return false;
          }
        }
        return true;
      });
      const sorted = [...jobs].sort((a, b) => {
        if (sort === "fit") return b.fit_score - a.fit_score;
        if (sort === "company") return a.company.localeCompare(b.company);
        const av = a.closes_at || "9999-12-31";
        const bv = b.closes_at || "9999-12-31";
        return av.localeCompare(bv);
      });
      return { category: c, jobs: sorted };
    });
  }, [data.groups, cats, tags, hidePassed, q, sort]);

  const shown = sections.reduce((n, s) => n + s.jobs.length, 0);
  const sortLabel = sort === "fit" ? "Fit" : sort === "closing" ? "Closing" : "A–Z";

  return (
    <Shell>
      <header className="masthead">
        <div className="eyebrow">No. 001 · Remote &amp; {data.location}-Eligible · Set in Type</div>
        <h1 className="title">The Remote <span className="amp">&amp;</span> Ledger</h1>
        <hr className="rule double" style={{ marginTop: 18 }} />
        <div className="dateline">
          <span>{data.location} · Est. MMXXVI</span>
          <span className="crawl">
            <span className="live-dot" />
            Updated every 4 hours · last crawl {fmtCrawl(data.lastCrawl)}
          </span>
          <span>{data.total} on file{data.newCount > 0 ? ` · ${data.newCount} new` : ""}</span>
        </div>
        <hr className="rule double" />
      </header>

      <div className="fleuron">❦</div>

      <div className="toolbar">
        <button className={`chip ${cats.size === 3 ? "on" : ""}`} onClick={() => setCats(new Set(ORDER))}>All</button>
        <button className={`chip red ${cats.has("high") ? "on" : ""}`} onClick={() => toggleCat("high")}>High</button>
        <button className={`chip ${cats.has("medium") ? "on" : ""}`} onClick={() => toggleCat("medium")}>Medium</button>
        <button className={`chip ${cats.has("stretch") ? "on" : ""}`} onClick={() => toggleCat("stretch")}>Stretch</button>
        <span className="sep">·</span>
        {STACK_TAGS.map((t) => (
          <button key={t.label} className={`chip ${tags.has(t.label) ? "on" : ""}`} onClick={() => toggleTag(t.label)}>{t.label}</button>
        ))}
        <span className="sep">·</span>
        <button className={`chip ${hidePassed ? "on" : ""}`} onClick={() => setHidePassed((v) => !v)}>Hide passed</button>
        <button className="chip on" style={{ display: "inline-flex", alignItems: "center", gap: 5 }} onClick={() => setSort((s) => (s === "fit" ? "closing" : s === "closing" ? "company" : "fit"))}>Sort: {sortLabel} <ChevronDown size={12} /></button>
        <input className="search" placeholder="Search the ledger…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <hr className="rule thin" />

      {sections.map(({ category, jobs }) => {
        const cm = CATEGORY_META[category];
        return (
          <section key={category}>
            <div className="section-head">
              <h2>{cm.title}</h2>
              <span className={`tag ${cm.cls}`}>{cm.tag}</span>
              <span className="count">{jobs.length} entries</span>
            </div>
            {jobs.length === 0 ? (
              <div className="ledger empty">— no entries match the current filters —</div>
            ) : (
              <div className="ledger">
                {jobs.map((job, i) => (
                  <Entry key={job.id} job={job} index={i + 1} openId={openId} setOpenId={setOpenId} />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {shown === 0 && (
        <p className="colophon" style={{ marginTop: 40 }}>Nothing matches. Clear a filter to bring the ledger back.</p>
      )}

      <div className="fleuron" style={{ marginTop: 48 }}>❦ ❦ ❦</div>
      <hr className="rule double" />
      <p className="colophon">The Remote Ledger · printed locally · no telemetry · set in Fraunces, Spectral &amp; Plex Mono · crawl status: {data.lastCrawlStatus ?? "—"}</p>
    </Shell>
  );
}
