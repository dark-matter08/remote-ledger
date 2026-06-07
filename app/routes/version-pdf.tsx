// Resource route: serve a tailored résumé version as a PDF (render on demand).
import { existsSync, readFileSync } from "node:fs";
import type { Route } from "./+types/version-pdf";
import { getVersion, setVersionPdf } from "../resume/versions.server";
import { renderResumePdf } from "../resume/pdf.server";
import type { ResumeStyle } from "../resume/templates.server";

export async function loader({ params }: Route.LoaderArgs) {
  const v = getVersion(Number(params.vid));
  if (!v || v.kind !== "resume" || !v.data) throw new Response("Not found", { status: 404 });
  let path = v.pdf_path;
  if (!path || !existsSync(path)) {
    const r = await renderResumePdf(v.data, (v.style as ResumeStyle) || "letterpress", `${v.job_id}-v${v.id}`);
    path = r.path;
    setVersionPdf(v.id, path);
  }
  const buf = readFileSync(path);
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="resume-${v.job_id}-v${v.id}.pdf"`,
    },
  });
}
