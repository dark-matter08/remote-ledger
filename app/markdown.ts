// Markdown, as the models write it, to HTML the page can show.
//
// The prep, the cover letter and the match notes all come back as markdown and were
// being shown in a <pre>: literal `##` and `**` on screen, which is what the first
// screenshot of a generated prep looked like. This turns them into headings and
// emphasis.
//
// Deliberately no library. The text comes from a model — a third party, whatever key
// it ran under — and a renderer that honours raw HTML in its input is a way for that
// party to put a <script> on the page. Everything here is escaped first, and only the
// tags this file emits can exist in the output. Links are kept to http(s).
//
// Handles what the prompts ask for and the models produce: ATX headings, paragraphs,
// bulleted and numbered lists (one level of nesting), bold, italic, inline code, fenced
// code, blockquotes, rules and links. Tables are not in that set; a model that draws
// one gets a paragraph of pipes, which is legible and is not a security surface.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Bold, italic, inline code and links, on already-escaped text. */
export function inline(s: string): string {
  let out = escapeHtml(s);
  // code first, so the markers inside a code span are not read as emphasis; parked
  // under a private-use sentinel, so a "3" in the prose cannot be mistaken for one
  const codes: string[] = [];
  out = out.replace(/`([^`\n]+)`/g, (_m, c) => {
    codes.push(`<code>${c}</code>`);
    return `\uE000${codes.length - 1}\uE001`;
  });
  // links: only http(s), and the label goes through the same escaping as everything else
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, href) => `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`);
  // bold before italic, or `**` is eaten as two italic markers
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");
  return out.replace(/\uE000(\d+)\uE001/g, (_m, i) => codes[Number(i)]);
}

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "hr" }
  | { kind: "list"; ordered: boolean; items: ListItem[] };

interface ListItem {
  text: string;
  children?: { ordered: boolean; items: ListItem[] };
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** Split the text into blocks. Lists collect their items, with one level of nesting. */
export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // fenced code runs until the closing fence, or the end
    if (/^\s*```/.test(line)) {
      flushPara();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }

    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flushPara();
      blocks.push({ kind: "h", level: h[1].length, text: h[2] });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      blocks.push({ kind: "hr" });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      const q: string[] = [line.replace(/^\s*>\s?/, "")];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) q.push(lines[++i].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", text: q.join(" ") });
      continue;
    }

    const li = LIST_RE.exec(line);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[2]);
      const items: ListItem[] = [];
      const baseIndent = li[1].length;
      let j = i;
      while (j < lines.length) {
        const m = LIST_RE.exec(lines[j]);
        if (m && m[1].length <= baseIndent) {
          items.push({ text: m[3] });
          j++;
        } else if (m && items.length) {
          // deeper indent: a child of the item above
          const last = items[items.length - 1];
          last.children ??= { ordered: /\d/.test(m[2]), items: [] };
          last.children.items.push({ text: m[3] });
          j++;
        } else if (lines[j].trim() && !LIST_RE.test(lines[j]) && items.length && /^\s+/.test(lines[j])) {
          // an indented continuation line belongs to the item above it
          const last = items[items.length - 1];
          const tail = last.children?.items.length ? last.children.items[last.children.items.length - 1] : last;
          tail.text += " " + lines[j].trim();
          j++;
        } else break;
      }
      blocks.push({ kind: "list", ordered, items });
      i = j - 1;
      continue;
    }

    if (!line.trim()) {
      flushPara();
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  return blocks;
}

function renderList(l: { ordered: boolean; items: ListItem[] }): string {
  const tag = l.ordered ? "ol" : "ul";
  const items = l.items
    .map((it) => `<li>${inline(it.text)}${it.children ? renderList(it.children) : ""}</li>`)
    .join("");
  return `<${tag}>${items}</${tag}>`;
}

/** Markdown to HTML. Only the tags this function writes can appear in the result. */
export function renderMarkdown(md: string): string {
  return parseBlocks(md || "")
    .map((b) => {
      switch (b.kind) {
        case "h":
          return `<h${b.level}>${inline(b.text)}</h${b.level}>`;
        case "p":
          return `<p>${inline(b.text)}</p>`;
        case "code":
          return `<pre><code>${escapeHtml(b.text)}</code></pre>`;
        case "quote":
          return `<blockquote>${inline(b.text)}</blockquote>`;
        case "hr":
          return "<hr />";
        case "list":
          return renderList(b);
      }
    })
    .join("\n");
}
