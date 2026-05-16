/**
 * Shared message types between FillGST web app and the extension.
 *
 * The web app calls chrome.runtime.sendMessage(EXTENSION_ID, message)
 * and the extension's onMessageExternal handler dispatches based on `type`.
 *
 * Keep this file in sync with the copy in the FillGST web app:
 *   FILLGSTV1/src/lib/portal/extension-bridge.ts
 */

export type FormNo =
  | "1" | "1a" | "2" | "2a" | "2b"
  | "3" | "3b"
  | "4" | "4a" | "4x"
  | "6" | "7" | "8"
  | "9" | "9a" | "9c"
  | "returns" | "ledger" | "ims" | "einv" | "ewb";

export type ActionCode =
  | "RETSAVE" | "RETSUBMIT" | "RETFILE" | "RETNEWPTF" | "RETFILER1A"
  | "RETSUM" | "RETSTATUS" | "RETACCEPT" | "RETOFFSET" | "GENERATE"
  | "CASH" | "RECORDS" | "FORCEOTP" | "FORCELOGIN"
  | "GET_GSTR2B"
  | "B2B" | "B2BA" | "B2CL" | "B2CLA" | "B2CS" | "B2CSA"
  | "CDNR" | "CDNRA" | "CDNUR" | "CDNURA"
  | "EXP" | "EXPA" | "NIL" | "HSN" | "HSNSUM"
  | "DOC" | "DOCISS" | "AT" | "ATA" | "TXP" | "TXPA"
  | "TXOS" | "TXOSA" | "TXLI" | "ECOM"
  | "IMPG" | "IMPGSEZ" | "IMPS" | "ISD" | "ISDA"
  | "TDS" | "TCS" | "ITCRVSL"
  | "IMS_FETCH" | "IMS_ACTION" | "IMS_RESET" | "IMS_REFRESH"
  | "EINV_AUTH" | "EINV_GENIRN" | "EINV_BULKGEN" | "EINV_CANCEL"
  | "EINV_GETIRN" | "EINV_GETGSTIN" | "EINV_GETCANCEL"
  | "EWB_AUTH" | "EWB_GENERATE" | "EWB_UPDATE_VEHICLE" | "EWB_UPDATE_TRANSPORTER"
  | "EWB_EXTEND" | "EWB_CANCEL" | "EWB_GET" | "EWB_GETBYGST" | "EWB_MULTIVEHICLE";

export type Method = "GET" | "POST" | "PUT";

