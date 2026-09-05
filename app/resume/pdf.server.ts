// Render resume HTML to a PDF file via headless Chromium (Playwright).
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { renderResumeHtml, renderCoverHtml, type ResumeStyle } from "./templates.server";
import type { Resume, ResumeContact } from "./types";

const PDF_DIR = resolve(process.cwd(), "data", "pdfs");

async function htmlToPdf(html: string, fileBase: string): Promise<{ path: string; bytes: number }> {
  mkdirSync(PDF_DIR, { recursive: true });
  // import lazily so the app starts even if the browser isn't installed
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // networkidle so the web fonts land before the page is printed
    await page.setContent(html, { waitUntil: "networkidle" });
    const path = resolve(PDF_DIR, `${fileBase}.pdf`);
    const buf = await page.pdf({ path, format: "A4", printBackground: true });
    return { path, bytes: buf.length };
  } finally {
    await browser.close();
  }
}

export async function renderResumePdf(
  resume: Resume,
  style: ResumeStyle,
  fileBase: string
): Promise<{ path: string; bytes: number }> {
  return htmlToPdf(renderResumeHtml(resume, style), fileBase);
}

/** The cover letter as a formal business letter, paired to the résumé's style. */
export async function renderCoverPdf(
  body: string,
  contact: ResumeContact,
  meta: { company?: string; role?: string; date?: Date },
  style: ResumeStyle,
  fileBase: string
): Promise<{ path: string; bytes: number }> {
  return htmlToPdf(renderCoverHtml(body, contact, meta, style), fileBase);
}

export function pdfPathFor(fileBase: string): string {
  return resolve(PDF_DIR, `${fileBase}.pdf`);
}
