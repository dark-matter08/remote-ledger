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
  const [update, setUpdate] = useState<{ behind: number; latest: string; subject: string } | null>(null);
  const [updating, setUpdating] = useState(false);

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
  // await. Wait for it to answer again, then reload onto the new build.
  async function takeUpdate() {
    if (!update || updating) return;
    setUpdating(true);
    const body = new FormData();
    body.set("to", update.latest);
    const r = await fetch("/api/update", { method: "POST", body }).catch(() => null);
    if (!r?.ok) { setUpdating(false); return; }
    const started = Date.now();
    const poll = setInterval(async () => {
      if (Date.now() - started > 5 * 60_000) { clearInterval(poll); setUpdating(false); return; }
      const alive = await fetch("/api/update", { cache: "no-store" }).then((x) => x.ok).catch(() => false);
      if (alive) { clearInterval(poll); location.reload(); }
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

  return (
    <aside className={`sidebar ${pinned ? "pinned" : ""}`}>
      <div className="sb-top">
        <Link to="/" className="sb-brand" title="The Remote & Ledger">❦</Link>
        <span className="sb-word">The Remote <span className="sb-amp">&amp;</span> Ledger</span>
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
        {update && (
          <button
            className="sb-item"
            onClick={takeUpdate}
            disabled={updating}
            style={{ color: "var(--vermillion)" }}
            title={
              updating
                ? "Updating — the app restarts in a moment"
                : `${update.behind} update(s) waiting: ${update.subject}. Click to take them and restart.`
            }
          >
            <span className="sb-ico"><ArrowUpCircle size={18} strokeWidth={1.7} /></span>
            <span className="sb-label">{updating ? "Updating…" : "Update available"}</span>
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
