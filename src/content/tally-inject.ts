/**
 * Tally Bridge — main-world inject script.
 *
 * Runs in the page's main JS world (NOT the extension's isolated world),
 * which is what lets us expose `window.__fillgstTallyBridge` to the
 * fillgst.com React app. The app uses this global to POST TDL XML to
 * TallyPrime's HTTP server (port 9000) on the same PC, without ever
 * sending books data over the public internet.
 *
 * Wire flow (each call hops 4 message boundaries):
 *
 *   page React code
 *      → window.postMessage("fillgst-tally-bridge-request", ...)
 *      → tally-relay.ts (isolated world)
 *      → chrome.runtime.sendMessage({ type: "tally-fetch", ... })
 *      → background.ts (service worker)
 *      → fetch http://localhost:9000
 *      ← response body bubbles back through the same chain
 *
 * Migrated 2026-05-07 from the standalone fillgst-tally-bridge extension
 * (v1.0.0) into the unified FillGST Helper. The page-side API
 * (`window.__fillgstTallyBridge`) is unchanged so the existing FillGST
 * `tally-live-gstr1/browser-client.ts` keeps working without edits.
 */

interface TallyBridge {
  version: string;
  ping: () => Promise<{ ok: boolean; version?: string; error?: string }>;
  tallyFetch: (
    xml: string,
    opts?: { host?: string; port?: number; timeoutMs?: number },
  ) => Promise<{ ok: boolean; status: number; body?: string; error?: string }>;
}

declare global {
  interface Window {
    __fillgstTallyBridge?: TallyBridge;
  }
}

// Make this file an ES module so the `declare global` augmentation
// above is hoisted into the global scope (TS treats top-level scripts
// without imports/exports as ambient and rejects global augmentations).
// At runtime crxjs / Vite still emits this as a plain content script.
export {};

(() => {
  if (window.__fillgstTallyBridge) return;

  // Read the host extension's version off the marker that
  // `fillgst-marker.ts` wrote to <html data-fillgst-helper-version=…>.
  // Falls back to "0" if the marker isn't there yet (rare race; the
  // marker also runs at document_start so usually beats us).
  const VERSION = document.documentElement.dataset.fillgstHelperVersion ?? "0";

  let nextId = 1;
  const pending = new Map<number, (msg: unknown) => void>();

  type RelayResponse = {
    kind: "fillgst-tally-bridge-response";
    id: number;
    ok: boolean;
    status?: number;
    body?: string;
    version?: string;
    error?: string;
  };

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as RelayResponse | undefined;
    if (!data || data.kind !== "fillgst-tally-bridge-response") return;
    const cb = pending.get(data.id);
    if (cb) {
      pending.delete(data.id);
      cb(data);
    }
  });

  function call(payload: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      window.postMessage(
        { kind: "fillgst-tally-bridge-request", id, ...payload },
        window.location.origin,
      );
      // Backstop timeout in case the relay/background dies mid-call.
      // The background already enforces its own timeoutMs; this is a few
      // seconds longer so the inner error wins when both fire.
      const timeout = Math.max(15_000, Number(payload.timeoutMs ?? 60_000) + 5_000);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ ok: false, status: 0, error: "Bridge timeout" });
        }
      }, timeout);
    });
  }

  window.__fillgstTallyBridge = {
    version: VERSION,
    ping: () =>
      call({ type: "tally-ping" }) as Promise<{
        ok: boolean;
        version?: string;
        error?: string;
      }>,
    tallyFetch: (xml, opts) =>
      call({
        type: "tally-fetch",
        xml,
        host: opts?.host ?? "localhost",
        port: opts?.port ?? 9000,
        timeoutMs: opts?.timeoutMs ?? 60_000,
      }) as Promise<{ ok: boolean; status: number; body?: string; error?: string }>,
  };

  // One-shot ready event so eager listeners don't have to poll.
  window.dispatchEvent(
    new CustomEvent("fillgst-tally-bridge-ready", { detail: { version: VERSION } }),
  );
})();
