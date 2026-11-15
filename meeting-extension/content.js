// Shows a small attention badge on top of Google Meet and Zoom pages.
// Only the user sees it unless they share this browser tab.

const BADGE_ID = "attn-monitor-badge";
let hideTimer = null;

function getBadge() {
  let el = document.getElementById(BADGE_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = BADGE_ID;
    el.style.cssText = [
      "position:fixed", "top:12px", "right:12px", "z-index:2147483647",
      "padding:6px 12px", "border-radius:999px",
      "font:600 13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
      "color:#0b0f19", "background:#64748b",
      "box-shadow:0 2px 8px rgba(0,0,0,.3)", "pointer-events:none"
    ].join(";");
    el.textContent = "Attention: waiting";
    document.documentElement.appendChild(el);
  }
  return el;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "state") return;
  const el = getBadge();
  el.textContent = `${msg.label} · ${msg.score}`;
  el.style.background = msg.color;

  // If the side panel stops sending updates, fall back to "no signal".
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    el.textContent = "Attention: no signal";
    el.style.background = "#64748b";
  }, 4000);
});
