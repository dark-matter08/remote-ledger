// Resume HTML templates. Each returns a complete, self-contained HTML document
// sized for A4 that Playwright renders to PDF. Styles: letterpress (matches the
// app), modern, compact, ats-plain (maximally machine-parseable).
import type { Resume, ResumeContact } from "./types";

export type ResumeStyle = "letterpress" | "modern" | "compact" | "ats-plain";
export const RESUME_STYLES: ResumeStyle[] = ["letterpress", "modern", "compact", "ats-plain"];

const esc = (s?: string) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function dates(a?: string, b?: string) {
  const x = [a, b].filter(Boolean).join(" – ");
  return x ? esc(x) : "";
}

function sectionsHtml(r: Resume, opts: { bulletTag?: string } = {}) {
  const contact = r.contact || { name: "" };
  const links = (contact.links || []).map((l) => `<a href="${esc(l.url)}">${esc(l.label || l.url)}</a>`).join(" · ");
  const contactLine = [contact.email, contact.phone, contact.location].filter(Boolean).map(esc).join(" · ");

  const exp = (r.experience || [])
    .map(
      (e) => `
    <div class="item">
      <div class="item-head"><span class="org">${esc(e.company)}</span><span class="when">${dates(e.start, e.end)}</span></div>
      <div class="item-sub"><span class="role">${esc(e.role)}</span>${e.location ? `<span class="where">${esc(e.location)}</span>` : ""}</div>
      <ul>${(e.bullets || []).map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
    </div>`
    )
    .join("");

  const proj = (r.projects || []).length
    ? `<h2>Projects</h2>${(r.projects || [])
        .map(
          (p) => `
    <div class="item">
      <div class="item-head"><span class="org">${esc(p.name)}</span><span class="when">${dates(p.start, p.end)}</span></div>
      ${p.role ? `<div class="role">${esc(p.role)}</div>` : ""}
      <ul>${(p.bullets || []).map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
    </div>`
        )
        .join("")}`
    : "";

  const edu = (r.education || []).length
    ? `<h2>Education</h2>${(r.education || [])
        .map(
          (e) => `
    <div class="item">
      <div class="item-head"><span class="org">${esc(e.school)}</span><span class="when">${dates(e.start, e.end)}</span></div>
      <div class="role">${esc(e.degree)}${e.detail ? ` · ${esc(e.detail)}` : ""}</div>
    </div>`
        )
        .join("")}`
    : "";

  return `
    <header class="resume-header">
      <h1>${esc(contact.name)}</h1>
      ${contact.title ? `<div class="title">${esc(contact.title)}</div>` : ""}
      <div class="contact">${[contactLine, links].filter(Boolean).join(" · ")}</div>
    </header>
    ${r.summary ? `<h2>Summary</h2><p class="summary">${esc(r.summary)}</p>` : ""}
    ${(r.skills || []).length ? `<h2>Skills</h2><p class="skills">${(r.skills || []).map(esc).join(" · ")}</p>` : ""}
    <h2>Experience</h2>${exp}
    ${proj}
    ${edu}
  `;
}

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,900&family=Spectral:ital,wght@0,400;0,500;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">`;

// Shared layout primitives so company/dates and role/location always sit on opposite
// sides of a line (the clean two-column résumé header) and never run together.
const ROWS = `
  * { box-sizing: border-box; }
  .item-head, .item-sub { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
  .org { flex: 1; } .role { flex: 1; }
  .when, .where { flex: none; white-space: nowrap; text-align: right; }
`;

const CSS: Record<ResumeStyle, string> = {
  letterpress: `${ROWS}
    @page { size: A4; margin: 16mm 16mm; }
    body { font-family: "Spectral", Georgia, serif; color: #1a1714; font-size: 10.5pt; line-height: 1.45; margin: 0; }
    .resume-header h1 { font-family: "Fraunces", serif; font-weight: 900; font-size: 26pt; margin: 0; letter-spacing: -.01em; }
    .resume-header .title { font-style: italic; color: #473f36; font-size: 12pt; margin-top: 2px; }
    .contact { font-family: "IBM Plex Mono", monospace; font-size: 8pt; letter-spacing: .04em; color: #7a6e5e; margin-top: 8px; text-transform: uppercase; line-height: 1.6; }
    .contact a { color: #b23a2e; text-decoration: none; }
    h2 { font-family: "IBM Plex Mono", monospace; font-size: 8.5pt; letter-spacing: .2em; text-transform: uppercase; color: #b23a2e; border-bottom: 1.5px solid #1a1714; padding-bottom: 3px; margin: 16px 0 8px; }
    .item { margin-bottom: 11px; }
    .org { font-family: "Fraunces", serif; font-weight: 600; font-size: 12pt; }
    .when, .where { font-family: "IBM Plex Mono", monospace; font-size: 8pt; color: #7a6e5e; }
    .role { font-style: italic; color: #473f36; margin: 1px 0 0; }
    .item-sub { margin: 1px 0 4px; }
    ul { margin: 4px 0; padding-left: 16px; } li { margin-bottom: 2px; }
    .skills, .summary { margin: 4px 0; }
  `,
  modern: `${ROWS}
    @page { size: A4; margin: 16mm; }
    body { font-family: "Helvetica Neue", Arial, sans-serif; color: #1f2933; font-size: 10.5pt; line-height: 1.5; margin: 0; }
    .resume-header h1 { font-size: 24pt; font-weight: 700; margin: 0; color: #0f172a; }
    .resume-header .title { color: #2563eb; font-weight: 600; font-size: 12pt; margin-top: 2px; }
    .contact { font-size: 9pt; color: #64748b; margin-top: 6px; line-height: 1.6; }
    .contact a { color: #2563eb; text-decoration: none; }
    h2 { font-size: 10pt; letter-spacing: .14em; text-transform: uppercase; color: #2563eb; margin: 16px 0 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 3px; }
    .item { margin-bottom: 11px; }
    .org { font-weight: 700; font-size: 11pt; } .when, .where { color: #94a3b8; font-size: 9pt; }
    .role { color: #475569; font-weight: 600; }
    .item-sub { margin: 1px 0 4px; }
    ul { margin: 4px 0; padding-left: 16px; } li { margin-bottom: 2px; }
  `,
  compact: `${ROWS}
    @page { size: A4; margin: 12mm; }
    body { font-family: "Helvetica Neue", Arial, sans-serif; color: #111; font-size: 9pt; line-height: 1.32; margin: 0; }
    .resume-header h1 { font-size: 18pt; margin: 0; } .resume-header .title { font-size: 10pt; color: #444; }
    .contact { font-size: 8pt; color: #555; margin-top: 3px; line-height: 1.5; } .contact a { color: #111; }
    h2 { font-size: 8.5pt; letter-spacing: .1em; text-transform: uppercase; border-bottom: 1px solid #000; margin: 9px 0 4px; padding-bottom: 1px; }
    .item { margin-bottom: 7px; }
    .org { font-weight: 700; } .when, .where { color: #666; font-size: 8pt; } .role { font-style: italic; color: #333; }
    .item-sub { margin: 0 0 2px; }
    ul { margin: 2px 0; padding-left: 14px; } li { margin-bottom: 1px; }
    .skills { font-size: 8.5pt; }
  `,
  "ats-plain": `${ROWS}
    @page { size: A4; margin: 16mm 18mm; }
    body { font-family: Arial, "Helvetica", sans-serif; color: #000; font-size: 10.5pt; line-height: 1.4; margin: 0; }
    .resume-header { text-align: center; }
    .resume-header h1 { font-size: 19pt; margin: 0; font-weight: bold; }
    .resume-header .title { font-size: 11pt; margin-top: 2px; }
    .contact { font-size: 9.5pt; margin-top: 5px; line-height: 1.5; } .contact a { color: #000; text-decoration: underline; }
    h2 { font-size: 10.5pt; font-weight: bold; text-transform: uppercase; letter-spacing: .03em; margin: 15px 0 7px; border-bottom: 1px solid #000; padding-bottom: 2px; }
    .item { margin-bottom: 11px; }
    .org { font-weight: bold; font-size: 11pt; } .when, .where { font-weight: normal; font-size: 10pt; color: #333; }
    .role { font-style: italic; }
    .item-sub { margin: 1px 0 4px; }
    ul { margin: 4px 0; padding-left: 18px; } li { margin-bottom: 3px; }
    .summary, .skills { margin: 4px 0; }
  `,
};

export function renderResumeHtml(resume: Resume, style: ResumeStyle = "letterpress"): string {
  const useFonts = style === "letterpress";
  return `<!doctype html><html><head><meta charset="utf-8">${useFonts ? FONTS : ""}<style>${CSS[style] || CSS.letterpress}</style></head><body>${sectionsHtml(resume)}</body></html>`;
}


// --- cover letter ------------------------------------------------------------
// A business letter, not a résumé: generous margins, a letterhead, the date, and a
// recipient block. Typography follows the chosen résumé style so the two documents
// look like they came from the same desk.

const COVER_FACE: Record<ResumeStyle, { body: string; display: string; mono: string; accent: string; web: boolean }> = {
  letterpress: { body: '"Spectral", Georgia, serif', display: '"Fraunces", serif', mono: '"IBM Plex Mono", monospace', accent: "#b23a2e", web: true },
  modern: { body: '"Helvetica Neue", Helvetica, Arial, sans-serif', display: '"Helvetica Neue", Helvetica, Arial, sans-serif', mono: '"Helvetica Neue", Helvetica, Arial, sans-serif', accent: "#1a1714", web: false },
  compact: { body: "Georgia, 'Times New Roman', serif", display: "Georgia, 'Times New Roman', serif", mono: "Georgia, serif", accent: "#333333", web: false },
  "ats-plain": { body: "Arial, Helvetica, sans-serif", display: "Arial, Helvetica, sans-serif", mono: "Arial, Helvetica, sans-serif", accent: "#000000", web: false },
};

const SALUTATION = /^\s*(dear|hello|hi\b|greetings|to whom)/i;

/** Does the letter already sign off in the sender's name? */
function signsOff(body: string, name?: string): boolean {
  if (!name) return false;
  const tail = body.trim().split(/\n/).slice(-4).join(" ").toLowerCase();
  return tail.includes(name.trim().toLowerCase());
}

export function renderCoverHtml(
  body: string,
  contact: ResumeContact,
  meta: { company?: string; role?: string; date?: Date } = {},
  style: ResumeStyle = "letterpress"
): string {
  const f = COVER_FACE[style] || COVER_FACE.letterpress;
  const text = (body || "").trim();

  // The model is asked to write the whole letter, so it normally opens with a
  // salutation and closes with the name. Only supply what is genuinely missing,
  // otherwise the page ends up greeting the reader twice.
  const needsSalutation = !SALUTATION.test(text);
  const needsSignature = !signsOff(text, contact?.name);

  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

  const date = (meta.date || new Date()).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const contactLine = [contact?.email, contact?.phone, contact?.location].filter(Boolean).map(esc).join("  ·  ");
  const links = (contact?.links || []).map((l) => esc(l.url)).join("  ·  ");
  const to = [meta.company ? `${esc(meta.company)} Hiring Team` : "Hiring Team", meta.role ? `Re: ${esc(meta.role)}` : ""]
    .filter(Boolean)
    .map((l) => `<div>${l}</div>`)
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8">${f.web ? FONTS : ""}<style>
    * { box-sizing: border-box; }
    @page { size: A4; margin: 24mm 22mm; }
    body { font-family: ${f.body}; color: #1a1714; font-size: 11pt; line-height: 1.6; margin: 0; }
    .letterhead { border-bottom: 1.5px solid #1a1714; padding-bottom: 10px; margin-bottom: 22px; }
    .letterhead h1 { font-family: ${f.display}; font-weight: ${style === "letterpress" ? 900 : 700}; font-size: 20pt; margin: 0; letter-spacing: -.01em; }
    .letterhead .meta { font-family: ${f.mono}; font-size: 8pt; letter-spacing: .04em; color: #7a6e5e; margin-top: 6px; text-transform: uppercase; line-height: 1.7; }
    .date { font-family: ${f.mono}; font-size: 9pt; color: #473f36; margin-bottom: 18px; }
    .to { font-family: ${f.mono}; font-size: 9pt; color: #1a1714; margin-bottom: 22px; line-height: 1.7; }
    .to div:first-child { font-weight: 500; }
    .to div:last-child { color: ${f.accent}; }
    p { margin: 0 0 11pt; orphans: 3; widows: 3; }
    .signoff { margin-top: 18pt; }
    .signoff .name { font-family: ${f.display}; font-size: 12pt; margin-top: 4pt; }
  </style></head><body>
    <div class="letterhead">
      <h1>${esc(contact?.name || "")}</h1>
      ${contactLine ? `<div class="meta">${contactLine}</div>` : ""}
      ${links ? `<div class="meta">${links}</div>` : ""}
    </div>
    <div class="date">${esc(date)}</div>
    ${to ? `<div class="to">${to}</div>` : ""}
    ${needsSalutation ? `<p>Dear ${meta.company ? esc(meta.company) + " " : ""}Hiring Team,</p>` : ""}
    ${paras}
    ${needsSignature ? `<div class="signoff"><div>Sincerely,</div><div class="name">${esc(contact?.name || "")}</div></div>` : ""}
  </body></html>`;
}
