/**
 * FillGST Helper — Background Service Worker.
 *
 * Receives messages from the FillGST web app via chrome.runtime.onMessageExternal,
 * orchestrates GST portal interactions (open login tab, fetch 2B), and sends
 * results back to the web app.
 *
 * Architecture:
 *   - Web app sends { type: "openLogin", gstin, ... } via sendMessage
 *   - Background opens a new Chrome tab to https://services.gst.gov.in/services/login
 *   - User solves captcha + (optional) OTP in the real browser tab
 *   - Background watches the tab via chrome.tabs.onUpdated for dashboard URL
 *   - When detected → reports back loggedIn:true (cookies are auto-saved by Chrome)
 *
 *   - For 2B fetch: background sends { type: "fetch2b", period } to a content
 *     script running on gstr2b.gst.gov.in. If no such tab exists, it opens one.
 *     Content script makes the same-origin fetch and replies with the JSON.
 */

import type { ToExtension, FromExtension } from "./lib/messages";
import { EXTENSION_VERSION } from "./lib/messages";

const LOGIN_URL = "https://services.gst.gov.in/services/login";
const RETURNS_DASHBOARD_URL = "https://return.gst.gov.in/returns/auth/dashboard";
const GSTR2B_BASE_URL = "https://gstr2b.gst.gov.in/gstr2b/auth";

// Track active tabs by GSTIN so we can re-use them
const activeLoginTabs = new Map<string, number>();

// ── Message handler ─────────────────────────────────────────

chrome.runtime.onMessageExternal.addListener((message: ToExtension, sender, sendResponse) => {
  // Validate sender — only the FillGST app can talk to us
  // (externally_connectable in manifest.json restricts origins, but log for debugging)
  console.log("[FillGST Helper] message from", sender.url, message);

  // Handle async responses
  void handleMessage(message)
    .then(sendResponse)
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      sendResponse({ ok: false, error });
    });

  // Return true to indicate we'll respond asynchronously
  return true;
});

async function handleMessage(message: ToExtension): Promise<FromExtension> {
  switch (message.type) {
    case "ping":
      return { ok: true, type: "pong", version: EXTENSION_VERSION };

    case "loginCheck":
      return checkLoginStatus(message.gstin);

    case "openLogin":
      return openLoginTab(message.gstin);

    case "fetch2b":
      return fetch2bForPeriod(message.gstin, message.period);

    case "logout":
      return logout(message.gstin);
  }
}

// ── Login status check ──────────────────────────────────────

async function checkLoginStatus(_gstin: string): Promise<FromExtension> {
  // Read GST portal cookies — if we have a session cookie, user is logged in
  const cookies = await chrome.cookies.getAll({ domain: ".gst.gov.in" });
  const sessionCookie = cookies.find(
    (c) => /sess/i.test(c.name) || /JSESSIONID/i.test(c.name) || /authToken/i.test(c.name),
  );
  return {
    ok: true,
    type: "loginStatus",
    loggedIn: !!sessionCookie,
    cookieCount: cookies.length,
  };
}

// ── Open login tab ──────────────────────────────────────────

async function openLoginTab(gstin: string): Promise<FromExtension> {
  // Re-use existing tab for this GSTIN if one is open
  const existingTabId = activeLoginTabs.get(gstin);
  if (existingTabId) {
    try {
      const tab = await chrome.tabs.get(existingTabId);
      if (tab && tab.url?.includes("gst.gov.in")) {
        await chrome.tabs.update(tab.id!, { active: true });
        return {
          ok: true,
          type: "loginOpened",
          tabId: tab.id!,
          message: "Tab already open — focus and finish login",
        };
      }
    } catch {
      activeLoginTabs.delete(gstin);
    }
  }

  // Open fresh login tab
  const tab = await chrome.tabs.create({ url: LOGIN_URL, active: true });
  if (!tab.id) {
    return { ok: false, error: "Could not create login tab" };
  }
  activeLoginTabs.set(gstin, tab.id);

  return {
    ok: true,
    type: "loginOpened",
    tabId: tab.id,
    message: "Login tab opened. Sign in with your credentials and captcha.",
  };
}

// ── 2B fetch ────────────────────────────────────────────────

