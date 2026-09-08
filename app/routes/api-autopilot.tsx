// Start an autopilot run, and watch one.
//
// It is a resource route rather than an action on the job page because the run
// outlives the request that starts it: POST returns as soon as the work is under way,
// and the page follows it with GET. The job page's own loader still supplies the
// truth — what got built, what got tailored — this only says where the run has got to
// while that is still being decided.
import type { Route } from "./+types/api-autopilot";
import { startAutopilot, autopilotProgress, stopAutopilot } from "../services/autopilot.server";

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const jobId = String(form.get("jobId") || "");
  if (!jobId) return Response.json({ started: false, message: "which posting?" }, { status: 400 });

  if (String(form.get("intent") || "") === "stop") {
    const stopped = stopAutopilot(jobId);
    return Response.json({ stopped, progress: autopilotProgress(jobId) });
  }

  const r = startAutopilot(jobId);
  // 202 accepted — the point of this route is that the work has begun, not finished.
  // 409 for "already running": a refused second click is not a failure worth an error
  // banner, and the progress that comes back with it is the run already in flight.
  const status = r.started ? 202 : r.message === "no such posting" ? 404 : 409;
  return Response.json({ ...r, progress: autopilotProgress(jobId) }, { status });
}

export async function loader({ request }: Route.LoaderArgs) {
  const jobId = new URL(request.url).searchParams.get("job") || "";
  return Response.json({ progress: jobId ? autopilotProgress(jobId) : null });
}
