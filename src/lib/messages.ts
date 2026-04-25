/**
 * Shared message types between FillGST web app and the extension.
 *
 * The web app calls chrome.runtime.sendMessage(EXTENSION_ID, message)
 * and the extension's onMessageExternal handler dispatches based on `type`.
 *
 * Keep this file in sync with the copy in the FillGST web app:
 *   FILLGSTV1/src/lib/portal/extension-bridge.ts
 */

export type ToExtension =
  | { type: "ping" }
  | { type: "loginCheck"; gstin: string }
  | { type: "openLogin"; gstin: string }
  | { type: "fetch2b"; gstin: string; period: string }
  | { type: "logout"; gstin: string };

export type FromExtension =
  | { ok: true; type: "pong"; version: string }
  | { ok: true; type: "loginStatus"; loggedIn: boolean; cookieCount: number }
  | { ok: true; type: "loginOpened"; tabId: number; message: string }
  | { ok: true; type: "fetch2bResult"; data: unknown; size: number }
  | { ok: true; type: "loggedOut" }
  | { ok: false; error: string };

export const EXTENSION_NAME = "FillGST Helper";
export const EXTENSION_VERSION = "0.2.0";

/**
 * Stable Chrome extension ID, deterministically derived from the public
 * key in manifest.json (#key field). Will not change as long as
 * .keys/extension.pem stays the same — see .keys/README.md.
 *
 * The FillGST web app uses this to target the extension via
 *   chrome.runtime.sendMessage(EXTENSION_ID, ...).
 */
export const EXTENSION_ID = "cbkmghnncpgkoedbppgimdidbkffnbij";
