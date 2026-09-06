import { useEffect, useState } from "react";
import type { Route } from "./+types/clipper";
import { Shell } from "../components/Shell";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Clipper · The Remote Ledger" }];
}

function bookmarklet(origin: string) {
  // Sends the markup as well as the text: it is what lets the posting render as a
  // posting rather than as one long paragraph. A short selection is ignored on
  // purpose — a stray double-click used to become the whole description.
  const code = `(function(){var u=location.href,t=document.title,g=window.getSelection&&window.getSelection(),sx=g?String(g):'',j,h;if(sx.trim().length>200&&g.rangeCount){var d0=document.createElement('div');d0.appendChild(g.getRangeAt(0).cloneContents());j=sx;h=d0.innerHTML;}else{var m=document.querySelector('main,article,[role=main]')||document.body;j=m.innerText||'';h=m.innerHTML||'';}var b=new URLSearchParams({url:u,title:t,jd:j.slice(0,16000),jdHtml:h.slice(0,60000)});fetch('${origin}/api/clip',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:b.toString()}).then(function(r){return r.json()}).then(function(d){alert(d.ok?'Saved \\u2713 \\u2014 reading the posting now':'Clip failed: '+(d.error||'?'))}).catch(function(e){alert('Clip failed: '+e)});})();`;
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
          Drag this button to your bookmarks bar, then click it on any job page. The posting is saved here, read in full, and scored against your r\u00e9sum\u00e9 \u2014 company, role, stack, eligibility and fit are filled in for you. Watch it happen in the Crawl Shell; by the time you open the job it is ready to tailor.
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
