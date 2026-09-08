import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const [profOpen, setProfOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const profBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!profOpen) return;
    const shut = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.(".sb-prof-pop, .sb-prof-menu")) setProfOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setProfOpen(false);
    document.addEventListener("click", shut);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("click", shut);
      document.removeEventListener("keydown", esc);
    };
  }, [profOpen]);
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
        {/*
          A menu rather than a list. Down here it sits with the other things you set
          once, and one row costs the rail no height however many profiles you keep —
          which was the problem with listing them all up top.
        */}
        <div className={`sb-prof-menu ${profOpen ? "open" : ""}`}>
          <button
            className="sb-item"
            ref={profBtn}
            onClick={() => {
              const r = profBtn.current?.getBoundingClientRect();
              // measured on open, so it follows the rail whether it is collapsed or pinned
              if (r) setAnchor({ left: Math.round(r.right + 8), top: Math.round(r.bottom - 8) });
              setProfOpen((v) => !v);
            }}
            title={`Searching for ${profiles.find((x) => x.id === currentProfile)?.name || "…"} — click to switch`}
          >
            <span className="sb-ico">
              <span className="sb-prof-dot on">
                {(profiles.find((x) => x.id === currentProfile)?.name || "?").trim().charAt(0).toUpperCase()}
              </span>
            </span>
            <span className="sb-label">{profiles.find((x) => x.id === currentProfile)?.name || "Profiles"}</span>
          </button>
          {/*
            Portalled to the body. The rail is position:fixed with a transform, which
            makes it the containing block even for a fixed child, and it clips its own
            overflow for the collapse animation — so a menu rendered inside it is cut
            off at the rail's edge however it is positioned. Same reason ConfirmForm
            portals its dialog.
          */}
          {profOpen && anchor && createPortal(
            <div className="sb-prof-pop" style={{ left: anchor.left, top: anchor.top }}>
              <div className="sb-prof-pop-title">Searching for</div>
              {profiles.map((x) => (
                <a
                  key={x.id}
                  href={`/?profile=${x.id}`}
                  className={`sb-prof ${x.id === currentProfile ? "on" : ""} ${x.active ? "" : "paused"}`}
                  title={x.active ? x.name : `${x.name} — paused, not searched`}
                >
                  <span className="sb-prof-dot">{x.name.trim().charAt(0).toUpperCase() || "?"}</span>
                  <span>{x.name}</span>
                </a>
              ))}
              {profiles.length > 1 && (
                <a href="/?profile=all" className="sb-prof">
                  <span className="sb-prof-dot all">∗</span>
                  <span>All profiles</span>
                </a>
              )}
              <a href="/settings?tab=Profiles" className="sb-prof add">
                <span className="sb-prof-dot plus">+</span>
                <span>{profiles.length > 1 ? "Manage profiles" : "Add another"}</span>
              </a>
            </div>,
            document.body
          )}
        </div>
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
