// POST /api/clip — the browser clipper sends a job here. Uses a simple
// (preflight-free) form POST and returns CORS headers so a bookmarklet on any
// site can save the current page as a job.
import type { Route } from "./+types/api-clip";
import { upsertJobs, setJd, ensureApplication, jobId } from "../db.server";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

export async function action({ request }: Route.ActionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  let url = "",
    title = "",
    jd = "",
    company = "",
    role = "";
  try {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const b = await request.json();
      ({ url = "", title = "", jd = "", company = "", role = "" } = b);
    } else {
      const f = await request.formData();
      url = String(f.get("url") || "");
      title = String(f.get("title") || "");
      jd = String(f.get("jd") || "");
      company = String(f.get("company") || "");
      role = String(f.get("role") || "");
    }
  } catch {}

  if (!/^https?:\/\//.test(url))
    return Response.json({ ok: false, error: "valid url required" }, { status: 400, headers: CORS });

  // best-effort company/role from the title ("Role - Company" / "Role at Company")
  if (!company || !role) {
    const t = title.replace(/\s+/g, " ").trim();
    const m = t.match(/^(.*?)(?:\s[-–|]\s|\s+at\s+)(.*)$/i);
    if (m) {
      role = role || m[1].trim();
      company = company || m[2].trim();
    } else {
      role = role || t || "Role";
      try {
        company = company || new URL(url).hostname.replace(/^www\./, "");
      } catch {
        company = company || "Unknown";
      }
    }
  }

  const id = jobId(company, role);
  upsertJobs([
    {
      id,
      company,
      role,
      category: "medium",
      fit_score: 0,
      stack: "clipped — run match in the job page",
      eligibility: "",
      apply_url: url,
      source: "clipped",
    },
  ]);
  if (jd) setJd(id, jd);
  ensureApplication(id);
  return Response.json({ ok: true, id }, { headers: CORS });
}

export async function loader() {
  return new Response(null, { status: 204, headers: CORS });
}
