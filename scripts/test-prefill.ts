// Headless integration test for the assisted-apply fill engine.
//
// Spins up a local Greenhouse/Lever-style application form, runs the REAL prefillPage
// engine (the same code the headed assisted-apply uses) against it headlessly, and
// screenshots the before/after so we have visual proof the form actually gets filled.
//
// Run: node --experimental-strip-types scripts/test-prefill.ts
import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { prefillPage, valueForIdentity, matchAnswer, detectAts } from "../app/services/prefill.server.ts";

const OUT = resolve(process.cwd(), "screenshots");
mkdirSync(OUT, { recursive: true });

// A realistic application form: identity inputs, a résumé file upload, a cover-letter
// textarea, a free-text question, and a country <select> — mirroring Greenhouse.
const FORM_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Senior Engineer</title>
<style>
 body{font-family:Georgia,serif;max-width:680px;margin:24px auto;color:#1a1a1a;background:#faf7f0}
 h1{font-size:24px} label{display:block;margin:14px 0 4px;font-weight:bold;font-size:14px}
 input,textarea,select{width:100%;padding:8px;border:1.5px solid #1a1a1a;font-size:14px;box-sizing:border-box}
 textarea{height:90px} .req:after{content:" *";color:#c0392b}
 button{margin-top:18px;padding:10px 22px;background:#1a1a1a;color:#fff;border:0;font-size:15px}
</style></head><body>
 <h1>Apply: Senior Software Engineer</h1>
 <form id="app">
  <label class="req" for="first_name">First Name</label><input id="first_name" name="first_name" required>
  <label class="req" for="last_name">Last Name</label><input id="last_name" name="last_name" required>
  <label class="req" for="email">Email</label><input id="email" name="email" type="email" required>
  <label for="phone">Phone</label><input id="phone" name="phone" type="tel">
  <label for="lk">LinkedIn Profile</label><input id="lk" name="urls[LinkedIn]">
  <label for="gh">GitHub</label><input id="gh" name="urls[GitHub]">
  <label class="req" for="resume">Resume / CV</label><input id="resume" name="resume" type="file" required>
  <label for="country">Country</label>
   <select id="country" name="country"><option value="">--</option><option>United States</option><option>Portugal</option><option>Germany</option></select>
  <label for="why">Why do you want to work here?</label><textarea id="why" name="why"></textarea>
  <label for="cover">Cover Letter</label><textarea id="cover" name="cover_letter"></textarea>
  <button type="button">Submit Application</button>
 </form>
</body></html>`;

const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(FORM_HTML); });
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as any).port;
const url = `http://localhost:${port}/`;

// a dummy résumé file to upload
const pdfPath = resolve(OUT, "_dummy-resume.pdf");
writeFileSync(pdfPath, "%PDF-1.4\n% dummy résumé for prefill test\n");

const contact = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  phone: "+1 555 0100",
  location: "Portugal",
  links: [
    { label: "LinkedIn", url: "https://linkedin.com/in/ada" },
    { label: "GitHub", url: "https://github.com/ada" },
  ],
} as any;
const qa = [
  { q: "Why do you want to work here?", a: "I'm drawn to your focus on local-first software and developer autonomy, and I want to build tools people own." },
];
const cover = "Dear Hiring Team,\n\nI'd love to join as a Senior Software Engineer...\n\nBest,\nAda";

console.log("ATS detected:", detectAts("https://boards.greenhouse.io/acme/jobs/123"));
console.log("identity sanity:", valueForIdentity("First Name", "first_name", "first_name", contact));
console.log("answer match:", !!matchAnswer("Why do you want to work here?", qa));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });

await page.screenshot({ path: resolve(OUT, "40-assist-before.png"), fullPage: true });

const result = await prefillPage(page, { contact, pdfPath, qa, cover, log: (m) => console.log("  fill", m) });

await page.screenshot({ path: resolve(OUT, "41-assist-after.png"), fullPage: true });

// read the DOM back to verify values actually landed
const values = await page.evaluate(() => {
  const v = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value || "";
  const file = (document.getElementById("resume") as HTMLInputElement);
  return {
    first: v("first_name"), last: v("last_name"), email: v("email"), phone: v("phone"),
    linkedin: v("lk"), github: v("gh"), country: v("country"), why: v("why"), cover: v("cover"),
    resumeFiles: file?.files?.length || 0,
  };
});

await browser.close();
server.close();

console.log("\n=== prefill result ===");
console.log("filled  :", result.filled);
console.log("unfilled:", result.unfilled);
console.log("\n=== DOM values after prefill ===");
console.log(values);

// assertions
const checks: [string, boolean][] = [
  ["first name", values.first === "Ada"],
  ["last name", values.last === "Lovelace"],
  ["email", values.email === "ada@example.com"],
  ["phone", values.phone === "+1 555 0100"],
  ["linkedin", values.linkedin.includes("linkedin.com/in/ada")],
  ["github", values.github.includes("github.com/ada")],
  ["résumé uploaded", values.resumeFiles === 1],
  ["country select", values.country === "Portugal"],
  ["why answer", values.why.length > 20],
  ["cover letter", values.cover.startsWith("Dear")],
];
let pass = 0;
console.log("\n=== assertions ===");
for (const [name, ok] of checks) { console.log(`${ok ? "✓" : "✗"} ${name}`); if (ok) pass++; }
console.log(`\n${pass}/${checks.length} checks passed`);
console.log(`screenshots: ${resolve(OUT, "40-assist-before.png")} , ${resolve(OUT, "41-assist-after.png")}`);
process.exit(pass === checks.length ? 0 : 1);
