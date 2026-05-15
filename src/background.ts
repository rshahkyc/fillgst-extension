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

    case "checkUpdate":
      return triggerUpdateCheck();

    case "openExtensionsPage":
      return openExtensionsPage();

    case "loginCheck":
      return checkLoginStatus(message.gstin);

    case "openLogin":
      return openLoginTab(message.gstin);

    case "fetch2b":
      return fetch2bForPeriod(message.gstin, message.period);

    case "fetchGstr1":
      return fetchGstr1ForPeriod(message.gstin, message.period, message.skipEInvoice ?? false);

    case "fetchGstr3b":
      return fetchGstr3bForPeriod(
        message.gstin,
        message.period,
        message.skipTaxPayable ?? true,
        message.includeLedgers ?? false,
      );

    case "dispatch":
      return dispatchAction(message);

    case "loginAndFetch2b":
      return loginAndFetch2b(message);

    case "loginAndFetchIms":
      return loginAndFetchIms(message);

    case "loginAndFetchGstr3b":
      return loginAndFetchGstr3b(message);

    case "submitLoginCaptcha":
      return submitLoginCaptcha(message);

    case "submitLoginOtp":
      return submitLoginOtp(message);

    case "cancelLoginFlow":
      return cancelLoginFlow(message);

    case "keepalive":
      return keepalive(message.gstin);

    case "logout":
      return logout(message.gstin);
  }
}

// ── Auto-login + fetch-2B orchestrator (Playwright-style, in Chrome) ──
//
// Mirrors fillgst-helper-node's startSession → /portal/captcha → /portal/otp
// → fetch2b sequence. The flow:
//   1. loginAndFetch2b: open visible login tab, fill creds, capture
//      captcha image as base64, return it to FillGST as `needsCaptcha`.
//   2. submitLoginCaptcha: fill captcha + submit, watch for dashboard.
//      If dashboard → run fetch dance, return `fetch2bResult`.
//      If OTP page → return `needsOtp`.
//   3. submitLoginOtp: fill OTP + submit, watch for dashboard.
//      Then run fetch dance, return `fetch2bResult`.
//
// Per-session state is keyed by sessionId so multiple in-flight flows
// (different GSTINs in different windows) don't collide.

interface LoginSession {
  tabId: number;
  windowId?: number;
  gstin: string;
  period: string;
  /**
   * Which fetch operation runs after login lands on /auth/dashboard.
   * v0.8.0 added "ims"; v0.9.2 added "gstr3b"; "2b" is the original.
   * All three share the same captcha + OTP flow; only the post-login
   * fetch step differs.
   */
  kind: "2b" | "ims" | "gstr3b";
  step: "captcha" | "otp" | "fetch" | "done";
  /** GSTR-3B-specific fetch options (only when kind === "gstr3b"). */
  skipTaxPayable?: boolean;
  includeLedgers?: boolean;
}
const loginSessions = new Map<string, LoginSession>();

async function loginAndFetch2b(
  msg: Extract<ToExtension, { type: "loginAndFetch2b" }>,
): Promise<FromExtension> {
  // v0.7.8: NO warm-path shortcut. Even if cookies appear valid, GSTN
  // can have stale subdomain sessions where services.gst.gov.in is
  // logged in but gstr2b.gst.gov.in's WAF refuses to grant a TS-cookie
  // — popup bounces to /error/accessdenied. Force the captcha-login
  // flow every time to re-establish the gstr2b session cleanly. Slower
  // (captcha required) but eliminates the false-positive logged-in
  // failure mode that v0.7.5/v0.7.7 hit.

  // Need credentials. If web app didn't pass them, ask for them.
  if (!msg.username || !msg.password) {
    return { ok: true, type: "needsCredentials", sessionId: msg.sessionId };
  }

  // v0.7.9: open the login page in a SEPARATE minimized Chrome window
  // instead of a tab in the user's main window. The page renders
  // normally inside the minimized window — JS executes, captcha img
  // loads, all WAF challenges complete — but the user never sees the
  // tab pop into their workspace. v0.7.6 tried `active: false` in the
  // main window and the WAF bounced (focus/visibility check); a
  // top-level minimized window is treated differently because it's
  // its own Chrome window with full rendering, just off-screen. The
  // gstr2b popup spawned later via window.open joins the same window.
  const win = await chrome.windows.create({
    url: LOGIN_URL,
    type: "normal",
    state: "minimized",
    focused: false,
  });
  const tabId = win.tabs?.[0]?.id;
  const windowId = win.id;
  if (!tabId || windowId == null) {
    return { ok: false, error: "Could not open login window" };
  }
  await waitForTabLoad(tabId, 25000);

  // If the login URL redirected to /auth (cookies still valid),
  // navigate back to /services/login to force a fresh captcha-driven
  // login. This re-establishes the GSTN session cleanly and gives
  // gstr2b.gst.gov.in a chance to mint a fresh TS-cookie when the
  // popup later opens.
  const tabAfter = await chrome.tabs.get(tabId);
  if (tabAfter.url && /\/auth\//.test(tabAfter.url)) {
    await chrome.tabs.update(tabId, { url: LOGIN_URL });
    await waitForTabLoad(tabId, 25000);
  }

  // Fill creds + wait for captcha to render + capture as base64.
  let result: { ok: boolean; captchaImage?: string; error?: string };
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: fillCredsAndCaptureCaptcha,
      args: [msg.username, msg.password],
    });
    result = (r[0]?.result ?? { ok: false, error: "no result" }) as typeof result;
  } catch (err) {
    await chrome.windows.remove(windowId).catch(() => {});
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!result.ok || !result.captchaImage) {
    await chrome.windows.remove(windowId).catch(() => {});
    return {
      ok: false,
      error: result.error ?? "Could not capture captcha",
    };
  }

  loginSessions.set(msg.sessionId, {
    tabId,
    windowId,
    gstin: msg.gstin,
    period: msg.period,
    kind: "2b",
    step: "captcha",
  });

  return {
    ok: true,
    type: "needsCaptcha",
    sessionId: msg.sessionId,
    captchaImage: result.captchaImage,
  };
}

/**
 * v0.8.0 — Auto-login + IMS-fetch orchestrator.
 *
 * Same login state machine as loginAndFetch2b — opens a hidden
 * minimized window, fills creds, captures captcha, returns it via
 * needsCaptcha, accepts the user's solve via submitLoginCaptcha (and
 * optionally submitLoginOtp). The only difference is the post-login
 * fetch step: instead of the gstr2b popup-WAF dance, we navigate the
 * SAME tab cross-subdomain to return.gst.gov.in/returns/auth/dashboard
 * and run multi-section in-tab fetches against /imsweb/auth/api/ims/...
 * (no WAF JS challenge needed for this subdomain — just session
 * cookies + same-origin).
 *
 * Web app POSTs the resulting envelope to /api/ims/upload to persist.
 */
async function loginAndFetchIms(
  msg: Extract<ToExtension, { type: "loginAndFetchIms" }>,
): Promise<FromExtension> {
  if (!msg.username || !msg.password) {
    return { ok: true, type: "needsCredentials", sessionId: msg.sessionId };
  }

  const win = await chrome.windows.create({
    url: LOGIN_URL,
    type: "normal",
    state: "minimized",
    focused: false,
  });
  const tabId = win.tabs?.[0]?.id;
  const windowId = win.id;
  if (!tabId || windowId == null) {
    return { ok: false, error: "Could not open login window" };
  }
  await waitForTabLoad(tabId, 25000);

  // If cookies are still valid, login URL redirects to /auth/...; force
  // a fresh captcha-driven login to re-establish a clean session.
  const tabAfter = await chrome.tabs.get(tabId);
  if (tabAfter.url && /\/auth\//.test(tabAfter.url)) {
    await chrome.tabs.update(tabId, { url: LOGIN_URL });
    await waitForTabLoad(tabId, 25000);
  }

  let result: { ok: boolean; captchaImage?: string; error?: string };
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: fillCredsAndCaptureCaptcha,
      args: [msg.username, msg.password],
    });
    result = (r[0]?.result ?? { ok: false, error: "no result" }) as typeof result;
  } catch (err) {
    await chrome.windows.remove(windowId).catch(() => {});
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!result.ok || !result.captchaImage) {
    await chrome.windows.remove(windowId).catch(() => {});
    return { ok: false, error: result.error ?? "Could not capture captcha" };
  }

  loginSessions.set(msg.sessionId, {
    tabId,
    windowId,
    gstin: msg.gstin,
    period: msg.period,
    kind: "ims",
    step: "captcha",
  });

  return {
    ok: true,
    type: "needsCaptcha",
    sessionId: msg.sessionId,
    captchaImage: result.captchaImage,
  };
}

