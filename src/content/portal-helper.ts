/**
 * Content script — runs on every *.gst.gov.in page.
 *
 * Currently a thin marker that lets the background know the GST portal
 * is open and the page has rendered. Future: add UI hints (small banner
 * showing "Connected to FillGST"), or capture form events.
 *
 * Page-load verification logic for 2B fetch is in background.ts using
 * chrome.scripting.executeScript — that injection runs in the page's JS
 * context just like this content script does.
 */

console.log("[FillGST Helper] content script loaded on", window.location.href);

// Mark the page so the FillGST app can detect "user has portal tab open"
// (visible via document.documentElement.dataset.fillgstHelper)
document.documentElement.dataset.fillgstHelper = "1";
