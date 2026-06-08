import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { MessageSquare, X, Send } from "lucide-react";

// Floating chat to edit the default résumé by prompting the LLM. Each message posts the
// 'chat-edit' intent; the action applies the change to the default profile and returns a
// one-line summary, which we append as the assistant's reply. The page revalidates so the
// profile stats update live.
interface Msg { role: "you" | "agent"; text: string }
const SUGGESTIONS = [
  "Add a skill: Kubernetes",
  "Rewrite my summary to emphasize backend + distributed systems",
  "Add a project I built: …",
  "Tighten my most recent role to 3 strong bullets",
];

export function ResumeChat({ hasProfile }: { hasProfile: boolean }) {
  const fetcher = useFetcher();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const busy = fetcher.state !== "idle";

  // when the action replies, append the assistant summary
  useEffect(() => {
    const d: any = fetcher.data;
    if (fetcher.state === "idle" && d) {
      if (d.reply) setMsgs((m) => [...m, { role: "agent", text: d.reply }]);
      else if (d.error) setMsgs((m) => [...m, { role: "agent", text: `⚠ ${d.error}` }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, fetcher.state]);

  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [msgs, busy]);

  function send(message: string) {
    const m = message.trim();
    if (!m || busy) return;
    setMsgs((cur) => [...cur, { role: "you", text: m }]);
    setText("");
    fetcher.submit({ intent: "chat-edit", message: m }, { method: "post" });
  }

  return (
    <>
      <button className="rchat-fab" onClick={() => setOpen((o) => !o)} aria-label="Edit résumé with AI" title="Edit résumé with AI">
        {open ? <X size={20} /> : <MessageSquare size={20} />}
      </button>

      {open && (
        <div className="rchat">
          <div className="rchat-head">
            <strong>Résumé assistant</strong>
            <span className="rchat-sub">edits your default profile · never invents facts</span>
          </div>
          <div className="rchat-body" ref={bodyRef}>
            {!hasProfile ? (
              <div className="rchat-empty">Upload a base résumé first, then ask me to refine it.</div>
            ) : msgs.length === 0 ? (
              <div className="rchat-empty">
                Tell me what to add or change. e.g.
                <div className="rchat-sugs">
                  {SUGGESTIONS.map((s) => <button key={s} type="button" className="rchat-sug" onClick={() => send(s)}>{s}</button>)}
                </div>
              </div>
            ) : (
              msgs.map((m, i) => <div key={i} className={`rchat-msg ${m.role}`}>{m.text}</div>)
            )}
            {busy && <div className="rchat-msg agent rchat-typing">…updating your résumé</div>}
          </div>
          <form className="rchat-input" onSubmit={(e) => { e.preventDefault(); send(text); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={hasProfile ? "Add a skill, rewrite a bullet…" : "Upload a résumé first"} disabled={!hasProfile || busy} />
            <button type="submit" disabled={!hasProfile || busy || !text.trim()} aria-label="Send"><Send size={15} /></button>
          </form>
        </div>
      )}
    </>
  );
}
