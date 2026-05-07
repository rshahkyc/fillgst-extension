/**
 * Tally Bridge — isolated-world relay.
 *
 * Bridges the main-world `tally-inject.ts` to the extension's background
 * service worker. We need this hop because:
 *   - main-world scripts can't call `chrome.runtime.sendMessage`
 *   - isolated-world scripts can't expose `window.__fillgstTallyBridge`
 *
 * So this script does the boring work of shuttling postMessage requests
 * one direction and replies the other.
 *
 * Migrated 2026-05-07 from the standalone fillgst-tally-bridge extension
 * (v1.0.0) into the unified FillGST Helper.
 */

type RelayRequest = {
  kind: "fillgst-tally-bridge-request";
  id: number;
  type: "tally-fetch" | "tally-ping";
  xml?: string;
  host?: string;
  port?: number;
  timeoutMs?: number;
};

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as RelayRequest | undefined;
  if (!data || data.kind !== "fillgst-tally-bridge-request") return;

  const { id, type } = data;
  if (type !== "tally-fetch" && type !== "tally-ping") return;

  chrome.runtime.sendMessage(
    {
      type,
      xml: data.xml,
      host: data.host,
      port: data.port,
      timeoutMs: data.timeoutMs,
    },
    (resp: { ok: boolean; status?: number; body?: string; version?: string; error?: string }) => {
      const lastError = chrome.runtime.lastError?.message;
      const reply = lastError
        ? { ok: false, status: 0, error: lastError }
        : (resp ?? { ok: false, status: 0, error: "No response from extension" });
      window.postMessage(
        { kind: "fillgst-tally-bridge-response", id, ...reply },
        window.location.origin,
      );
    },
  );
});
