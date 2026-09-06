import { useEffect, useRef, useState } from "react";
import type { Route } from "./+types/clipper";
import { Shell } from "../components/Shell";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Clipper · The Remote Ledger" }];
}

function bookmarklet(origin: string) {
  // Sends the markup as well as the text: it is what lets the posting render as a
  // posting rather than as one long paragraph. A short selection is ignored on
  // purpose — a stray double-click used to become the whole description.
  // Submits a form rather than calling fetch.
  //
  // A bookmarklet runs inside the page, so the page's Content-Security-Policy is its
  // policy too — and job sites set `connect-src`. Greenhouse's blocks everything
  // except its own hosts, so a fetch to the ledger is refused before it is sent, with
  // nothing to see but "Failed to fetch". A form POST is governed by `form-action`,
  // which those sites do not set, and it opens a tab on the ledger showing the job it
  // just saved instead of an alert box.
  const code = `(function(){var u=location.href,t=document.title,g=window.getSelection&&window.getSelection(),sx=g?String(g):'',j,h;if(sx.trim().length>200&&g.rangeCount){var d0=document.createElement('div');d0.appendChild(g.getRangeAt(0).cloneContents());j=sx;h=d0.innerHTML;}else{var m=document.querySelector('main,article,[role=main]')||document.body;j=m.innerText||'';h=m.innerHTML||'';}var f=document.createElement('form');f.method='POST';f.action='${origin}/api/clip';f.target='_blank';f.style.display='none';function a(n,v){var i=document.createElement('input');i.type='hidden';i.name=n;i.value=v;f.appendChild(i);}a('url',u);a('title',t);a('jd',j.slice(0,16000));a('jdHtml',h.slice(0,60000));document.body.appendChild(f);f.submit();setTimeout(function(){f.parentNode&&f.parentNode.removeChild(f);},2000);})();`;
  return "javascript:" + encodeURIComponent(code);
}

export default function Clipper(_: Route.ComponentProps) {
  const [origin, setOrigin] = useState("http://localhost:5173");
  useEffect(() => setOrigin(window.location.origin), []);
  const href = bookmarklet(origin);

  // React refuses to render a javascript: href — it substitutes a stub that throws
  // "React has blocked a javascript: URL as a security precaution", so what got
  // dragged to the bookmarks bar was that error rather than the clipper. The
  // attribute has to be put on the node after render, where React will not rewrite
  // it. Draggable the moment it is there, which is before anyone can reach for it.
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    link.current?.setAttribute("href", href);
  }, [href]);
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
          <a ref={link} className="stamp">＋ Clip to Ledger</a>
        </p>
        <p className="hint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 12 }}>
          Drag it from the address you actually use. The button posts back to{" "}
          <strong>{origin}</strong>, baked in at the moment you drag it &mdash; and a page served over
          https cannot call an <code>http://</code> address, so one dragged from{" "}
          <code>localhost</code> will fail silently on most job sites. A few sites block bookmarklets
          outright with a content-security policy; the extension below is unaffected by that.
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
