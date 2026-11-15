// Opens the side panel when the toolbar icon is clicked and relays
// attention state from the panel to any open Google Meet / Zoom tabs.

const MEETING_URLS = ["https://meet.google.com/*", "https://*.zoom.us/*"];

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("sidePanel setup failed", err));

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "state") return;
  chrome.tabs.query({ url: MEETING_URLS }).then((tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, msg).catch(() => {
        // Tab has no content script yet (e.g. opened before install). Ignore.
      });
    }
  });
});
