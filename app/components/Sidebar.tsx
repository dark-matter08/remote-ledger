import { useEffect, useState } from "react";
import { NavLink, Link } from "react-router";
import {
  Newspaper,
  TerminalSquare,
  KanbanSquare,
  Hourglass,
  Archive,
  BarChart3,
  Send,
  FileText,
  BrainCircuit,
  Mail,
  Scissors,
  Gauge,
  Settings,
  Moon,
  Sun,
  PanelLeftOpen,
  PanelLeftClose,
  ArrowUpCircle,
  type LucideIcon,
} from "lucide-react";

const GROUPS: { title: string; items: { to: string; label: string; Icon: LucideIcon; end?: boolean }[] }[] = [
  {
    title: "Track",
    items: [
      { to: "/", label: "Ledger", Icon: Newspaper, end: true },
      { to: "/crawl", label: "Crawl Shell", Icon: TerminalSquare },
      { to: "/board", label: "Pipeline", Icon: KanbanSquare },
      { to: "/expired", label: "Expired", Icon: Hourglass },
      { to: "/archive", label: "Archive", Icon: Archive },
      { to: "/analytics", label: "Analytics", Icon: BarChart3 },
    ],
  },
  {
    title: "Act",
    items: [
      { to: "/apply", label: "Auto-Apply", Icon: Send },
      { to: "/resume", label: "Résumés", Icon: FileText },
      { to: "/knowledge", label: "Knowledge Base", Icon: BrainCircuit },
      { to: "/inbox", label: "Application Mail", Icon: Mail },
      { to: "/clipper", label: "Clipper", Icon: Scissors },
    ],
  },
  {
    title: "System",
    items: [
      { to: "/usage", label: "Usage", Icon: Gauge },
      { to: "/settings", label: "Settings", Icon: Settings },
    ],
  },
];

