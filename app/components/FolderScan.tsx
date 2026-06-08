import { useRef, useState } from "react";

// Folder picker for the knowledge-base scan. Opens the native directory dialog,
// then filters CLIENT-SIDE to just README/manifests/source (skipping node_modules,
// .git, build output, etc.) so we never upload a giant tree. Reads the small set of
// text we need, groups it into projects, and packs it into a hidden field as JSON
// that the kb-scan action consumes. Contents never leave the machine except to the
// chosen runner during analysis.
const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|out|vendor|target|\.venv|venv|__pycache__|\.turbo|coverage|\.cache|\.idea|\.vscode)(\/|$)/;
const MANIFEST = /^(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|requirements\.txt|composer\.json|Gemfile|pom\.xml|build\.gradle)$/i;
const README = /^readme(\.md|\.txt)?$/i;
const CODE = /\.(ts|tsx|js|jsx|py|rs|go|java|rb|php|c|cc|cpp|h|hpp|cs|swift|kt|scala|sql|sh|vue|svelte|astro|ml|ex|exs|clj|hs)$/i;

interface Proj { name: string; readme?: string; manifests: { name: string; content: string }[]; files: string[] }

export function FolderScan({ disabled }: { disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [payload, setPayload] = useState("");
  const [label, setLabel] = useState("");
  const [count, setCount] = useState(0);
  const [reading, setReading] = useState(false);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setReading(true);
    setPayload("");
    const root = files[0].webkitRelativePath.split("/")[0] || "folder";
    setLabel(root);

    const byDir = new Map<string, Proj>();
    const proj = (dir: string) => {
      if (!byDir.has(dir)) byDir.set(dir, { name: dir.split("/").pop() || dir, manifests: [], files: [] });
      return byDir.get(dir)!;
    };
    const reads: Promise<void>[] = [];
    for (const f of files) {
      const rel = f.webkitRelativePath;
      if (SKIP.test(rel)) continue;
      const parts = rel.split("/");
      const base = parts[parts.length - 1];
      const dir = parts.slice(0, -1).join("/") || root;
      const p = proj(dir);
      if (CODE.test(base) || MANIFEST.test(base) || README.test(base)) p.files.push(base);
      if (README.test(base) && !p.readme) reads.push(f.text().then((t) => { p.readme = t.slice(0, 6000); }).catch(() => {}));
      else if (MANIFEST.test(base) && p.manifests.length < 6) reads.push(f.text().then((t) => { p.manifests.push({ name: base, content: t.slice(0, 2000) }); }).catch(() => {}));
    }
    await Promise.all(reads);
    // a "project" is a directory that has a README or a manifest
    const projects = Array.from(byDir.values()).filter((p) => p.readme || p.manifests.length).slice(0, 12);
    setCount(projects.length);
    setPayload(JSON.stringify({ label: root, projects }));
    setReading(false);
  }

  return (
    <div className="filepick">
      {/* webkitdirectory/directory aren't in the TS DOM types — pass them through */}
      <input ref={ref} type="file" multiple hidden onChange={onPick} {...({ webkitdirectory: "", directory: "" } as any)} />
      <input type="hidden" name="payload" value={payload} />
      <button type="button" className="filepick-btn" disabled={disabled || reading} onClick={() => ref.current?.click()}>
        {reading ? "Reading…" : "Choose folder…"}
      </button>
      <span className={`filepick-name ${label ? "has" : ""}`}>
        {label ? `${label} — ${count} project${count === 1 ? "" : "s"}` : "no folder chosen"}
      </span>
    </div>
  );
}
