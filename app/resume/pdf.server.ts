// Render resume HTML to a PDF file via headless Chromium (Playwright).
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { renderResumeHtml, type ResumeStyle } from "./templates.server";
import type { Resume } from "./types";

const PDF_DIR = resolve(process.cwd(), "data", "pdfs");

export async function renderResumePdf(
  resume: Resume,
  style: ResumeStyle,
  fileBase: string
): Promise<{ path: string; bytes: number }> {
  mkdirSync(PDF_DIR, { recursive: true });
  const html = renderResumeHtml(resume, style);
  // import lazily so the app starts even if the browser isn't installed
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const path = resolve(PDF_DIR, `${fileBase}.pdf`);
    const buf = await page.pdf({ path, format: "A4", printBackground: true });
    return { path, bytes: buf.length };
  } finally {
    await browser.close();
  }
}

export function pdfPathFor(fileBase: string): string {
  return resolve(PDF_DIR, `${fileBase}.pdf`);
}
