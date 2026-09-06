const urlInput = document.getElementById("url");
const status = document.getElementById("status");

chrome.storage.sync.get(["appUrl"], (r) => {
  if (r.appUrl) urlInput.value = r.appUrl;
});

function collect() {
  const sel = window.getSelection();
  const selected = String(sel || "");
  let jd = "";
  let jdHtml = "";

  // A deliberate selection is the most precise thing on the page, but any stray
  // double-click also counts as one — and used to become the whole description.
  if (selected.trim().length > 200 && sel.rangeCount) {
    const box = document.createElement("div");
    box.appendChild(sel.getRangeAt(0).cloneContents());
    jd = selected;
    jdHtml = box.innerHTML;
  } else {
    const m = document.querySelector("main,article,[role=main]") || document.body;
    jd = m.innerText || "";
    jdHtml = m.innerHTML || "";
  }

  // The markup goes too: it is what lets the ledger render the posting as the
  // posting rather than as one long paragraph. The server sanitises it on arrival.
  return {
    url: location.href,
    title: document.title,
    jd: jd.slice(0, 16000),
    jdHtml: jdHtml.slice(0, 60000),
  };
}

document.getElementById("clip").addEventListener("click", async () => {
  const appUrl = urlInput.value.replace(/\/+$/, "");
  chrome.storage.sync.set({ appUrl });
  status.textContent = "Clipping…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collect });
    const body = new URLSearchParams(result).toString();
    const res = await fetch(appUrl + "/api/clip", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const d = await res.json();
    status.textContent = d.ok ? "Saved ✓ — reading the posting now; open the Ledger in a moment." : "Failed: " + (d.error || "?");
  } catch (e) {
    status.textContent = "Failed: " + e.message;
  }
});
