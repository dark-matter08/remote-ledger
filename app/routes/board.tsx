import { useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/board";
import { Shell } from "../components/Shell";
import { getBoard, setStage } from "../db.server";
import { STAGES, STAGE_LABEL, type Stage, type Job } from "../stages";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Pipeline · The Remote Ledger" }];
}

export async function loader() {
  return { board: getBoard(), stages: STAGES, labels: STAGE_LABEL };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  if (form.get("intent") === "move") {
    setStage(String(form.get("id")), String(form.get("stage")) as Stage);
  }
  return { ok: true };
}

const STAGE_CLS: Record<string, string> = {
  saved: "sh-stretch",
  applied: "sh-medium",
  screening: "sh-medium",
  interview: "sh-stretch",
  offer: "sh-high",
  rejected: "",
  withdrawn: "",
};

export default function Board({ loaderData }: Route.ComponentProps) {
  const { board, stages, labels } = loaderData;
  const fetcher = useFetcher();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<Stage | null>(null);

  // optimistic move
  const pendingMove = fetcher.formData
    ? { id: String(fetcher.formData.get("id")), stage: String(fetcher.formData.get("stage")) as Stage }
    : null;

  function columnsFor(stage: Stage): Job[] {
    let jobs = board[stage] || [];
    if (pendingMove) {
      jobs = jobs.filter((j) => j.id !== pendingMove.id);
      if (pendingMove.stage === stage) {
        const moved = Object.values(board).flat().find((j) => j.id === pendingMove.id);
        if (moved) jobs = [{ ...moved, stage }, ...jobs];
      }
    }
    return jobs;
  }

  function drop(stage: Stage) {
    if (dragId) fetcher.submit({ intent: "move", id: dragId, stage }, { method: "post" });
    setDragId(null);
    setOverStage(null);
  }

  return (
    <Shell wide>
      <div className="page-head">
        <h1>Pipeline</h1>
        <div className="sub">Drag a job across stages · Saved → Offer</div>
      </div>
      <hr className="rule double" />
      <div className="board">
        {stages.map((s) => {
          const jobs = columnsFor(s);
          return (
            <div
              key={s}
              className={`board-col ${overStage === s ? "over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setOverStage(s); }}
              onDragLeave={() => setOverStage((cur) => (cur === s ? null : cur))}
              onDrop={() => drop(s)}
            >
              <div className={`board-col-head ${STAGE_CLS[s]}`}>
                <span>{labels[s]}</span>
                <span className="board-count">{jobs.length}</span>
              </div>
              <div className="board-col-body">
                {jobs.map((j) => (
                  <div
                    key={j.id}
                    className="board-card"
                    draggable
                    onDragStart={() => setDragId(j.id)}
                    onDragEnd={() => setDragId(null)}
                  >
                    <Link to={`/jobs/${j.id}`} className="board-card-title">{j.company}</Link>
                    <div className="board-card-role">{j.role}</div>
                    <div className="board-card-fit">fit {j.fit_score} · {j.category}</div>
                  </div>
                ))}
                {jobs.length === 0 && <div className="board-empty">—</div>}
              </div>
            </div>
          );
        })}
      </div>
    </Shell>
  );
}
