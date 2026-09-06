// POST /api/clip — the browser clipper sends a job here. Uses a simple
// (preflight-free) form POST and returns CORS headers so a bookmarklet on any
// site can save the current page as a job.
import type { Route } from "./+types/api-clip";
import { upsertJobs, setJd, ensureApplication, jobId } from "../db.server";
import { enrichClip } from "../services/clip.server";

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
    jdHtml = "",
    company = "",
    role = "";
  try {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const b = await request.json();
      ({ url = "", title = "", jd = "", jdHtml = "", company = "", role = "" } = b);
    } else {
      const f = await request.formData();
      url = String(f.get("url") || "");
      title = String(f.get("title") || "");
      jd = String(f.get("jd") || "");
      jdHtml = String(f.get("jdHtml") || "");
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

  // Saved first and read second. The popup is waiting on this response, and the
  // reading takes an LLM call and possibly a page fetch — so the row lands now, and
  // enrichClip fills it in as its own Crawl Shell run. Nothing here is left as a
  // placeholder pretending to be data: the fields it cannot know stay empty until
  // something has actually read the posting.
  const id = jobId(company, role);
  upsertJobs([
    {
      id,
      company,
      role,
      category: "medium",
      fit_score: 0,
      stack: null,
      eligibility: null,
      apply_url: url,
      source: "clipped",
    },
  ]);
  if (jd) setJd(id, jd);
  ensureApplication(id);
  void enrichClip({ id, url, jd, jdHtml, company, role });

  // The bookmarklet submits a form into a new tab, so a browser lands here asking for
  // a page. Send it to the job it just saved; the extension, which asks for JSON,
  // still gets JSON.
  if ((request.headers.get("accept") || "").includes("text/html"))
    return new Response(null, { status: 303, headers: { ...CORS, location: `/jobs/${encodeURIComponent(id)}` } });
  return Response.json({ ok: true, id }, { headers: CORS });
}

export async function loader() {
  return new Response(null, { status: 204, headers: CORS });
}