async function fetch2bForPeriod(gstin: string, period: string): Promise<FromExtension> {
  // Verify cookies are present
  const status = await checkLoginStatus(gstin);
  if (!status.ok || !("loggedIn" in status) || !status.loggedIn) {
    return { ok: false, error: "Not logged in. Open the login tab first." };
  }

  // Find or create a tab on gstr2b.gst.gov.in. We need a real tab there
  // for the same-origin fetch to work without CORS issues.
  let tabId: number | undefined;

  // Look for existing 2B tab
  const tabs = await chrome.tabs.query({ url: "https://gstr2b.gst.gov.in/*" });
  if (tabs.length > 0 && tabs[0]?.id) {
    tabId = tabs[0].id;
  } else {
    // No 2B tab — we can't fetch directly; we need to navigate first.
    // Step 1: navigate via returns dashboard (WAF-safe path)
    const newTab = await chrome.tabs.create({
      url: RETURNS_DASHBOARD_URL,
      active: false, // open in background so user isn't disrupted
    });
    if (!newTab.id) {
      return { ok: false, error: "Could not open returns dashboard tab" };
    }
    tabId = newTab.id;

    // Wait for tab to load
    await waitForTabLoad(tabId, 20000);
  }

  if (!tabId) {
    return { ok: false, error: "No tab available for 2B fetch" };
  }

  // Inject content script and ask it to fetch
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: fetchGstr2bInPage,
      args: [period],
    });

    const out = result[0]?.result;
    if (!out || typeof out !== "object") {
      return { ok: false, error: "Content script returned no data" };
    }
    const r = out as { ok: boolean; data?: unknown; size?: number; error?: string };
    if (!r.ok) {
      return { ok: false, error: r.error ?? "Unknown error in content script" };
    }
    return {
      ok: true,
      type: "fetch2bResult",
      data: r.data,
      size: r.size ?? 0,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Function injected into the page — runs in the tab's JS context
// so cookies + same-origin policy apply naturally.
//
// GSTR-2B endpoints:
//   v4.0 (Oct 2024+):  GET /gstr2b/auth/gstr2bdwld?rtnprd={period}
//   legacy:            GET /gstr2b/auth/api/gstr2b/getjson?rtnprd={period}
// Try v4.0 first; on 404/410 fall back to legacy. Both return the same
// envelope shape; the FillGST web-app parser handles either flat (v4.0)
// or rate-wise (legacy) tax fields. IMS hidden flags
// (IsPendingBlocked, IsITCBlocked, IsRemarkBlocked, ItcAvailabilityCheck)
// arrive as-is and are forwarded to the server.
function fetchGstr2bInPage(period: string): Promise<{ ok: boolean; data?: unknown; size?: number; endpoint?: string; error?: string }> {
  return (async () => {
    const endpoints = [
      `https://gstr2b.gst.gov.in/gstr2b/auth/gstr2bdwld?rtnprd=${period}`,
      `https://gstr2b.gst.gov.in/gstr2b/auth/api/gstr2b/getjson?rtnprd=${period}`,
    ];
    let lastError = "no endpoints tried";
    for (const url of endpoints) {
      try {
        const resp = await fetch(url, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (resp.status === 404 || resp.status === 410) {
          lastError = `HTTP ${resp.status} from ${url}`;
          continue;
        }
        if (!resp.ok) {
          return { ok: false, error: `HTTP ${resp.status} from ${url}` };
        }
        const data = await resp.json();
        const text = JSON.stringify(data);
        return { ok: true, data, size: text.length, endpoint: url };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    return { ok: false, error: lastError };
  })();
}

// ── Logout ──────────────────────────────────────────────────

async function logout(gstin: string): Promise<FromExtension> {
  const cookies = await chrome.cookies.getAll({ domain: ".gst.gov.in" });
  await Promise.all(
    cookies.map((c) =>
      chrome.cookies.remove({
        url: `https://${c.domain.replace(/^\./, "")}${c.path}`,
        name: c.name,
      }),
    ),
  );
  activeLoginTabs.delete(gstin);
  return { ok: true, type: "loggedOut" };
}

// ── Helpers ─────────────────────────────────────────────────

function waitForTabLoad(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const handler = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId) return;
      if (info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(handler);
        // Give the page a moment to settle (Angular bootstrap, etc.)
        setTimeout(resolve, 1500);
      }
    };
    chrome.tabs.onUpdated.addListener(handler);
    const checkInterval = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        clearInterval(checkInterval);
        chrome.tabs.onUpdated.removeListener(handler);
        reject(new Error(`Tab ${tabId} did not finish loading within ${timeoutMs}ms`));
      }
    }, 500);
  });
}

// ── Lifecycle ───────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log(`[FillGST Helper] v${EXTENSION_VERSION} installed`);
});

// Clean up tab tracking when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [gstin, id] of activeLoginTabs.entries()) {
    if (id === tabId) {
      activeLoginTabs.delete(gstin);
    }
  }
});