/**
 * v0.9.2 — Auto-login + GSTR-3B-fetch orchestrator.
 *
 * Identical login state machine as loginAndFetchIms (hidden minimised
 * window → fill creds → captcha → optional OTP → dashboard). Only the
 * post-login fetch step differs: instead of iterating IMS sections, we
 * navigate the same tab to return.gst.gov.in and hit formdetails +
 * summary + getr1r3bliab (plus optional taxpayble, getbalance,
 * getopenliabilities when includeLedgers=true). The bundle that comes
 * back matches helper-node's Gstr3bFetchBundle, so the web app can
 * persist it via /api/portal/extension/persist-gstr3b-bundle.
 */
async function loginAndFetchGstr3b(
  msg: Extract<ToExtension, { type: "loginAndFetchGstr3b" }>,
): Promise<FromExtension> {
  if (!msg.username || !msg.password) {
    return { ok: true, type: "needsCredentials", sessionId: msg.sessionId };
  }

  const win = await chrome.windows.create({
    url: LOGIN_URL,
    type: "normal",
    state: "minimized",
    focused: false,
  });
  const tabId = win.tabs?.[0]?.id;
  const windowId = win.id;
  if (!tabId || windowId == null) {
    return { ok: false, error: "Could not open login window" };
  }
  await waitForTabLoad(tabId, 25000);

  // If cookies are still valid, login URL redirects to /auth/...; force
  // a fresh captcha-driven login to re-establish a clean session.
  const tabAfter = await chrome.tabs.get(tabId);
  if (tabAfter.url && /\/auth\//.test(tabAfter.url)) {
    await chrome.tabs.update(tabId, { url: LOGIN_URL });
    await waitForTabLoad(tabId, 25000);
  }

  let result: { ok: boolean; captchaImage?: string; error?: string };
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: fillCredsAndCaptureCaptcha,
      args: [msg.username, msg.password],
    });
    result = (r[0]?.result ?? { ok: false, error: "no result" }) as typeof result;
  } catch (err) {
    await chrome.windows.remove(windowId).catch(() => {});
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!result.ok || !result.captchaImage) {
    await chrome.windows.remove(windowId).catch(() => {});
    return { ok: false, error: result.error ?? "Could not capture captcha" };
  }

  loginSessions.set(msg.sessionId, {
    tabId,
    windowId,
    gstin: msg.gstin,
    period: msg.period,
    kind: "gstr3b",
    step: "captcha",
    skipTaxPayable: msg.skipTaxPayable ?? true,
    includeLedgers: msg.includeLedgers ?? false,
  });

  return {
    ok: true,
    type: "needsCaptcha",
    sessionId: msg.sessionId,
    captchaImage: result.captchaImage,
  };
}

/**
 * Already-logged-in path: open a hidden services tab to act as opener,
 * then run the popup WAF dance + fetch. User sees nothing — just the
 * "Fetched N rows" success message in FillGST. This is the smoothest
 * UX for repeat fetches within the 30-day session window.
 */
async function silentFetch2b(period: string): Promise<FromExtension> {
  // Find or create an opener tab on services.gst.gov.in. window.open
  // (and chrome.tabs.create with openerTabId) treats this as a real
  // user-initiated nav, which the WAF accepts.
  const existing = await chrome.tabs.query({ url: "https://services.gst.gov.in/*" });
  let openerTabId = existing[0]?.id;
  let openerCreated = false;
  if (!openerTabId) {
    const opener = await chrome.tabs.create({
      url: "https://services.gst.gov.in/services/auth/fowelcome",
      active: false,
    });
    if (!opener.id) {
      return { ok: false, error: "Could not open services.gst.gov.in opener tab" };
    }
    openerTabId = opener.id;
    openerCreated = true;
    await waitForTabLoad(opener.id, 15000);
  }
  const result = await popupAndFetch2b(openerTabId, period);
  if (openerCreated) {
    await chrome.tabs.remove(openerTabId).catch(() => {});
  }
  return result;
}

async function submitLoginCaptcha(
  msg: Extract<ToExtension, { type: "submitLoginCaptcha" }>,
): Promise<FromExtension> {
  const session = loginSessions.get(msg.sessionId);
  if (!session) {
    return { ok: false, error: "No active login session for this id" };
  }

  // Fill captcha + click submit.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: session.tabId },
      func: fillCaptchaAndSubmit,
      args: [msg.captcha],
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // v0.7.8: actively poll for the post-login URL to settle on /auth/*
  // (up to 15 s) instead of a fixed 3.5 s sleep. The auth handshake
  // chain is: POST /services/Authentication → 302 /services/auth/
  // fowelcome → may redirect again to /services/auth/dashboard. The
  // 3.5 s window was enough most of the time but occasionally fired
  // the popup before the cookies propagated to gstr2b.gst.gov.in.
  const settledUrl = await waitForUrlMatch(
    session.tabId,
    /\/auth\/(fowelcome|dashboard)/,
    15000,
  );

  if (settledUrl) {
    // Logged in. Wait an extra 4 s for cross-subdomain cookies (the
    // gstr2b TS-cookie ride) to propagate before launching the popup.
    // Without this, the popup races GSTN's cookie-set and bounces.
    await sleep(4000);
    loginSessions.delete(msg.sessionId);
    const fetchResult = await runPostLoginFetch(session);
    // v0.7.9: close the entire minimized window in one go (covers the
    // login tab + popup tab + any incidental tabs Chrome added).
    if (session.windowId != null) {
      await chrome.windows.remove(session.windowId).catch(() => {});
    } else {
      await chrome.tabs.remove(session.tabId).catch(() => {});
    }
    return fetchResult;
  }

  // OTP page?
  let otpVisible = false;
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId: session.tabId },
      func: checkForOtpField,
    });
    otpVisible = !!r[0]?.result?.hasOtp;
  } catch {
    // ignore
  }
  if (otpVisible) {
    session.step = "otp";
    loginSessions.set(msg.sessionId, session);
    return { ok: true, type: "needsOtp", sessionId: msg.sessionId };
  }

  // Captcha probably wrong — give the user a fresh one.
  let fresh: { ok: boolean; captchaImage?: string; error?: string };
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId: session.tabId },
      func: refreshCaptchaAndCapture,
      args: [],
    });
    fresh = (r[0]?.result ?? { ok: false, error: "no result" }) as typeof fresh;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (fresh.ok && fresh.captchaImage) {
    return {
      ok: true,
      type: "needsCaptcha",
      sessionId: msg.sessionId,
      captchaImage: fresh.captchaImage,
    };
  }
  return { ok: false, error: "Login failed; could not refresh captcha" };
}

async function submitLoginOtp(
  msg: Extract<ToExtension, { type: "submitLoginOtp" }>,
): Promise<FromExtension> {
  const session = loginSessions.get(msg.sessionId);
  if (!session) {
    return { ok: false, error: "No active login session for this id" };
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: session.tabId },
      func: fillOtpAndSubmit,
      args: [msg.otp],
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  // Same URL-poll + propagation-wait pattern as submitLoginCaptcha.
  const settledUrl = await waitForUrlMatch(
    session.tabId,
    /\/auth\/(fowelcome|dashboard)/,
    15000,
  );
  if (settledUrl) {
    await sleep(4000);
    loginSessions.delete(msg.sessionId);
    const fetchResult = await runPostLoginFetch(session);
    if (session.windowId != null) {
      await chrome.windows.remove(session.windowId).catch(() => {});
    } else {
      await chrome.tabs.remove(session.tabId).catch(() => {});
    }
    return fetchResult;
  }
  return { ok: false, error: "OTP rejected by GST portal — try again" };
}

/**
 * Dispatch to the right post-login fetch based on session.kind.
 * All kinds share the same login state machine; only the fetch step
 * differs:
 *   - "2b"     → popup-window WAF dance against gstr2b.gst.gov.in
 *   - "ims"    → in-tab navigation to return.gst.gov.in then per-section
 *                same-origin fetch via /imsweb/auth/api/ims/...
 *   - "gstr3b" → in-tab navigation to return.gst.gov.in then in-page
 *                fetches against /returns/auth/api/gstr3b/... +
 *                formdetails + optional getbalance/getopenliabilities
 */
async function runPostLoginFetch(session: LoginSession): Promise<FromExtension> {
  if (session.kind === "ims") {
    return fetchImsViaTab(session.tabId, session.gstin, session.period);
  }
  if (session.kind === "gstr3b") {
    return fetchGstr3bViaTab(
      session.tabId,
      session.period,
      session.skipTaxPayable ?? true,
      session.includeLedgers ?? false,
    );
  }
  return popupAndFetch2b(session.tabId, session.period);
}

/**
 * Poll chrome.tabs.get(tabId).url every 250ms up to deadlineMs for a
 * URL matching the regex. Returns the matched URL on success, or
 * undefined on timeout. Used to wait for the post-login redirect chain
 * to settle on /auth/(fowelcome|dashboard).
 */
async function waitForUrlMatch(
  tabId: number,
  pattern: RegExp,
  deadlineMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tabId);
      const u = t.url ?? "";
      if (pattern.test(u)) return u;
    } catch {
      // Tab may have closed; just retry until deadline.
    }
    await sleep(250);
  }
  return undefined;
}

