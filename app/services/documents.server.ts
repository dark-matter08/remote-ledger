// Read the documents that are somebody's portfolio when their portfolio is not code.
//
// The folder scan was built for repositories: it looked for a README or a manifest,
// and if a directory had neither it was skipped with "nothing with a README or
// manifest to read here". That is the whole of a developer's evidence and none of
// anyone else's. A customer support specialist has QA scorecards, escalation
// write-ups, process docs and performance reviews; a teacher has schemes of work; a
// finance clerk has reconciliation procedures. All of it sits in folders, and none of
// it was readable.
//
// Only formats that can be read honestly are here. A scanned image PDF yields nothing
// and says so rather than being silently counted as evidence.
import { readFileSync } from "node:fs";
import { extname, basename } from "node:path";
import { inflateRawSync } from "node:zlib";

/** Formats worth opening. Everything else is listed by name only. */
export const DOC_FILE_RE = /\.(pdf|docx|md|mdx|txt|rtf|csv|tsv)$/i;

/** Plain enough to read straight off disk. */
const PLAIN_RE = /\.(md|mdx|txt|csv|tsv)$/i;

const MAX_CHARS = 8000;

/**
 * The text of a .docx, without a dependency.
 *
 * A .docx is a zip holding word/document.xml. Node can inflate a raw deflate stream,
 * and the local file header tells us where each entry's data starts and how long it
 * is — so the one member we want can be pulled out directly. Worth the forty lines:
 * .docx is *the* document format for everyone this scan was previously blind to, and
 * adding a zip library to read one file inside one archive is a poor trade.
 */
function docxText(buf: Buffer): string {
  const NAME = "word/document.xml";
  // scan local file headers (PK\x03\x04) rather than the central directory: the
  // member we want is near the front and this needs no cross-referencing
  for (let i = 0; i + 30 < buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const method = buf.readUInt16LE(i + 8);
    const compressed = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString("latin1");
    if (name !== NAME) continue;
    const start = i + 30 + nameLen + extraLen;
    // streamed entries write 0 here and put the size in a trailing descriptor; take
    // the rest of the buffer and let inflate stop itself at the end of the stream
    const raw = compressed > 0 ? buf.subarray(start, start + compressed) : buf.subarray(start);
    const xml = method === 0 ? raw : inflateRawSync(raw);
    return xmlToText(xml.toString("utf8"));
  }
  return "";
}

function xmlToText(xml: string): string {
  return xml
    // Word's own paragraph and break marks are the only structure worth keeping
    .replace(/<w:p[ >]/g, "\n<w:p ")
    .replace(/<w:br\s*\/?>/g, "\n")
    .replace(/<w:tab\s*\/?>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** RTF is plain text wrapped in control words; strip them rather than parse it. */
function rtfText(s: string): string {
  return s
    .replace(/\\'[0-9a-f]{2}/gi, " ")
    .replace(/\\[a-z]+-?\d* ?/gi, " ")
    .replace(/[{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface DocText {
  name: string;
  text: string;
  /** Why nothing came out, when nothing did. Shown in the scan log, never guessed around. */
  problem?: string;
}

/** Read one document. Never throws: an unreadable file is a note, not a failed scan. */
export async function readDocument(path: string): Promise<DocText> {
  const name = basename(path);
  const ext = extname(path).toLowerCase();
  try {
    if (PLAIN_RE.test(ext)) {
      return { name, text: readFileSync(path, "utf8").slice(0, MAX_CHARS).trim() };
    }
    if (ext === ".rtf") {
      return { name, text: rtfText(readFileSync(path, "utf8")).slice(0, MAX_CHARS) };
    }
    if (ext === ".docx") {
      const t = docxText(readFileSync(path));
      return t ? { name, text: t.slice(0, MAX_CHARS) } : { name, text: "", problem: "no readable text in it" };
    }
    if (ext === ".pdf") {
      const { extractPdfText } = await import("../resume/profiles.server");
      const t = await extractPdfText(readFileSync(path));
      // a scan or a photo has no text layer; counting it as evidence would be a lie
      return t.length > 20
        ? { name, text: t.slice(0, MAX_CHARS) }
        : { name, text: "", problem: "no text in it — probably a scan or a photo" };
    }
  } catch (e: any) {
    return { name, text: "", problem: String(e?.message || e).slice(0, 120) };
  }
  return { name, text: "", problem: "not a format this can read" };
}

/** Read several, in order, until the budget runs out. */
export async function readDocuments(paths: string[], budget = 40_000): Promise<DocText[]> {
  const out: DocText[] = [];
  let left = budget;
  for (const p of paths) {
    if (left <= 500) break;
    const d = await readDocument(p);
    if (d.text) {
      d.text = d.text.slice(0, left);
      left -= d.text.length;
    }
    out.push(d);
  }
  return out;
}
