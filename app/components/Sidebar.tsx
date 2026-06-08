import { useEffect, useState } from "react";
import { NavLink, Link } from "react-router";
import {
  Newspaper,
  TerminalSquare,
  KanbanSquare,
  Hourglass,
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
        <button className="sb-item" onClick={toggleTheme} title="Toggle day / night">
          <span className="sb-ico">{theme === "night" ? <Sun size={18} strokeWidth={1.7} /> : <Moon size={18} strokeWidth={1.7} />}</span>
          <span className="sb-label">{theme === "night" ? "Day Press" : "Night Press"}</span>
        </button>
        <button className="sb-item" onClick={togglePin} title={pinned ? "Unpin sidebar" : "Pin sidebar open"}>
          <span className="sb-ico">{pinned ? <PanelLeftClose size={18} strokeWidth={1.7} /> : <PanelLeftOpen size={18} strokeWidth={1.7} />}</span>
          <span className="sb-label">{pinned ? "Unpin" : "Pin open"}</span>
        </button>
      </div>
    </aside>
  );
}