async function cancelLoginFlow(
  msg: Extract<ToExtension, { type: "cancelLoginFlow" }>,
): Promise<FromExtension> {
  const session = loginSessions.get(msg.sessionId);
  if (session) {
    if (session.windowId != null) {
      await chrome.windows.remove(session.windowId).catch(() => {});
    } else {
      await chrome.tabs.remove(session.tabId).catch(() => {});
    }
    loginSessions.delete(msg.sessionId);
  }
  return { ok: true, type: "loginCancelled", sessionId: msg.sessionId };
}

/**
 * Run the proven popup-window WAF dance + same-origin fetch.
 *
 * Mirrors fillgst-helper-node's fetch2b() (portal-runner.ts line 472+):
 *   1. From a logged-in services.gst.gov.in tab (the opener), spawn
 *      a new tab on gstr2b.gst.gov.in/auth/gstr2b/summary. Chrome's
 *      openerTabId makes this look like a window.open from the
 *      services tab, which is what GSTN's WAF expects.
 *   2. Wait for the SPA to load + 5 s for the WAF JS challenge to
 *      complete and set the gstr2b TS-cookie on this tab's subdomain.
 *   3. Verify we landed on gstr2b.gst.gov.in (not /accessdenied).
 *   4. Same-origin fetch from inside the tab — `/gstr2b/auth/api/gstr2b/
 *      getjson?rtnprd=...` — cookies including the WAF TS-cookie ride
 *      along automatically.
 *   5. Close the popup tab.
 */
async function popupAndFetch2b(openerTabId: number, period: string): Promise<FromExtension> {
  const targetUrl = "https://gstr2b.gst.gov.in/gstr2b/auth/gstr2b/summary";

  // CRITICAL: must use window.open() FROM INSIDE the logged-in page's
  // JS context, not chrome.tabs.create. The WAF distinguishes between
  // "user navigated by typing in URL bar" (chrome.tabs.create) and
  // "page invoked window.open from a logged-in same-domain-family tab"
  // (Playwright's working approach, helper-node line 493-497). Only
  // the latter passes the JS challenge — the former bounces to
  // /accessdenied, which is exactly the failure mode v0.7.2 hit.
  let popupTabId: number | undefined;
  try {
    // Snapshot existing gstr2b tab IDs so we can ignore them when
    // looking for the new popup. window.open from executeScript runs
    // in MAIN world and Chrome doesn't always set openerTabId — so
    // we can't rely on that field. We rely instead on (a) the new tab
    // being created AFTER our snapshot, and (b) it landing on a
    // gstr2b.gst.gov.in URL.
    const beforeIds = new Set<number>();
    const allTabs = await chrome.tabs.query({});
    for (const t of allTabs) {
      if (t.id != null) beforeIds.add(t.id);
    }

    // Race two strategies. Whichever finds the popup first wins:
    //   A. chrome.tabs.onCreated event listener (catches it instantly
    //      if openerTabId IS set — fastest path).
    //   B. Polling chrome.tabs.query for a new tab on a gst.gov.in
    //      URL (covers the case where openerTabId is missing).
    let createdHandler: ((t: chrome.tabs.Tab) => void) | undefined;
    const eventPromise = new Promise<number>((resolve) => {
      createdHandler = (t: chrome.tabs.Tab) => {
        if (t.id == null) return;
        const matches =
          t.openerTabId === openerTabId ||
          t.url?.includes("gst.gov.in") ||
          t.pendingUrl?.includes("gst.gov.in");
        if (matches) resolve(t.id);
      };
      chrome.tabs.onCreated.addListener(createdHandler);
    });

    const pollPromise = (async (): Promise<number> => {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        await sleep(300);
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) {
          if (t.id == null || beforeIds.has(t.id)) continue;
          const u = t.url ?? t.pendingUrl ?? "";
          if (u.includes("gst.gov.in")) return t.id;
        }
      }
      throw new Error("polling timed out after 12s");
    })();

    await chrome.scripting.executeScript({
      target: { tabId: openerTabId },
      func: (u: string) => {
        window.open(u, "_blank");
      },
      args: [targetUrl],
    });

    try {
      popupTabId = await Promise.race([eventPromise, pollPromise]);
    } finally {
      if (createdHandler) {
        chrome.tabs.onCreated.removeListener(createdHandler);
      }
    }
    // v0.7.6 tried chrome.tabs.update(popupTabId, {active: false})
    // to hide the popup — GSTN's WAF bounced because that flips the
    // page-visibility flag the bot detector reads. v0.7.9 keeps the
    // popup active inside its window, but the parent window was
    // opened minimized via chrome.windows.create — Chrome keeps a
    // minimized window minimized when a new tab spawns inside it,
    // so the popup stays hidden without us toggling visibility flags
    // that would trip the WAF.
  } catch (err) {
    return {
      ok: false,
      error: `Failed to open gstr2b popup via window.open: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "POPUP_OPEN_FAILED",
    };
  }
  try {
    await waitForTabLoad(popupTabId, 25000);
  } catch {
    await chrome.tabs.remove(popupTabId).catch(() => {});
    return { ok: false, error: "gstr2b popup did not load within 25s", retryable: true };
  }
  // 5 s for the WAF JS challenge to set its TS-cookie on .gst.gov.in.
  await sleep(5000);

  const finalTab = await chrome.tabs.get(popupTabId).catch(() => null);
  const finalUrl = finalTab?.url ?? "";
  if (finalUrl.includes("accessdenied") || finalUrl.includes("error/accessdenied")) {
    await chrome.tabs.remove(popupTabId).catch(() => {});
    return {
      ok: false,
      error:
        "GSTN bounced to /accessdenied — the account/IP combination is flagged " +
        "(likely Aadhaar / e-KYC pending or short-term IP throttle from too many automation attempts).",
      errorCode: "WAF_ACCESSDENIED",
    };
  }
  if (!finalUrl.includes("gstr2b.gst.gov.in")) {
    await chrome.tabs.remove(popupTabId).catch(() => {});
    return {
      ok: false,
      error: `gstr2b popup landed on unexpected URL: ${finalUrl}`,
      errorCode: "WAF_UNEXPECTED",
    };
  }

  let result: {
    status: number;
    ctype: string;
    body: string;
    error?: string;
  };
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId: popupTabId },
      func: sameOriginFetch2bGetJson,
      args: [period],
    });
    const out = r[0]?.result;
    if (!out || typeof out !== "object") {
      await chrome.tabs.remove(popupTabId).catch(() => {});
      return { ok: false, error: "Popup fetch returned no data", errorCode: "POPUP_EMPTY" };
    }
    result = out as typeof result;
  } catch (err) {
    await chrome.tabs.remove(popupTabId).catch(() => {});
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  await chrome.tabs.remove(popupTabId).catch(() => {});

  if (result.error) {
    return { ok: false, error: result.error, errorCode: "FETCH_THREW" };
  }
  if (result.status !== 200) {
    return {
      ok: false,
      error: `GSTN returned HTTP ${result.status}. First 200 chars: ${result.body.slice(0, 200)}`,
      errorCode: `HTTP_${result.status}`,
      retryable: result.status >= 500,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    return {
      ok: false,
      error: "GSTN returned non-JSON response",
      errorCode: "PARSE_ERROR",
    };
  }
  return {
    ok: true,
    type: "dispatchResult",
    status: "1",
    data: (parsed as { data?: unknown })?.data ?? parsed,
    raw: parsed,
    endpoint: `https://gstr2b.gst.gov.in/gstr2b/auth/api/gstr2b/getjson?rtnprd=${period}`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * v0.8.0 — IMS fetcher (in-tab variant, no popup).
 *
 * After login lands on services.gst.gov.in/auth/dashboard, navigates
 * the same login tab to return.gst.gov.in/returns/auth/dashboard so
 * subsequent fetches to /imsweb/auth/api/ims/... are same-origin (no
 * CORS bounce). Then iterates the 8 inward sections, assembles a
 * GETINV envelope, and returns it.
 *
 * Why same tab + cross-subdomain navigation (not a popup like 2B):
 * gstr2b.gst.gov.in has its own WAF JS challenge that needs the
 * window.open dance to set the per-tab TS-cookie. return.gst.gov.in
 * has no such challenge — just session cookies on the .gst.gov.in
 * apex, which transfer when we navigate via window.location.href.
 */
async function fetchImsViaTab(
  tabId: number,
  gstin: string,
  period: string,
): Promise<FromExtension> {
  const RETURNS_DASH = "https://return.gst.gov.in/returns/auth/dashboard";

  // Navigate same tab to return.gst.gov.in. Use window.location.href
  // (in-page JS nav) instead of chrome.tabs.update — preserves the
  // referer + behaves identically to a real user click.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (u: string) => {
        window.location.href = u;
      },
      args: [RETURNS_DASH],
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      errorCode: "IMS_NAV_FAILED",
    };
  }
  try {
    await waitForTabLoad(tabId, 25000);
  } catch {
    return {
      ok: false,
      error: "return.gst.gov.in dashboard did not load within 25s",
      errorCode: "IMS_NAV_TIMEOUT",
      retryable: true,
    };
  }
  // Settle for cookies + SPA bootstrap.
  await sleep(2000);

  const finalTab = await chrome.tabs.get(tabId).catch(() => null);
  const finalUrl = finalTab?.url ?? "";
  if (finalUrl.includes("accessdenied") || finalUrl.includes("error/accessdenied")) {
    return {
      ok: false,
      error: "GSTN bounced /returns/auth/dashboard to /accessdenied",
      errorCode: "WAF_ACCESSDENIED",
    };
  }
  if (!finalUrl.includes("return.gst.gov.in")) {
    return {
      ok: false,
      error: `Expected to land on return.gst.gov.in, got: ${finalUrl}`,
      errorCode: "IMS_UNEXPECTED_URL",
    };
  }

  // Multi-section fetch in-page. Returns the envelope ready for
  // /api/ims/upload.
  let result: { envelope: Record<string, unknown>; rowCount: number; fetchedSections: number; firstError: string | null };
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: sameOriginFetchImsSections,
      args: [gstin, period],
    });
    const out = r[0]?.result;
    if (!out || typeof out !== "object") {
      return { ok: false, error: "IMS fetch returned no data", errorCode: "IMS_EMPTY" };
    }
    result = out as typeof result;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      errorCode: "IMS_FETCH_THREW",
    };
  }

  if (result.rowCount === 0 && result.firstError) {
    return {
      ok: false,
      error: result.firstError,
      errorCode: "IMS_FETCH_FAILED",
      retryable: true,
    };
  }

  return {
    ok: true,
    type: "fetchImsResult",
    envelope: result.envelope,
    rowCount: result.rowCount,
    fetchedSections: result.fetchedSections,
  };
}