export type ToExtension =
  | { type: "ping" }
  | { type: "checkUpdate" }
  | { type: "openExtensionsPage" }
  | { type: "loginCheck"; gstin: string }
  | { type: "openLogin"; gstin: string }
  // Open the GST portal login tab AND pre-fill username + password
  // (waits for the DOM, fills both fields, dispatches input/change/blur
  // so Angular sees the values and the portal swaps in the captcha).
  // Does NOT capture the captcha image — the user solves it directly
  // in the portal tab. After login, the session cookies live in their
  // own Chrome browser, so any subsequent gst.gov.in navigation in
  // that browser is logged in.
  //
  // Used by FillGST's per-client "Login to GST portal" button: the web
  // app POSTs to /api/portal/helper/credentials to decrypt the saved
  // username/password, then sends them through this message. Cloud
  // never persists them; they live in this single SW message round-trip.
  | { type: "openLoginAutofilled"; gstin: string; username: string; password: string }
  | { type: "fetch2b"; gstin: string; period: string }
  // GSTR-1 portal fetch — runs from a return.gst.gov.in tab. Orchestrates
  // 4 sub-fetches (formdetails / summary / totalsummarycount /
  // invoice?inv=ALL per non-empty section) + optional geteinvdata for
  // IRN + einvstatus. Returns a single `fetchGstr1Result` bundle the
  // web app persists into Gstr1Snapshot + Gstr1PortalGet.
  //
  // Same shape as `Gstr1FetchBundle` produced by the helper-node path —
  // the web app accepts both interchangeably.
  | { type: "fetchGstr1"; gstin: string; period: string; skipEInvoice?: boolean }
  // GSTR-3B portal fetch — runs from a return.gst.gov.in tab. Hits
  // formdetails + summary + getr1r3bliab (the system-generated
  // Section II/III breakdown). Optionally taxpayble (only meaningful
  // post-save). Returns a single `fetchGstr3bResult` bundle matching
  // `Gstr3bFetchBundle`.
  | {
      type: "fetchGstr3b";
      gstin: string;
      period: string;
      skipTaxPayable?: boolean;
      /** Include cash + ITC balance + open liabilities. Enables the
       *  "Fetch all system data for filing 3B" one-click workflow. */
      includeLedgers?: boolean;
    }
  | {
      type: "dispatch";
      gstin: string;
      action: ActionCode;
      formNo: FormNo;
      period?: string;
      method: Method;
      body?: unknown;
      params?: Record<string, string>;
      urlOverride?: string;
    }
  // Auto-login + fetch-2B in one flow. Mirrors the Playwright-driven
  // helper-node /portal/login + /portal/captcha + /portal/otp + /portal/fetch2b
  // sequence — but inside the user's Chrome via chrome.tabs +
  // chrome.scripting.executeScript. The web app captures the captcha
  // image returned by `needsCaptcha` and shows it in the FillGST UI;
  // user types into FillGST; web app sends back via `submitLoginCaptcha`.
  // Same flow for OTP. On success, returns `fetch2bResult` directly.
  | {
      type: "loginAndFetch2b";
      sessionId: string;
      gstin: string;
      period: string;
      username?: string;
      password?: string;
    }
  | { type: "submitLoginCaptcha"; sessionId: string; captcha: string }
  | { type: "submitLoginOtp"; sessionId: string; otp: string }
  | { type: "cancelLoginFlow"; sessionId: string }
  // Auto-login + fetch-IMS in one flow. Same login state machine as
  // loginAndFetch2b — the only difference is the fetch step. After
  // login lands on services.gst.gov.in/auth/dashboard, the same login
  // tab is navigated to return.gst.gov.in/returns/auth/dashboard so
  // subsequent in-page fetches to /imsweb/auth/api/ims/... are
  // same-origin. We then iterate the inward sections (B2B / B2BA /
  // B2BCN / B2BCNA / B2BDN / B2BDNA / ECOM / ECOMA), assemble a
  // GETINV envelope, and return it via `imsResult`. Web app POSTs
  // the envelope to /api/ims/upload for parse + persist.
  | {
      type: "loginAndFetchIms";
      sessionId: string;
      gstin: string;
      period: string;
      username?: string;
      password?: string;
    }
  // v0.9.2 — Auto-login + fetch-GSTR-3B in one flow. Identical login
  // state machine as loginAndFetchIms (captcha → optional OTP →
  // dashboard). Post-login, the same tab is navigated to
  // return.gst.gov.in and we issue the standard 3B in-page fetches:
  // formdetails + summary + getr1r3bliab (+ optional taxpayble,
  // getbalance, getopenliabilities). Returns `fetchGstr3bResult`
  // matching `Gstr3bFetchBundle`.
  | {
      type: "loginAndFetchGstr3b";
      sessionId: string;
      gstin: string;
      period: string;
      username?: string;
      password?: string;
      skipTaxPayable?: boolean;
      includeLedgers?: boolean;
    }
  | { type: "keepalive"; gstin: string }
  | { type: "logout"; gstin: string };

