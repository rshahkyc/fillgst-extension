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
  | { type: "fetch2b"; gstin: string; period: string }
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
  | { ok: true; type: "fetch2bResult"; data: unknown; size: number }
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
export const EXTENSION_VERSION = "0.7.0";

/**
 * Stable Chrome extension ID, deterministically derived from the public
 * key in manifest.json (#key field). Will not change as long as
 * .keys/extension.pem stays the same — see .keys/README.md.
 *
 * The FillGST web app uses this to target the extension via
 *   chrome.runtime.sendMessage(EXTENSION_ID, ...).
 */
export const EXTENSION_ID = "cbkmghnncpgkoedbppgimdidbkffnbij";