/**
 * v0.9.2 — GSTR-3B fetcher (in-tab variant, captcha-login path).
 *
 * Sibling of fetchImsViaTab: after the captcha-driven login lands on
 * services.gst.gov.in/auth/dashboard, navigate the same tab to
 * return.gst.gov.in/returns/auth/dashboard so subsequent fetches to
 * /returns/auth/api/gstr3b/... and /returns/auth/api/formdetails are
 * same-origin. Then reuse the existing in-page `fetchGstr3bInPage`
 * helper to assemble the standard Gstr3bFetchBundle.
 */
async function fetchGstr3bViaTab(
  tabId: number,
  period: string,
  skipTaxPayable: boolean,
  includeLedgers: boolean,
): Promise<FromExtension> {
  const RETURNS_DASH = "https://return.gst.gov.in/returns/auth/dashboard";

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (u: string) => {
        window.location.href = u;
      },
      args: [RETURNS_DASH],
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      errorCode: "GSTR3B_NAV_FAILED",
    };
  }
  try {
    await waitForTabLoad(tabId, 25000);
  } catch {
    return {
      ok: false,
      error: "return.gst.gov.in dashboard did not load within 25s",
      errorCode: "GSTR3B_NAV_TIMEOUT",
      retryable: true,
    };
  }
  // Settle for cookies + SPA bootstrap.
  await sleep(2000);

  const finalTab = await chrome.tabs.get(tabId).catch(() => null);
  const finalUrl = finalTab?.url ?? "";
  if (finalUrl.includes("accessdenied") || finalUrl.includes("error/accessdenied")) {
    return {
      ok: false,
      error: "GSTN bounced /returns/auth/dashboard to /accessdenied",
      errorCode: "WAF_ACCESSDENIED",
    };
  }
  if (!finalUrl.includes("return.gst.gov.in")) {
    return {
      ok: false,
      error: `Expected to land on return.gst.gov.in, got: ${finalUrl}`,
      errorCode: "GSTR3B_UNEXPECTED_URL",
    };
  }

  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: fetchGstr3bInPage,
      args: [period, skipTaxPayable, includeLedgers],
    });
    const out = r[0]?.result;
    if (!out || typeof out !== "object") {
      return {
        ok: false,
        error: "Content script returned no data",
        errorCode: "GSTR3B_EMPTY",
      };
    }
    return {
      ok: true,
      type: "fetchGstr3bResult",
      bundle: out as {
        ok: boolean;
        formDetails?: unknown;
        summary?: unknown;
        autoPopulated?: unknown;
        taxPayable?: unknown;
        combinedBalance?: unknown;
        openLiabilities?: unknown;
        fetchedAt: string;
        errors: Array<{ step: string; error: string }>;
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      errorCode: "GSTR3B_FETCH_THREW",
    };
  }
}

/**
 * Page-injected — runs inside return.gst.gov.in. Calls each IMS
 * section endpoint with the page's session cookies (same-origin),
 * assembles a GETINV envelope, and returns it.
 *
 * Section response shape (verified 2026-05-10 against live portal):
 *   - getCount?goods_typ=ALL_OTH → { data: { all_oth: { b2b: {...},
 *       b2ba: {...}, ..., ttl_cnt }, imp_gds, inv_supp_isd, ... } }
 *   - getInvoices?gstin=...&section=B2B → { data: { b2b: [...] } }
 *
 * Section param to getInvoices is uppercase (B2B, B2BA, ...). Envelope
 * keys + count keys are lowercase. We only fetch sections with > 0
 * rows per the count call to save round-trips.
 */