export type FromExtension =
  | { ok: true; type: "pong"; version: string }
  | {
      ok: true;
      type: "updateCheck";
      /**
       * Chrome's response from `chrome.runtime.requestUpdateCheck`:
       *   - "no_update"  : already on the newest version
       *   - "update_available" : a newer version was found and queued
       *   - "throttled"  : Chrome rate-limited us; try again in a few seconds
       *
       * When the result is "update_available", the new version installs
       * automatically the next time the service worker idles. The web app
       * pings again after a short delay to confirm the bump.
       */
      result: "no_update" | "update_available" | "throttled";
      currentVersion: string;
    }
  | { ok: true; type: "extensionsPageOpened"; tabId: number }
  | { ok: true; type: "loginStatus"; loggedIn: boolean; cookieCount: number }
  | { ok: true; type: "loginOpened"; tabId: number; message: string }
  // Sibling of `loginOpened` — same shape plus `prefilled: true` when
  // the username + password were successfully injected into the form,
  // false when the tab opened but fill failed (slow DOM, selector miss).
  // Either way the tab is open; the web app shows a contextual hint.
  | {
      ok: true;
      type: "loginAutofilled";
      tabId: number;
      prefilled: boolean;
      message: string;
    }
  | { ok: true; type: "fetch2bResult"; data: unknown; size: number }
  // GSTR-1 bundle — same fields as helper-node's Gstr1FetchBundle so the
  // web app accepts both paths identically.
  | {
      ok: true;
      type: "fetchGstr1Result";
      bundle: {
        ok: boolean;
        summary?: unknown;
        counts?: unknown;
        formDetails?: unknown;
        sections: Record<string, unknown>;
        einvoice?: unknown;
        fetchedAt: string;
        errors: Array<{ step: string; error: string }>;
      };
    }
  // GSTR-3B bundle — same fields as helper-node's Gstr3bFetchBundle.
  // `combinedBalance` + `openLiabilities` are populated only when the
  // request had `includeLedgers: true`.
  | {
      ok: true;
      type: "fetchGstr3bResult";
      bundle: {
        ok: boolean;
        formDetails?: unknown;
        summary?: unknown;
        autoPopulated?: unknown;
        taxPayable?: unknown;
        combinedBalance?: unknown;
        openLiabilities?: unknown;
        fetchedAt: string;
        errors: Array<{ step: string; error: string }>;
      };
    }
  // Result of loginAndFetchIms — `envelope` is a GETINV-shaped object
  // ready to POST to the web app's /api/ims/upload. `rowCount` is the
  // total invoices across the populated sections. `fetchedSections` is
  // the count of non-empty sections that produced rows.
  | {
      ok: true;
      type: "fetchImsResult";
      envelope: unknown;
      rowCount: number;
      fetchedSections: number;
    }
  // Auto-login mid-flow states. The web app shows the captcha image in
  // the FillGST modal, captures the user's typed text, and sends it
  // back via `submitLoginCaptcha`. Same for OTP. `needsCredentials`
  // is sent when the web app called `loginAndFetch2b` without
  // username/password; the web app should fetch decrypted creds from
  // its own /api/portal/helper/credentials endpoint and re-send.
  | { ok: true; type: "needsCredentials"; sessionId: string }
  | { ok: true; type: "needsCaptcha"; sessionId: string; captchaImage: string }
  | { ok: true; type: "needsOtp"; sessionId: string }
  | { ok: true; type: "loginCancelled"; sessionId: string }
  | {
      ok: true;
      type: "dispatchResult";
      status?: string;
      refId?: string;
      data?: unknown;
      raw: unknown;
      endpoint: string;
    }
  | { ok: true; type: "keepaliveResult"; statuses: number[] }
  | { ok: true; type: "loggedOut" }
  | {
      ok: false;
      error: string;
      errorCode?: string;
      retryable?: boolean;
      reauthNeeded?: "FORCELOGIN" | "FORCEOTP";
    };

export const EXTENSION_NAME = "FillGST Helper";
export const EXTENSION_VERSION = "0.9.3";

/**
 * Stable Chrome extension ID, deterministically derived from the public
 * key in manifest.json (#key field). Will not change as long as
 * .keys/extension.pem stays the same — see .keys/README.md.
 *
 * The FillGST web app uses this to target the extension via
 *   chrome.runtime.sendMessage(EXTENSION_ID, ...).
 */
export const EXTENSION_ID = "cbkmghnncpgkoedbppgimdidbkffnbij";
