import { useState } from "react";
import { createPortal } from "react-dom";
import { useFetcher } from "react-router";
import { Select } from "./Select";
import { TRASH_REASONS, hostOf, type BlockScope } from "../trash";

// Throwing a job out is different from archiving it: archive only sets active=0, and
// the next crawl that finds the posting flips it straight back. This records WHY, so
// the crawler is told about it, and at WHAT SCOPE, so one action can clear every
// posting from an aggregator instead of you swatting them one at a time.
export function TrashDialog({
  job,
  onClose,
}: {
  job: { id: string; company: string; role: string; apply_url: string };
  onClose: () => void;
}) {
  const fetcher = useFetcher();
  const [reason, setReason] = useState("irrelevant");
  const [scope, setScope] = useState<BlockScope>("job");
  const [note, setNote] = useState("");
  const host = hostOf(job.apply_url);
  const busy = fetcher.state !== "idle";

  const scopes: { value: BlockScope; label: string }[] = [
    { value: "job", label: "Just this posting" },
    { value: "company", label: `Everything from ${job.company}` },
    ...(host ? [{ value: "domain" as BlockScope, label: `Everything hosted on ${host}` }] : []),
  ];

  function submit() {
    fetcher.submit({ intent: "trash", id: job.id, reason, scope, note }, { method: "post" });
    onClose();
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Throw this out for good?</h3>
        <p className="modal-body">
          <strong>{job.role}</strong> at {job.company} is deleted, not archived, and no future crawl
          will bring it back. What you pick here is fed to the crawler so it stops finding this kind
          of thing.
        </p>

        <div className="field">
          <label>Why</label>
          <Select
            name="reason"
            value={reason}
            onChange={setReason}
            options={TRASH_REASONS.map((r) => ({ value: r.code, label: r.label }))}
          />
        </div>

        <div className="field">
          <label>Also block</label>
          <Select
            name="scope"
            value={scope}
            onChange={(v) => setScope(v as BlockScope)}
            options={scopes.map((s) => ({ value: s.value, label: s.label }))}
          />
        </div>

        <div className="field">
          <label>Anything else the crawler should know (optional)</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{ minHeight: 56 }}
            placeholder="e.g. says worldwide but only hires in the US"
          />
        </div>

        <div className="modal-actions">
          <button type="button" className="ghost-btn" onClick={onClose} autoFocus>
            Cancel
          </button>
          <button type="button" className="btn danger" disabled={busy} onClick={submit}>
            {busy ? "Removing…" : "Trash it"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
