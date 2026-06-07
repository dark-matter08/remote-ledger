import { useEffect, useState } from "react";

const CAPTIONS = [
  "Reading the PDF…",
  "Setting the type…",
  "Composing the galley…",
  "Indexing your experience…",
  "Cataloguing your skills…",
  "Pulling a proof…",
];

// Letterpress-flavoured indeterminate loader shown while a résumé is parsed.
export function ParseLoader() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % CAPTIONS.length), 1600);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="parsing" role="status" aria-live="polite">
      <div className="parsing-mark">❦</div>
      <div className="parsing-lines">
        {[0, 1, 2, 3, 4].map((n) => (
          <span key={n} style={{ animationDelay: `${n * 0.16}s` }} />
        ))}
      </div>
      <div className="parsing-cap">{CAPTIONS[i]}</div>
    </div>
  );
}