export function Sidebar() {
  const [pinned, setPinned] = useState(false);
  const [theme, setTheme] = useState<"paper" | "night">("paper");
  const [pending, setPending] = useState(0);
  const [update, setUpdate] = useState<{ behind: number; latest: string; current: string; subject: string } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    setPinned(localStorage.getItem("ledger-sidebar") === "pinned");
    setTheme((localStorage.getItem("ledger-theme") as "night" | "paper") || "paper");
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      fetch("/api/pending")
        .then((r) => r.json())
        .then((d) => { if (alive) setPending(d.questions || 0); })
        .catch(() => {});
    tick();
    const t = setInterval(tick, 12000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // A release is not urgent, and the check reaches the network — twice an hour is
  // plenty to notice one within a working day.
  useEffect(() => {
    let alive = true;
    const tick = () =>
      fetch("/api/update")
        .then((r) => r.json())
        .then((d) => { if (alive) setUpdate(d?.behind > 0 ? d : null); })
        .catch(() => {});
    tick();
    const t = setInterval(tick, 30 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // The server goes down partway through its own answer, so there is nothing to
  // await — but it is also UP for nearly all of the update, so "does it respond"
  // proves nothing either. The commit it reports is the only thing that moves only
  // once the new code is actually the code being served.
  async function takeUpdate() {
    if (!update || updating) return;
    setUpdating(true);
    setProblem("");
    const from = update.current;
    const body = new FormData();
    body.set("to", update.latest);
    const r = await fetch("/api/update", { method: "POST", body }).catch(() => null);
    const said = await r?.json().catch(() => null);
    if (!r?.ok) {
      setUpdating(false);
      setProblem(said?.message || "the update was refused");
      return;
    }

    const started = Date.now();
    const poll = setInterval(async () => {
      // a refused connection here is the restart itself; keep waiting
      const d = await fetch("/api/update?local=1", { cache: "no-store" }).then((x) => x.json()).catch(() => null);
      if (d?.current && d.current !== from) { clearInterval(poll); location.reload(); return; }
      if (Date.now() - started > 6 * 60_000) {
        clearInterval(poll);
        setUpdating(false);
        // the child is detached, so this file is its only account of itself
        setProblem((d?.log || []).slice(-3).join(" · ") || "the update did not finish — see logs/update.log");
      }
    }, 3000);
  }

  function togglePin() {
    const next = !pinned;
    setPinned(next);
    try { localStorage.setItem("ledger-sidebar", next ? "pinned" : ""); } catch {}
  }
  function toggleTheme() {
    const next = theme === "night" ? "paper" : "night";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("ledger-theme", next); } catch {}
  }

  const [profiles, setProfiles] = useState<{ id: string; name: string; active: boolean }[]>([]);
  const [currentProfile, setCurrent] = useState<string>("");
  useEffect(() => {
    let alive = true;
    fetch("/api/profiles")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setProfiles(d.profiles || []);
        setCurrent(d.current || "");
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  return (
    <aside className={`sidebar ${pinned ? "pinned" : ""}`}>
      <div className="sb-top">
        <Link to="/" className="sb-brand" title="The Remote & Ledger">❦</Link>
        <span className="sb-word">The Remote <span className="sb-amp">&amp;</span> Ledger</span>
      </div>

      {/*
        The switcher is here as much to say the feature exists as to be used: with one
        profile it still shows, worded as an invitation, because a control that only
        appears once you already know about it teaches nobody.
      */}
      <div className="sb-profiles">
        <div className="sb-group-title">Searching for</div>
        {profiles.map((p) => (
          <a
            key={p.id}
            href={`/?profile=${p.id}`}
            onClick={() => { void fetch("/api/profiles", { method: "POST", body: new URLSearchParams({ id: p.id }) }); }}
            className={`sb-prof ${p.id === currentProfile ? "on" : ""} ${p.active ? "" : "paused"}`}
            title={p.active ? p.name : `${p.name} — paused, not searched`}
          >
            {/* the initial, not a bare dot: collapsed to a rail of icons, an unlabelled
                square reads as an artefact rather than a control you can press */}
            <span className="sb-prof-dot">{p.name.trim().charAt(0).toUpperCase() || "?"}</span>
            <span className="sb-label">{p.name}</span>
          </a>
        ))}
        {profiles.length > 1 && (
          <a href="/?profile=all" className={`sb-prof ${currentProfile === "all" ? "on" : ""}`} title="Every profile at once">
            <span className="sb-prof-dot all">∗</span>
            <span className="sb-label">All profiles</span>
          </a>
        )}
        <a href="/settings" className="sb-prof add" title="Add or edit profiles">
          <span className="sb-prof-dot plus">+</span>
          <span className="sb-label">{profiles.length > 1 ? "Manage" : "Add another"}</span>
        </a>
      </div>

      <nav className="sb-nav">
        {GROUPS.map((g) => (
          <div key={g.title} className="sb-group">
            <div className="sb-group-title">{g.title}</div>
            {g.items.map(({ to, label, Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                title={to === "/apply" && pending > 0 ? `${label} — ${pending} question(s) need answers` : label}
                className={({ isActive }) => `sb-item ${isActive ? "active" : ""}`}
              >
                <span className="sb-ico"><Icon size={18} strokeWidth={1.7} /></span>
                <span className="sb-label">{label}</span>
                {to === "/apply" && pending > 0 && <span className="sb-badge" />}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="sb-bottom">
        {(update || problem) && (
          <button
            className="sb-item"
            onClick={takeUpdate}
            disabled={updating}
            style={{ color: problem ? "var(--ochre)" : "var(--vermillion)" }}
            title={
              problem
                ? `${problem} — click to try again`
                : updating
                  ? "Updating — this takes a minute; the page reloads itself when the new build is serving"
                  : `${update!.behind} update(s) waiting: ${update!.subject}. Click to take them and restart.`
            }
          >
            <span className="sb-ico"><ArrowUpCircle size={18} strokeWidth={1.7} /></span>
            <span className="sb-label">{updating ? "Updating…" : problem ? "Update failed" : "Update available"}</span>
            {!updating && <span className="sb-badge" />}
          </button>
        )}
        <button className="sb-item" onClick={toggleTheme} title="Toggle day / night">
          <span className="sb-ico">{theme === "night" ? <Sun size={18} strokeWidth={1.7} /> : <Moon size={18} strokeWidth={1.7} />}</span>
          <span className="sb-label">{theme === "night" ? "Day Press" : "Night Press"}</span>
        </button>
        <button className="sb-item" onClick={togglePin} title={pinned ? "Collapse sidebar" : "Expand sidebar"}>
          <span className="sb-ico">{pinned ? <PanelLeftClose size={18} strokeWidth={1.7} /> : <PanelLeftOpen size={18} strokeWidth={1.7} />}</span>
          <span className="sb-label">{pinned ? "Collapse" : "Expand"}</span>
        </button>
      </div>
    </aside>
  );
}
