const urlInput = document.getElementById("url");
const status = document.getElementById("status");

chrome.storage.sync.get(["appUrl"], (r) => {
  if (r.appUrl) urlInput.value = r.appUrl;
});

function collect() {
  const sel = String(window.getSelection() || "");
  let jd = sel;
  if (!jd) {
    const m = document.querySelector("main,article,[role=main]");
    jd = (m ? m.innerText : document.body.innerText).slice(0, 8000);
  }
  return { url: location.href, title: document.title, jd };
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
    status.textContent = d.ok ? "Saved ✓ — open the Ledger to tailor." : "Failed: " + (d.error || "?");
  } catch (e) {
    status.textContent = "Failed: " + e.message;
  }
});