function sameOriginFetchImsSections(
  gstin: string,
  period: string,
): Promise<{
  envelope: Record<string, unknown>;
  rowCount: number;
  fetchedSections: number;
  firstError: string | null;
}> {
  return (async () => {
    const SECTIONS = [
      "B2B",
      "B2BA",
      "B2BCN",
      "B2BCNA",
      "B2BDN",
      "B2BDNA",
      "ECOM",
      "ECOMA",
    ];
    const ENV_KEY: Record<string, string> = {
      B2B: "b2b",
      B2BA: "b2ba",
      B2BCN: "b2bcn",
      B2BCNA: "b2bcna",
      B2BDN: "b2bdn",
      B2BDNA: "b2bdna",
      ECOM: "ecom",
      ECOMA: "ecoma",
    };

    const envelope: Record<string, unknown> = { gstin, rtnprd: period };
    let rowCount = 0;
    let fetchedSections = 0;
    let firstError: string | null = null;

    // 1. Section counts.
    const sectionCounts = new Map<string, number>();
    try {
      const r = await fetch(
        "/imsweb/auth/api/ims/getCount?goods_typ=ALL_OTH",
        { credentials: "include", headers: { Accept: "application/json" } },
      );
      if (r.ok) {
        const j = (await r.json()) as {
          data?: {
            all_oth?: Record<
              string,
              | number
              | { accept?: number; noaction?: number; pending?: number; reject?: number }
            >;
          };
        };
        const allOth = j.data?.all_oth;
        if (allOth) {
          for (const [k, v] of Object.entries(allOth)) {
            if (k === "ttl_cnt" || typeof v !== "object" || v === null) continue;
            const a = v as {
              accept?: number;
              noaction?: number;
              pending?: number;
              reject?: number;
            };
            const t = (a.accept ?? 0) + (a.noaction ?? 0) + (a.pending ?? 0) + (a.reject ?? 0);
            sectionCounts.set(k.toUpperCase(), t);
          }
        }
      } else if (!firstError) {
        firstError = `getCount HTTP ${r.status}`;
      }
    } catch (err) {
      if (!firstError) firstError = `getCount: ${err instanceof Error ? err.message : String(err)}`;
    }

    // 2. Per-section invoice fetch. Skip empties.
    for (const sec of SECTIONS) {
      if (sectionCounts.size > 0 && (sectionCounts.get(sec) ?? 0) === 0) continue;
      try {
        const r = await fetch(
          `/imsweb/auth/api/ims/getInvoices?gstin=${encodeURIComponent(gstin)}&section=${sec}`,
          { credentials: "include", headers: { Accept: "application/json" } },
        );
        if (!r.ok) {
          if (!firstError) firstError = `${sec} HTTP ${r.status}`;
          continue;
        }
        const j = (await r.json()) as { data?: Record<string, unknown> };
        const lower = ENV_KEY[sec] ?? sec.toLowerCase();
        const invoices = j.data?.[lower];
        if (Array.isArray(invoices) && invoices.length > 0) {
          envelope[lower] = invoices;
          rowCount += invoices.length;
          fetchedSections++;
        }
      } catch (err) {
        if (!firstError) firstError = `${sec}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return { envelope, rowCount, fetchedSections, firstError };
  })();
}

// ── Page-injected helpers (run inside the login tab, not the SW) ──
//
// These functions are serialised by chrome.scripting.executeScript and
// run in the page's JS context — they can read/write DOM and same-
// origin resources (captcha image included).

async function fillCredsAndCaptureCaptcha(
  username: string,
  password: string,
): Promise<{ ok: boolean; captchaImage?: string; error?: string }> {
  try {
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));

    // Username — heuristic match. Dispatch input + change AND blur — the
    // GST portal's Angular controller listens on blur to render the
    // captcha (per knowledge doc §2.5: "Captcha only appears AFTER
    // typing in the username field").
    const userField = inputs.find(
      (i) => /user/i.test(i.id) || /user/i.test(i.name) || /user/i.test(i.placeholder),
    );
    if (userField) {
      userField.focus();
      userField.value = username;
      userField.dispatchEvent(new Event("input", { bubbles: true }));
      userField.dispatchEvent(new Event("change", { bubbles: true }));
      userField.dispatchEvent(new Event("blur", { bubbles: true }));
    }

    // Password — GST portal has TWO password fields (one hidden decoy
    // + the real visible one). Iterate by visibility; first visible wins.
    for (const candidate of inputs) {
      if (candidate.type !== "password") continue;
      const r = candidate.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = window.getComputedStyle(candidate);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      candidate.focus();
      candidate.value = password;
      candidate.dispatchEvent(new Event("input", { bubbles: true }));
      candidate.dispatchEvent(new Event("change", { bubbles: true }));
      candidate.dispatchEvent(new Event("blur", { bubbles: true }));
      break;
    }

    // Captcha — poll for the img element to be in DOM AND fully loaded
    // (img.complete + naturalWidth > 0). Up to 8 seconds; the portal
    // sometimes lags 2-3s after the username blur to swap the captcha src.
    const captchaSelectors = [
      "img.captcha-image",
      "#captchaImg",
      'img[alt*="captcha" i]',
      'img[src*="captcha" i]',
      ".captcha img",
      "#imgCaptcha",
    ];
    let captchaImg: HTMLImageElement | null = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      for (const sel of captchaSelectors) {
        const el = document.querySelector<HTMLImageElement>(sel);
        if (el && el.complete && (el.naturalWidth || 0) > 0) {
          captchaImg = el;
          break;
        }
      }
      if (captchaImg) break;
      await wait(300);
    }
    if (!captchaImg) {
      return { ok: false, error: "captcha img did not load within 8s" };
    }

    // The captcha is same-origin (services.gst.gov.in/services/captcha?...)
    // so canvas is not tainted. Draw + base64-encode.
    const canvas = document.createElement("canvas");
    canvas.width = captchaImg.naturalWidth || captchaImg.width;
    canvas.height = captchaImg.naturalHeight || captchaImg.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: false, error: "could not get canvas 2d context" };
    ctx.drawImage(captchaImg, 0, 0);
    return { ok: true, captchaImage: canvas.toDataURL("image/png") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Page-injected fetch — runs in the gstr2b.gst.gov.in popup context.
 * Same-origin relative URL means cookies (including the WAF TS-cookie
 * just minted by the JS challenge) attach automatically.
 */
function sameOriginFetch2bGetJson(
  period: string,
): Promise<{ status: number; ctype: string; body: string; error?: string }> {
  return (async () => {
    try {
      const r = await fetch(`/gstr2b/auth/api/gstr2b/getjson?rtnprd=${period}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      return {
        status: r.status,
        ctype: r.headers.get("content-type") ?? "",
        body: await r.text(),
      };
    } catch (err) {
      return {
        status: 0,
        ctype: "",
        body: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  })();
}

function fillCaptchaAndSubmit(captcha: string): { ok: boolean; error?: string } {
  try {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
    const captchaField = inputs.find(
      (i) =>
        /captcha/i.test(i.id) ||
        /captcha/i.test(i.name) ||
        /captcha/i.test(i.placeholder) ||
        /characters/i.test(i.placeholder),
    );
    if (!captchaField) return { ok: false, error: "captcha input not found" };
    captchaField.focus();
    captchaField.value = captcha;
    captchaField.dispatchEvent(new Event("input", { bubbles: true }));
    captchaField.dispatchEvent(new Event("change", { bubbles: true }));
    // Submit. Try button[type=submit] first, then any visible "Login" button.
    let submitBtn: HTMLButtonElement | null =
      document.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!submitBtn) {
      const candidates = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
      submitBtn = candidates.find((b) => /login|sign\s*in|submit/i.test(b.textContent ?? "")) ?? null;
    }
    if (!submitBtn) return { ok: false, error: "submit button not found" };
    submitBtn.click();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function checkForOtpField(): { hasOtp: boolean } {
  const otp = document.querySelector(
    'input[name="otp"], #otp, input[placeholder*="OTP" i], input[id*="otp" i]',
  );
  return { hasOtp: !!otp };
}

function refreshCaptchaAndCapture(): {
  ok: boolean;
  captchaImage?: string;
  error?: string;
} {
  try {
    // Most login pages have a refresh-captcha icon. Click it; otherwise
    // just re-capture the current image (which the form might have
    // refreshed automatically on bad submit).
    const refresh = document.querySelector<HTMLElement>(
      '[onclick*="captcha" i], .captcha-refresh, #captchaRefresh, a[title*="captcha" i]',
    );
    if (refresh) refresh.click();
    const captchaSelectors = [
      "img.captcha-image",
      "#captchaImg",
      'img[alt*="captcha" i]',
      'img[src*="captcha" i]',
      ".captcha img",
      "#imgCaptcha",
    ];
    let captchaImg: HTMLImageElement | null = null;
    for (const sel of captchaSelectors) {
      const el = document.querySelector<HTMLImageElement>(sel);
      if (el) {
        captchaImg = el;
        break;
      }
    }
    if (!captchaImg) {
      return { ok: false, error: "captcha img not found after refresh" };
    }
    const canvas = document.createElement("canvas");
    canvas.width = captchaImg.naturalWidth || captchaImg.width;
    canvas.height = captchaImg.naturalHeight || captchaImg.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: false, error: "could not get canvas 2d context" };
    ctx.drawImage(captchaImg, 0, 0);
    return { ok: true, captchaImage: canvas.toDataURL("image/png") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function fillOtpAndSubmit(otp: string): { ok: boolean; error?: string } {
  try {
    const otpField =
      document.querySelector<HTMLInputElement>('input[name="otp"]') ||
      document.querySelector<HTMLInputElement>("#otp") ||
      document.querySelector<HTMLInputElement>('input[placeholder*="OTP" i]') ||
      document.querySelector<HTMLInputElement>('input[id*="otp" i]');
    if (!otpField) return { ok: false, error: "otp input not found" };
    otpField.focus();
    otpField.value = otp;
    otpField.dispatchEvent(new Event("input", { bubbles: true }));
    otpField.dispatchEvent(new Event("change", { bubbles: true }));
    let submitBtn: HTMLButtonElement | null =
      document.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!submitBtn) {
      const candidates = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
      submitBtn = candidates.find((b) => /verify|submit|continue/i.test(b.textContent ?? "")) ?? null;
    }
    if (!submitBtn) return { ok: false, error: "submit button not found" };
    submitBtn.click();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Auto-update trigger ─────────────────────────────────────

/**
 * Force Chrome to check the manifest's `update_url` for a newer
 * version. Without this call, Chrome only polls every ~5 hours.
 *
 * Returns one of three states from `chrome.runtime.requestUpdateCheck`:
 *   - "no_update"        already running the newest version
 *   - "update_available" newer version downloaded, will install on idle
 *   - "throttled"        called too often; back off + retry
 */
async function triggerUpdateCheck(): Promise<FromExtension> {
  if (!chrome.runtime.requestUpdateCheck) {
    return {
      ok: false,
      error:
        "chrome.runtime.requestUpdateCheck is unavailable. Manifest must declare update_url + the install must be a Chrome-managed extension (not a side-loaded unpacked dir).",
      errorCode: "UPDATE_API_UNAVAILABLE",
    };
  }
  try {
    const result = await new Promise<chrome.runtime.RequestUpdateCheckStatus>((resolve, reject) => {
      // The Chrome API is callback-style in MV3 service workers.
      chrome.runtime.requestUpdateCheck((status) => {
        const lastError = chrome.runtime.lastError?.message;
        if (lastError) reject(new Error(lastError));
        else resolve(status);
      });
    });
    return {
      ok: true,
      type: "updateCheck",
      result,
      currentVersion: EXTENSION_VERSION,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      errorCode: "UPDATE_CHECK_FAILED",
    };
  }
}

// ── Open chrome://extensions ────────────────────────────────

/**
 * Open chrome://extensions in a new tab, focused on this extension's
 * card so the operator can immediately see the version + reload /
 * details buttons. Web pages can't navigate to chrome:// URLs; only
 * extensions can — `chrome.tabs.create({ url: "chrome://..." })`
 * works because the extension's tab API has privileged URL access.
 */
async function openExtensionsPage(): Promise<FromExtension> {
  const url = `chrome://extensions/?id=${chrome.runtime.id}`;
  try {
    const tab = await chrome.tabs.create({ url, active: true });
    return { ok: true, type: "extensionsPageOpened", tabId: tab.id ?? -1 };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      errorCode: "OPEN_TAB_FAILED",
    };
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

/**
 * Find an existing tab on `origin` (e.g. "https://gstr2b.gst.gov.in") or
 * open a fresh one. For gstr2b.gst.gov.in we navigate via the portal-link
 * chain (services → returns dashboard → gstr2b summary) so GSTN's WAF
 * sees a legitimate Referer chain and runs its JS challenge against the
 * new tab — the resulting cookie is what unlocks subsequent same-origin
 * fetch() calls. Direct chrome.tabs.create({ url: gstr2b.gst.gov.in })
 * triggers "Access Denied" because GSTN's WAF rejects the navigation.
 *
 * For other origins (services / return) a direct create+load is fine
 * because the FillGST helper extension has already established cookies
 * via the login flow and those subdomains don't have the gstr2b tier
 * of WAF protection.
 */
async function findOrCreateTabOnOrigin(origin: string): Promise<number | undefined> {
  const existing = await chrome.tabs.query({ url: `${origin}/*` });
  if (existing.length > 0 && existing[0]?.id) return existing[0].id;

  if (origin === "https://gstr2b.gst.gov.in") {
    // WAF dance: navigate via the returns dashboard so the Referer chain
    // matches what a real user would produce. We open a single tab and
    // navigate it through the chain by chrome.tabs.update to avoid
    // popup-blocking (popups from a SW are flaky in MV3).
    const tab = await chrome.tabs.create({
      url: "https://return.gst.gov.in/returns/auth/dashboard",
      active: false,
    });
    if (!tab.id) return undefined;
    await waitForTabLoad(tab.id, 20000);

    // Now point the same tab at the gstr2b summary page. The WAF JS
    // challenge runs against this navigation; the validation cookie
    // sticks on .gst.gov.in for ~30 minutes, which is plenty for the
    // single fetch we're about to make.
    await chrome.tabs.update(tab.id, {
      url: "https://gstr2b.gst.gov.in/gstr2b/auth/gstr2b/summary",
    });
    await waitForTabLoad(tab.id, 25000);
    return tab.id;
  }

  // services.* / return.* / einvoice.* — direct navigation works.
  const tab = await chrome.tabs.create({ url: `${origin}/`, active: false });
  if (!tab.id) return undefined;
  await waitForTabLoad(tab.id, 20000);
  return tab.id;
}

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

// ── Action-code dispatcher ──────────────────────────────────
//
// Mirrors fillgst-helper-node's /portal/dispatch route — same shape so
// the FillGST web app can target either path with identical payloads.
// Reference: docs/compugst-knowledge.md §1 in the FillGST web-app repo.

const REAUTH_FORCELOGIN = new Set(["AUTH4033", "AUTH4041"]);
const REAUTH_FORCEOTP = new Set(["AUTH101", "AUTH151", "AUTH153", "AUTH154"]);
const RETRYABLE_CODES = new Set(["TEC4002", "SWEB_9003"]);

function remapQuarter(period: string): string {
  const map: Record<string, string> = { "21": "06", "22": "09", "23": "12", "24": "03" };
  if (period.length === 6) {
    const mm = period.slice(0, 2);
    if (map[mm]) return map[mm] + period.slice(2);
  }
  return period;
}

function urlForDispatch(msg: Extract<ToExtension, { type: "dispatch" }>): {
  url: string;
  referer: string;
} {
  if (msg.urlOverride) {
    return {
      url: msg.urlOverride,
      referer: "https://return.gst.gov.in/returns/auth/dashboard",
    };
  }
  const period = msg.period ? remapQuarter(msg.period) : undefined;
  const params = new URLSearchParams(msg.params ?? {});

  // GSTR-2B fetch via either the new "GET_GSTR2B" verb (from FillGST web app)
  // or the legacy "B2B" action. Both target gstr2b.gst.gov.in. The actual
  // JSON-bearing endpoint is /api/gstr2b/getjson (verified against the live
  // portal by the GST-PORTAL-AUTOMATION-KNOWLEDGE doc — getjson and getdata
  // return identical bytes; getjson is what the Download page uses).
  if (msg.formNo === "2b" && (msg.action === "GET_GSTR2B" || msg.action === "B2B")) {
    if (period) params.set("rtnprd", period);
    const qs = params.toString();
    return {
      url: `https://gstr2b.gst.gov.in/gstr2b/auth/api/gstr2b/getjson${qs ? "?" + qs : ""}`,
      referer: "https://return.gst.gov.in/returns/auth/dashboard",
    };
  }

  if (msg.formNo === "ims") {
    if (period) params.set("rtnprd", period);
    const action = msg.action === "IMS_FETCH" ? "fetchIMS" : "actionIMS";
    const qs = params.toString();
    return {
      url: `https://return.gst.gov.in/returns2/auth/api/${action}${qs ? "?" + qs : ""}`,
      referer: "https://return.gst.gov.in/returns/auth/dashboard",
    };
  }

  if (period) params.set("ret_period", period);
  params.set("action", msg.action);
  params.set("formno", msg.formNo);
  const qs = params.toString();
  return {
    url: `https://return.gst.gov.in/returns/auth/api/dispatcher${qs ? "?" + qs : ""}`,
    referer: "https://return.gst.gov.in/returns/auth/dashboard",
  };
}

async function dispatchAction(
  msg: Extract<ToExtension, { type: "dispatch" }>,
): Promise<FromExtension> {
  const { url, referer } = urlForDispatch(msg);

  // Determine which subdomain the target URL is on. The injected fetch()
  // runs in the tab's JS context — for it to be SAME-ORIGIN with `url`
  // (cookies sent, no CORS preflight, WAF JS-challenge cookie present),
  // the tab itself must be on the same subdomain.
  //
  // GSTR-2B has its own subdomain (gstr2b.gst.gov.in) with an Akamai WAF
  // JS-challenge that only sets the validation cookie when a real Chrome
  // page loads ON that subdomain. Reusing a return.gst.gov.in tab gives
  // a cross-origin fetch to gstr2b → "Failed to fetch". Reference:
  // testing innovations/gst portal automation knowledge §4.
  const targetOrigin = new URL(url).origin;
  let tabId = await findOrCreateTabOnOrigin(targetOrigin);
  if (!tabId) {
    return { ok: false, error: `Could not open a tab on ${targetOrigin}` };
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: dispatchInPage,
      args: [url, referer, msg.method, msg.body ?? null],
    });
    const out = result[0]?.result;
    if (!out || typeof out !== "object") {
      return { ok: false, error: "Dispatcher returned no data" };
    }
    const r = out as {
      status: number;
      json: unknown;
      networkError?: string;
    };
    if (r.networkError) {
      return { ok: false, error: r.networkError, retryable: true };
    }
    return interpretResponse(r.status, r.json, url);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function dispatchInPage(
  url: string,
  referer: string,
  method: string,
  body: unknown,
): Promise<{ status: number; json: unknown; networkError?: string }> {
  return (async () => {
    try {
      const init: RequestInit = {
        method,
        credentials: "include",
        headers: {
          Accept: "application/json",
          Referer: referer,
          ...(body !== null ? { "Content-Type": "application/json" } : {}),
        },
      };
      if (body !== null) init.body = JSON.stringify(body);
      const resp = await fetch(url, init);
      let json: unknown;
      try {
        json = await resp.json();
      } catch {
        json = await resp.text().catch(() => null);
      }
      return { status: resp.status, json };
    } catch (err) {
      return {
        status: 0,
        json: null,
        networkError: err instanceof Error ? err.message : String(err),
      };
    }
  })();
}

function interpretResponse(status: number, json: unknown, endpoint: string): FromExtension {
  if (status >= 500) {
    return { ok: false, error: `GSTN ${status} on ${endpoint}`, retryable: true };
  }
  const j = json as {
    status?: number | string;
    error?: { errorCode?: string; message?: string };
    data?: unknown;
    ref_id?: string;
  } | null;
  const code = j?.error?.errorCode;
  const reauth = code
    ? REAUTH_FORCELOGIN.has(code)
      ? "FORCELOGIN"
      : REAUTH_FORCEOTP.has(code)
      ? "FORCEOTP"
      : undefined
    : undefined;

  if (status >= 400 || (j && j.status !== undefined && j.status !== 1 && j.status !== "1" && !j.data)) {
    return {
      ok: false,
      errorCode: code,
      error: j?.error?.message ?? `HTTP ${status}`,
      retryable: code ? RETRYABLE_CODES.has(code) : false,
      reauthNeeded: reauth,
    };
  }
  return {
    ok: true,
    type: "dispatchResult",
    status: typeof j?.status === "string" ? j.status : undefined,
    refId: j?.ref_id,
    data: j?.data ?? j ?? undefined,
    raw: json,
    endpoint,
  };
}

// ── Keepalive ───────────────────────────────────────────────

const KEEPALIVE_PATHS = [
  "https://return.gst.gov.in/returns/auth/api/keepalive",
  "https://services.gst.gov.in/services/auth/api/keepalive",
];

async function keepalive(_gstin: string): Promise<FromExtension> {
  const tabs = await chrome.tabs.query({ url: "https://*.gst.gov.in/*" });
  const tabId = tabs[0]?.id;
  if (!tabId) {
    return { ok: false, error: "no portal tab open; nothing to keep alive" };
  }
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: keepaliveInPage,
      args: [KEEPALIVE_PATHS],
    });
    const statuses = (result[0]?.result as number[] | undefined) ?? [];
    return { ok: true, type: "keepaliveResult", statuses };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function keepaliveInPage(paths: string[]): Promise<number[]> {
  return Promise.all(
    paths.map(async (url) => {
      try {
        const r = await fetch(url, { credentials: "include" });
        return r.status;
      } catch {
        return 0;
      }
    }),
  );
}

// ── Tally Bridge (intra-extension messaging) ────────────────
//
// Migrated from the standalone fillgst-tally-bridge extension (v1.0.0,
// May 2026) so a single Chrome install handles both GSTN automation and
// TallyPrime HTTP relay. The page side surface is unchanged:
//
//   window.__fillgstTallyBridge.tallyFetch(xml, opts)   → POST localhost:9000
//   window.__fillgstTallyBridge.ping()                  → version probe
//
// Implemented via a main-world inject (`tally-inject.ts`) + isolated-world
// relay (`tally-relay.ts`) that postMessage-bridges into this listener.
// Allowed only on localhost / 127.0.0.1 :9000 (Tally) and :9876 (helper-node).

const TALLY_ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1"]);
const TALLY_ALLOWED_PORTS = new Set([9000, 9876]);

interface TallyFetchMessage {
  type: "tally-fetch";
  xml?: string;
  host?: string;
  port?: number;
  timeoutMs?: number;
}

interface TallyPingMessage {
  type: "tally-ping";
}

type TallyMessage = TallyFetchMessage | TallyPingMessage;

function isTallyMessage(m: unknown): m is TallyMessage {
  if (!m || typeof m !== "object") return false;
  const t = (m as { type?: unknown }).type;
  return t === "tally-fetch" || t === "tally-ping";
}

chrome.runtime.onMessage.addListener((rawMsg: unknown, _sender, sendResponse) => {
  if (!isTallyMessage(rawMsg)) return false;

  if (rawMsg.type === "tally-ping") {
    sendResponse({ ok: true, version: EXTENSION_VERSION });
    return false;
  }

  // tally-fetch
  const host = String(rawMsg.host ?? "localhost");
  const port = Number(rawMsg.port ?? 9000);
  if (!TALLY_ALLOWED_HOSTS.has(host) || !TALLY_ALLOWED_PORTS.has(port)) {
    sendResponse({
      ok: false,
      status: 0,
      error: `Host:port not allowed by extension (${host}:${port}). Only localhost/127.0.0.1 on :9000 (Tally) or :9876 (helper-node).`,
    });
    return false;
  }

  const timeoutMs = Number(rawMsg.timeoutMs ?? 60_000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const url = `http://${host}:${port}`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8" },
    body: String(rawMsg.xml ?? ""),
    signal: ctrl.signal,
  })
    .then(async (r) => {
      clearTimeout(timer);
      const text = await r.text();
      sendResponse({ ok: r.ok, status: r.status, body: text });
    })
    .catch((err: unknown) => {
      clearTimeout(timer);
      const e = err as { name?: string; message?: string } | undefined;
      const message =
        e?.name === "AbortError"
          ? `Tally didn't respond within ${Math.round(timeoutMs / 1000)}s. Is TallyPrime running with HTTP server on port ${port}?`
          : (e?.message ?? "Tally fetch failed");
      sendResponse({ ok: false, status: 0, error: message });
    });

  // Tell Chrome we'll call sendResponse asynchronously.
  return true;
});

// ── GSTR-1 fetch ─────────────────────────────────────────────
//
// Orchestrates the same multi-call fetch the helper-node performs:
//   1. formdetails           — filing status + ARN + sumGenStatus
//   2. summary               — 46-section totals
//   3. totalsummarycount     — per-section record counts
//   4. invoice?inv=ALL per non-empty section — full invoice arrays
//   5. geteinvdata           — IRN + einvstatus (low-volume; skip flag)
//
// Runs in a return.gst.gov.in tab via chrome.scripting.executeScript
// so cookies + same-origin policy work naturally. Returns the same
// bundle shape as helper-node's Gstr1FetchBundle.

async function fetchGstr1ForPeriod(
  gstin: string,
  period: string,
  skipEInvoice: boolean,
): Promise<FromExtension> {
  const status = await checkLoginStatus(gstin);
  if (!status.ok || !("loggedIn" in status) || !status.loggedIn) {
    return { ok: false, error: "Not logged in. Open the login tab first." };
  }

  // Need a tab on return.gst.gov.in so subsequent fetches are same-origin.
  let tabId: number | undefined;
  const tabs = await chrome.tabs.query({ url: "https://return.gst.gov.in/*" });
  if (tabs.length > 0 && tabs[0]?.id) {
    tabId = tabs[0].id;
  } else {
    const newTab = await chrome.tabs.create({
      url: RETURNS_DASHBOARD_URL,
      active: false,
    });
    if (!newTab.id) {
      return { ok: false, error: "Could not open returns dashboard tab" };
    }
    tabId = newTab.id;
    await waitForTabLoad(tabId, 20000);
  }
  if (!tabId) {
    return { ok: false, error: "No tab available for GSTR-1 fetch" };
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: fetchGstr1InPage,
      args: [period, skipEInvoice],
    });
    const out = result[0]?.result;
    if (!out || typeof out !== "object") {
      return { ok: false, error: "Content script returned no data" };
    }
    return {
      ok: true,
      type: "fetchGstr1Result",
      bundle: out as {
        ok: boolean;
        summary?: unknown;
        counts?: unknown;
        formDetails?: unknown;
        sections: Record<string, unknown>;
        einvoice?: unknown;
        fetchedAt: string;
        errors: Array<{ step: string; error: string }>;
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Injected into a return.gst.gov.in tab. Runs all 4-5 GSTR-1 calls
 *  in sequence (faster than parallel — GSTN's WAF throttles aggressive
 *  parallel requests). Returns a Gstr1FetchBundle-shaped object. */
function fetchGstr1InPage(
  period: string,
  skipEInvoice: boolean,
): Promise<{
  ok: boolean;
  summary?: unknown;
  counts?: unknown;
  formDetails?: unknown;
  sections: Record<string, unknown>;
  einvoice?: unknown;
  fetchedAt: string;
  errors: Array<{ step: string; error: string }>;
}> {
  return (async () => {
    const RETURNS = "https://return.gst.gov.in";
    const errors: Array<{ step: string; error: string }> = [];
    const bundle: {
      ok: boolean;
      summary?: unknown;
      counts?: unknown;
      formDetails?: unknown;
      sections: Record<string, unknown>;
      einvoice?: unknown;
      fetchedAt: string;
      errors: Array<{ step: string; error: string }>;
    } = {
      ok: false,
      sections: {},
      fetchedAt: new Date().toISOString(),
      errors,
    };

    const get = async (url: string, step: string): Promise<unknown | null> => {
      try {
        const r = await fetch(url, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (!r.ok) {
          errors.push({ step, error: `HTTP ${r.status}` });
          return null;
        }
        return await r.json();
      } catch (e) {
        errors.push({ step, error: e instanceof Error ? e.message : String(e) });
        return null;
      }
    };

    // 1. formdetails
    const fd = (await get(
      `${RETURNS}/returns/auth/api/formdetails?rtn_prd=${period}&rtn_typ=GSTR1`,
      "formdetails",
    )) as { data?: unknown } | unknown;
    if (fd) bundle.formDetails = (fd as { data?: unknown }).data ?? fd;

    // 2. summary
    const sm = (await get(
      `${RETURNS}/returns/auth/api/gstr1/summary?rtn_prd=${period}`,
      "summary",
    )) as { data?: unknown } | unknown;
    if (sm) bundle.summary = (sm as { data?: unknown }).data ?? sm;

    // 3. totalsummarycount
    const cn = (await get(
      `${RETURNS}/returns/auth/api/gstr1/totalsummarycount?rtn_prd=${period}`,
      "counts",
    )) as { data?: { sec_count?: unknown }; sec_count?: unknown } | null;
    if (cn) {
      bundle.counts =
        (cn as { data?: { sec_count?: unknown } }).data?.sec_count ??
        (cn as { sec_count?: unknown }).sec_count ??
        [];
    }

    // 4. per-section invoice fetches (only non-empty)
    const sectionsWithData = new Set<string>();
    const countsArr = bundle.counts as Array<{ sec_name: string; proc_cnt?: number }> | undefined;
    if (countsArr) {
      for (const c of countsArr) {
        if ((c.proc_cnt ?? 0) > 0) sectionsWithData.add(c.sec_name);
      }
    }
    const GSTR1_INVOICE_SECTIONS = [
      "B2B",
      "B2BA",
      "CDNR",
      "CDNRA",
      "EXP",
      "EXPA",
      "B2CL",
      "B2CLA",
      "CDNUR",
      "CDNURA",
      "AT",
      "ATA",
      "TXPD",
      "TXPDA",
      "HSN",
      "DOC",
      "NIL",
    ];
    for (const sec of GSTR1_INVOICE_SECTIONS) {
      // If we have counts and this section is empty, skip — saves ~12
      // round-trips on a typical small business.
      if (countsArr && !sectionsWithData.has(sec)) continue;
      const url = `${RETURNS}/returns/auth/api/gstr1/invoice?inv=ALL&rtn_prd=${period}&sec_name=${sec}&uploaded_by=SU`;
      const body = await get(url, `invoice/${sec}`);
      if (body !== null) bundle.sections[sec] = body;
    }

    // 5. geteinvdata (e-Invoice IRN + einvstatus). Optional.
    if (!skipEInvoice) {
      const einv = await get(
        `${RETURNS}/einvoice/auth/api/geteinvdata?rtn_prd=${period}`,
        "geteinvdata",
      );
      if (einv !== null) bundle.einvoice = einv;
    }

    bundle.ok = !!(bundle.summary || bundle.formDetails);
    return bundle;
  })();
}

// ── GSTR-3B fetch ────────────────────────────────────────────
//
// Same shape as helper-node's Gstr3bFetchBundle:
//   1. formdetails    — status + ARN + filing_dt
//   2. summary        — flat sup_details / itc_elg shape (legacy)
//   3. getr1r3bliab   — THE authoritative system-generated values
//                       (nested sup_details.osup_3_1a.subtotal etc.,
//                       elgitc.itc4a5.subtotal etc.)
//   4. taxpayble      — optional, only meaningful post-save

async function fetchGstr3bForPeriod(
  gstin: string,
  period: string,
  skipTaxPayable: boolean,
  includeLedgers: boolean,
): Promise<FromExtension> {
  const status = await checkLoginStatus(gstin);
  if (!status.ok || !("loggedIn" in status) || !status.loggedIn) {
    return {
      ok: false,
      error: "Not logged in to GSTN portal. Click Login first (top of page), then re-click Fetch.",
    };
  }

  // Prefer an existing return.gst.gov.in tab. If none, open ONE as
  // foreground (active:true) so the user sees if GSTN redirects them
  // to the login screen — cookies-present-but-session-expired is the
  // most common failure mode and creates the "Access Denied" pages
  // the CA was seeing. With active:true they spot it immediately.
  let tabId: number | undefined;
  let openedNewTab = false;
  const tabs = await chrome.tabs.query({ url: "https://return.gst.gov.in/*" });
  if (tabs.length > 0 && tabs[0]?.id) {
    tabId = tabs[0].id;
  } else {
    const newTab = await chrome.tabs.create({
      url: RETURNS_DASHBOARD_URL,
      active: true,
    });
    if (!newTab.id) {
      return { ok: false, error: "Could not open returns dashboard tab" };
    }
    tabId = newTab.id;
    openedNewTab = true;
    await waitForTabLoad(tabId, 20000);
  }
  if (!tabId) {
    return { ok: false, error: "No tab available for GSTR-3B fetch" };
  }

  // Session validity check — cookies may be present but expired. Inject
  // a tiny probe that returns the current URL + a sample auth-check
  // header. If GSTN redirected us to a login / access-denied page,
  // bail out with a friendly error instead of running all the API
  // calls and getting 403s.
  try {
    const probe = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: location.href,
        title: document.title,
        accessDenied:
          /access\s*denied/i.test(document.body?.innerText ?? "") ||
          /access\s*denied/i.test(document.title),
      }),
    });
    const r = probe[0]?.result;
    const onLogin =
      r?.url?.includes("/services/login") ||
      r?.url?.includes("/services/auth/fowelcome") ||
      r?.url?.includes("/services/auth/login");
    if (onLogin || r?.accessDenied) {
      // Navigate the tab to the login URL so the user can sign in
      // without manual URL typing.
      if (openedNewTab) await chrome.tabs.update(tabId, { url: LOGIN_URL });
      return {
        ok: false,
        error:
          "GSTN session expired or not logged in. A login tab has been opened — please sign in, then re-click Fetch.",
      };
    }
  } catch {
    // Probe failed (script injection blocked or page navigation in
    // flight). Fall through — the per-fetch error reporting will catch
    // anything that's actually broken.
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: fetchGstr3bInPage,
      args: [period, skipTaxPayable, includeLedgers],
    });
    const out = result[0]?.result;
    if (!out || typeof out !== "object") {
      return { ok: false, error: "Content script returned no data" };
    }
    return {
      ok: true,
      type: "fetchGstr3bResult",
      bundle: out as {
        ok: boolean;
        formDetails?: unknown;
        summary?: unknown;
        autoPopulated?: unknown;
        taxPayable?: unknown;
        combinedBalance?: unknown;
        openLiabilities?: unknown;
        fetchedAt: string;
        errors: Array<{ step: string; error: string }>;
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function fetchGstr3bInPage(
  period: string,
  skipTaxPayable: boolean,
  includeLedgers: boolean,
): Promise<{
  ok: boolean;
  formDetails?: unknown;
  summary?: unknown;
  autoPopulated?: unknown;
  taxPayable?: unknown;
  combinedBalance?: unknown;
  openLiabilities?: unknown;
  fetchedAt: string;
  errors: Array<{ step: string; error: string }>;
}> {
  return (async () => {
    const RETURNS = "https://return.gst.gov.in";
    const errors: Array<{ step: string; error: string }> = [];
    const bundle: {
      ok: boolean;
      formDetails?: unknown;
      summary?: unknown;
      autoPopulated?: unknown;
      taxPayable?: unknown;
      combinedBalance?: unknown;
      openLiabilities?: unknown;
      fetchedAt: string;
      errors: Array<{ step: string; error: string }>;
    } = {
      ok: false,
      fetchedAt: new Date().toISOString(),
      errors,
    };

    const get = async (url: string, step: string): Promise<unknown | null> => {
      try {
        const r = await fetch(url, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (!r.ok) {
          errors.push({ step, error: `HTTP ${r.status}` });
          return null;
        }
        return await r.json();
      } catch (e) {
        errors.push({ step, error: e instanceof Error ? e.message : String(e) });
        return null;
      }
    };

    // 1. formdetails
    const fd = (await get(
      `${RETURNS}/returns/auth/api/formdetails?rtn_prd=${period}&rtn_typ=GSTR3B`,
      "formdetails",
    )) as { data?: unknown } | unknown;
    if (fd) bundle.formDetails = (fd as { data?: unknown }).data ?? fd;

    // 2. summary (legacy flat shape)
    const sm = (await get(
      `${RETURNS}/returns/auth/api/gstr3b/summary?rtn_prd=${period}`,
      "summary",
    )) as { data?: unknown } | unknown;
    if (sm) bundle.summary = (sm as { data?: unknown }).data ?? sm;

    // 3. getr1r3bliab — THE authoritative system-generated values
    //    Note: param name is `retPeriod` (camel-case, no underscore) —
    //    verified gotcha. The response nests data under r3bautopop.liabitc.
    const ap = (await get(
      `${RETURNS}/returns/auth/api/gstr3b/getr1r3bliab?retPeriod=${period}`,
      "getr1r3bliab",
    )) as { data?: { r3bautopop?: { liabitc?: unknown } } } | null;
    if (ap) {
      bundle.autoPopulated = ap?.data?.r3bautopop?.liabitc ?? null;
    }

    // 4. taxpayble (only meaningful post-save)
    if (!skipTaxPayable) {
      const tp = (await get(
        `${RETURNS}/returns/auth/api/gstr3b/taxpayble?rtn_prd=${period}`,
        "taxpayble",
      )) as { data?: unknown } | unknown;
      if (tp) bundle.taxPayable = (tp as { data?: unknown }).data ?? tp;
    }

    // 5. Ledgers (combined cash + ITC balance + open liabilities). One-
    //    shot getbalance returns both ledgers in a single call from the
    //    return.gst.gov.in session — no cross-domain hop needed.
    if (includeLedgers) {
      const bal = (await get(
        `${RETURNS}/returns/auth/api/getbalance?ret_period=${period}`,
        "getbalance",
      )) as { data?: unknown } | unknown;
      if (bal) bundle.combinedBalance = (bal as { data?: unknown }).data ?? bal;

      // Open liabilities — surfaces error LG9029 "No Data Found" when
      // empty; we treat that as { items: [], empty: true } downstream.
      const liab = (await get(
        `${RETURNS}/returns/auth/api/getopenliabilities`,
        "getopenliabilities",
      )) as { data?: { open_liab?: unknown[] }; errorCode?: string } | unknown;
      if (liab) {
        const liabObj = liab as { data?: { open_liab?: unknown[] }; errorCode?: string };
        if (liabObj.errorCode === "LG9029") {
          bundle.openLiabilities = { items: [], empty: true };
        } else {
          const items = liabObj.data?.open_liab ?? [];
          bundle.openLiabilities = { items, empty: items.length === 0 };
        }
      }
    }

    bundle.ok = !!(bundle.autoPopulated || bundle.summary || bundle.formDetails);
    return bundle;
  })();
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
