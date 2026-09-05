// Resource route: serve a cover-letter version as a formally formatted PDF.
// Rendered on demand and cached on the version row, exactly like résumé PDFs.
import { existsSync, readFileSync } from "node:fs";
import type { Route } from "./+types/cover-pdf";
import { getVersion, setVersionPdf } from "../resume/versions.server";
import { renderCoverPdf } from "../resume/pdf.server";
import { getProfile, getDefaultProfile } from "../resume/profiles.server";
import { getJob } from "../db.server";
import { getSetting } from "../sqlite.server";
import type { ResumeStyle } from "../resume/templates.server";

export async function loader({ params }: Route.LoaderArgs) {
  const v = getVersion(Number(params.vid));
  if (!v || v.kind !== "cover-letter" || !v.content_md) throw new Response("Not found", { status: 404 });

  let path = v.pdf_path;
  if (!path || !existsSync(path)) {
    // the letterhead is the candidate's identity, which lives on the résumé profile
    const profile = (v.profile_id ? getProfile(v.profile_id) : null) || getDefaultProfile();
    if (!profile) throw new Response("Upload a résumé first — the letterhead needs your name and contact details.", { status: 409 });
    const job = getJob(v.job_id);
    const style = ((v.style && v.style !== "letterpress" ? v.style : getSetting("default_resume_style")) ||
      "letterpress") as ResumeStyle;
    const r = await renderCoverPdf(
      v.content_md,
      profile.data.contact,
      { company: job?.company, role: job?.role, date: v.created_at ? new Date(v.created_at) : undefined },
      style,
      `cover-${v.job_id}-v${v.id}`
    );
    path = r.path;
    setVersionPdf(v.id, path);
  }

  const buf = readFileSync(path);
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="cover-letter-${v.job_id}-v${v.id}.pdf"`,
    },
  });
}
