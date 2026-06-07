import { useEffect, useState } from "react";
import type { Route } from "./+types/clipper";
import { Shell } from "../components/Shell";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Clipper · The Remote Ledger" }];
}

function bookmarklet(origin: string) {
  const code = `(function(){var u=location.href,t=document.title,s=(window.getSelection&&String(window.getSelection()))||'';if(!s){var m=document.querySelector('main,article,[role=main]');s=(m?m.innerText:document.body.innerText).slice(0,8000);}var b=new URLSearchParams({url:u,title:t,jd:s});fetch('${origin}/api/clip',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:b.toString()}).then(function(r){return r.json()}).then(function(d){alert(d.ok?'Saved to The Remote Ledger \\u2713':'Clip failed: '+(d.error||'?'))}).catch(function(e){alert('Clip failed: '+e)});})();`;
  return "javascript:" + encodeURIComponent(code);
}

export default function Clipper(_: Route.ComponentProps) {
  const [origin, setOrigin] = useState("http://localhost:5173");
  useEffect(() => setOrigin(window.location.origin), []);
  const href = bookmarklet(origin);
  return (
    <Shell>
      <div className="page-head">
        <h1>Job Clipper</h1>
        <div className="sub">Send any job posting to your ledger in one click</div>
      </div>
      <hr className="rule double" />

      <div className="panel">
        <h3>Bookmarklet (no install)</h3>
        <p className="hint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13 }}>
          Drag this button to your bookmarks bar. On any job page, select the description text (optional) and click it — the page is saved here as a job. Then open it and run Match / Tailor.
        </p>
        <p style={{ margin: "14px 0" }}>
          {/* eslint-disable-next-line */}
          <a className="stamp" href={href}>＋ Clip to Ledger</a>
        </p>
        <details>
          <summary style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--ink-faint)" }}>Show raw code</summary>
          <pre className="letter" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{decodeURIComponent(href)}</pre>
        </details>
      </div>

      <div className="panel">
        <h3>Chrome / Edge extension</h3>
        <p className="hint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13 }}>
          For a toolbar button: open <code>chrome://extensions</code>, enable Developer mode, click "Load unpacked", and select the <code>extension/</code> folder in this repo. Set the app URL in the popup if it isn't <code>{origin}</code>.
        </p>
      </div>
    </Shell>
  );
}
