import { useState } from "react";
import { ChevronRight, Square, CheckSquare, Sparkles, Wand2 } from "lucide-react";

export interface GapCandidate {
  id: number;
  label: string;
}

/**
 * One skill the posting wanted that nothing in the knowledge base evidences.
 *
 * A skill is rarely used in one place — Playwright at the QA job and again on a
 * side project — and a single-choice picker made you throw one of them away. So the
 * entries are ticked, not chosen, and every one you tick gets the skill and a bullet
 * of its own.
 *
 * The description is the important field. Left empty, a bullet is written from
 * whatever the entry already records, which is the weakest evidence available. A
 * sentence from you about what you actually did is the strongest, and it is the
 * thing the model is told to follow rather than embellish.
 *
 * Collapsed until you engage with it: nine of these open at once is a wall.
 */
export function GapRow({ skill, candidates }: { skill: string; candidates: GapCandidate[] }) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [dismissed, setDismissed] = useState(false);
  const [note, setNote] = useState("");
  const [drafting, setDrafting] = useState<"" | "blank" | "notes">("");
  const [problem, setProblem] = useState("");

  const toggle = (id: number) => {
    const next = new Set(picked);
    next.has(id) ? next.delete(id) : next.add(id);
    setPicked(next);
    if (next.size) setDismissed(false);
  };

  // Asks the server for words and puts them in the field. Deliberately not a form
  // action: submitting would re-render the page and lose every other row's ticks.
  async function draft(from: "blank" | "notes") {
    // A skill does not have to belong to a job on the résumé — it is routinely from a
    // volunteer role, a job left off, a course or their own time. Requiring an entry
    // first was either a dead end or a nudge to file it somewhere it did not happen.
    if (!picked.size && !note.trim()) {
      setProblem("Tick where you did this, or write a line about it — either one is enough.");
      return;
    }
    setProblem("");
    setDrafting(from);
    try {
      const body = new FormData();
      body.set("skill", skill);
      for (const id of picked) body.append("itemId", String(id));
      if (from === "notes") body.set("notes", note);
      const r = await fetch("/api/gap-draft", { method: "POST", body });
      const d = await r.json();
      if (d?.text) setNote(d.text);
      else setProblem(d?.error || "nothing came back");
    } catch {
      setProblem("could not reach the runner");
    } finally {
      setDrafting("");
    }
  }

  const summary = dismissed
    ? "set aside"
    : picked.size
      ? `${picked.size} place${picked.size === 1 ? "" : "s"}${note.trim() ? " · described" : ""}`
      : note.trim()
        // Answered without an employer. Worth saying out loud, because it is the case
        // the row used to refuse outright.
        ? "described · not tied to a job"
        : "not answered";

  return (
    <details className="gap-row">
      <summary>
        <ChevronRight className="gap-caret" size={13} strokeWidth={2} />
        <span className="gap-skill">{skill}</span>
        <span className={`badge ${picked.size ? "ok" : dismissed ? "off" : "warn"}`}>{summary}</span>
      </summary>

      <div className="gap-body">
        {/* the action walks these to know which skills were on the form at all */}
        <input type="hidden" name="gapSkill" value={skill} />
        {/* Nothing ticked but something written: a skill they have that belongs to no
            entry. Without this it was submitted as an unanswered gap and thrown away. */}
        {!picked.size && !dismissed && note.trim() ? (
          <input type="hidden" name={`gapLoose:${skill}`} value="1" />
        ) : null}
        <label className="gap-label">Where did you do this? Tick every place — or none, if it was somewhere not on your résumé.</label>
        <div className="gap-picks">
          {candidates.map((c) => (
            <label key={c.id} className="gap-pick">
              <input
                type="checkbox"
                className="gap-box-input"
                name={`gapEntry:${skill}`}
                value={c.id}
                checked={picked.has(c.id)}
                onChange={() => toggle(c.id)}
              />
              {picked.has(c.id)
                ? <CheckSquare className="gap-box on" size={15} strokeWidth={1.9} />
                : <Square className="gap-box" size={15} strokeWidth={1.9} />}
              <span>{c.label}</span>
            </label>
          ))}
        </div>

        <label className="gap-label" style={{ marginTop: 14 }}>
          How did you use it?{" "}
          <span style={{ textTransform: "none", letterSpacing: 0 }}>
            {picked.size ? "(optional, and the best thing you can give it)" : "(with nothing ticked above, this is the whole answer)"}
          </span>
        </label>
        <textarea
          name={`gapNote:${skill}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. wrote the end-to-end suite and wired it into CI, about 40 specs across two apps"
          style={{ minHeight: 76 }}
        />
        <div className="gap-actions">
          <button type="button" className="ghost-btn gap-btn" disabled={!!drafting} onClick={() => draft("blank")}>
            <Sparkles size={13} strokeWidth={1.8} />
            {drafting === "blank" ? "Drafting…" : picked.size ? "Draft it for me" : "Draft from my notes"}
          </button>
          <button type="button" className="ghost-btn gap-btn" disabled={!!drafting || !note.trim()} onClick={() => draft("notes")}>
            <Wand2 size={13} strokeWidth={1.8} />
            {drafting === "notes" ? "Tidying…" : "Tidy up my notes"}
          </button>
          <label className="gap-dismiss">
            <input
              type="checkbox"
              className="gap-box-input"
              name={`gapDismiss:${skill}`}
              checked={dismissed}
              onChange={(e) => {
                setDismissed(e.target.checked);
                if (e.target.checked) setPicked(new Set());
              }}
            />
            {dismissed ? <CheckSquare className="gap-box on" size={14} strokeWidth={1.9} /> : <Square className="gap-box" size={14} strokeWidth={1.9} />}
            I have not done this
          </label>
        </div>
        {problem && <p className="hint" style={{ color: "var(--vermillion)", textTransform: "none", letterSpacing: 0, margin: "8px 0 0" }}>{problem}</p>}
      </div>
    </details>
  );
}
