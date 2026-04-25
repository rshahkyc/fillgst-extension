/**
 * Marker content script — runs on FillGST app origins.
 *
 * Sets a data attribute on <html> with this extension's ID. The FillGST
 * web app reads this attribute to auto-detect the extension without
 * asking the user to manually copy/paste the ID.
 *
 * Also dispatches a custom event so React components can react in real time.
 */

const id = chrome.runtime.id;
const version = chrome.runtime.getManifest().version;

document.documentElement.dataset.fillgstHelperId = id;
document.documentElement.dataset.fillgstHelperVersion = version;

// Notify the page asynchronously in case it loaded before this script ran
window.dispatchEvent(
  new CustomEvent("fillgst-helper-ready", {
    detail: { id, version },
  }),
);

console.log(`[FillGST Helper] marker set on FillGST page: id=${id} v=${version}`);
