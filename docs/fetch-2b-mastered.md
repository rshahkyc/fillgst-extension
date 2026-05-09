# GSTR-2B without-OTP fetch — extension recovery guide

> **2026-05-10 status:** This extension is the **fallback path** for GSTR-2B
> fetch. The PRIMARY path is now `fillgst-helper-node` running Playwright
> headless at `localhost:9876` (zero Chrome windows). The extension was
> retired from the FillGST webapp picker. This doc is preserved so the
> extension path can be revived if helper-node ever can't be used (locked-down
> corporate IT, etc.). Frozen working state is git tag `v0.7.9` at commit
> `fb80821`.

If the without-OTP GSTR-2B fetch breaks AND the user can't use helper-node,
this is the canonical recovery checkpoint for the extension path. Mastered
and verified end-to-end on **2026-05-10** with extension v0.7.5–v0.7.9.
Do NOT refactor the WAF dance code without reading this document end-to-end
first.

## TL;DR

FillGST extension v0.7.5+ + the FillGST webapp can fetch GSTR-2B JSON
from the GST portal **without OTP**, **without GSP fees**, and **without
server-side Playwright**. Verified across:

| Path | Period | Time | Rows | Visibility |
|---|---|---|---|---|
| Warm (cookies still valid) | Dec-2025 | ~12 s | 3 | Brief tab flash |
| Warm | Jul-2025 | ~12 s | 10 | Brief tab flash |
| Cold (browser fully closed first) | Sep-2025 | ~22 s | 19 (₹47.86 L taxable) | Login + popup tabs visible |
| **v0.7.9 minimized window** | confirmed | ~22 s | n/a | **Taskbar entry only — no main-window flash** |

For truly invisible fetch (zero Chrome windows), see helper-node primary path
documented in `~/.claude/.../memory/project_fetch_2b_mastered.md`.

## The single hardest insight (do not lose)

**GSTN's WAF treats `window.open()` from a logged-in same-domain-family
page fundamentally differently from `chrome.tabs.create()` or
typed-URL navigation.**

| Approach | Outcome |
|---|---|
| `window.open` invoked from inside a `services.gst.gov.in` page's main JS context | WAF lets the new tab through, sets the gstr2b TS-cookie, page loads, same-origin fetch returns 200 |
| `chrome.tabs.create({ url: 'https://gstr2b...' })` | Bounces to `/error/accessdenied`. This was the v0.7.2 / v0.7.3 failure mode |

The `window.open` MUST be called **from inside an `executeScript()`
running in a logged-in `*.gst.gov.in` tab** — not from the service
worker, not from any other origin. The opener tab is the credential
bridge.

This was discovered originally in fillgst-helper-node's
[`portal-runner.ts`](https://github.com/rshahkyc/fillgst-helper-node)
lines 491-498 (Playwright `page.evaluate(window.open(u, '_blank'))`)
and ported into the extension as `chrome.scripting.executeScript({ func:
u => window.open(u, '_blank') })`.

The verbose comment block at [`src/background.ts:368-374`](../src/background.ts#L368)
explains this further. **Preserve that comment when refactoring.**

## The flow, end to end

### Components

| Side | File | Role |
|---|---|---|
| Web app | `src/app/(app)/clients/[gstin]/returns/gstr2b/[period]/fetch-from-portal-button.tsx` | "Fetch without OTP" button + picker |
| Web app | `src/lib/portal/extension-runner.ts` :: `runLoginAndFetch2bViaExtension` | Orchestrator: pulls creds, sends loginAndFetch2b, loops captcha/otp callbacks, posts result |
| Web app | `src/lib/portal/extension-bridge.ts` | `sendToExtension(msg, timeoutMs)` typed wrapper around `chrome.runtime.sendMessage` |
| Web app | `/api/portal/helper/credentials` | Returns decrypted GSTIN creds (for the user's own GSTIN only) |
| Web app | `/api/portal/extension/fetch-2b/result` | Persists the fetched JSON, returns `{ snapshotId, rowCount, schemaVer, alreadyPersisted }` |
| Extension | `src/background.ts` :: `loginAndFetch2b` | Top-level: checks cookies, opens login tab if needed, captures captcha |
| Extension | `src/background.ts` :: `silentFetch2b` | Warm-path: cookies valid, skip captcha, go straight to popup dance |
| Extension | `src/background.ts` :: `popupAndFetch2b` | **The critical function.** WAF dance + same-origin fetch + close popup |
| Extension | `src/background.ts` :: `fillCredsAndCaptureCaptcha` | Page-injected: types creds, polls for captcha img, returns base64 PNG |
| Extension | `src/background.ts` :: `sameOriginFetch2bGetJson` | Page-injected: `fetch('/gstr2b/auth/api/gstr2b/getjson?rtnprd=...', {credentials:'include'})` |
| Extension | `src/lib/messages.ts` | Shared message types — keep in sync with webapp's `extension-bridge.ts` |

### Warm path (cookies still valid)

```
[Web app] click Fetch without OTP
  → POST /api/portal/helper/credentials → { username, password }
  → chrome.runtime.sendMessage(EXTENSION_ID, {type:loginAndFetch2b, gstin, period, username, password})

[Extension] handleMessage → loginAndFetch2b
  → checkLoginStatus(gstin) → loggedIn:true
  → silentFetch2b(period)
    → chrome.tabs.query({url:"https://services.gst.gov.in/*"}) → reuse or create hidden opener tab
    → popupAndFetch2b(openerTabId, period)
      → snapshot existing tab IDs (beforeIds set)
      → race(onCreated event listener, polling chrome.tabs.query @ 300ms)
      → chrome.scripting.executeScript({ target: openerTabId, func: u => window.open(u, '_blank') })
      → popup tab detected by either strategy → resolve popupTabId
      → chrome.tabs.update(popupTabId, {active:false})  ← v0.7.6: hide popup immediately
      → waitForTabLoad(popupTabId, 25s)
      → sleep(5s)  ← critical for WAF JS challenge to set TS-cookie
      → guard: if URL contains 'accessdenied' → WAF_ACCESSDENIED error
      → executeScript({target: popupTabId, func: sameOriginFetch2bGetJson, args: [period]})
      → fetch('/gstr2b/auth/api/gstr2b/getjson?rtnprd='+period, {credentials:'include'})
      → returns {status:200, body:'{"data":{...}}'}
      → chrome.tabs.remove(popupTabId)
      → return { ok:true, type:'dispatchResult', data, raw, endpoint }

[Web app] extResp.type === 'dispatchResult'
  → POST /api/portal/extension/fetch-2b/result with the data
  → returns { snapshotId, rowCount:19, schemaVer:'V4', alreadyPersisted:false }
  → UI refreshes: "fetched DD/MM/YYYY HH:MM:SS · Fetched N rows · schema V4."
```

### Cold path (browser closed, no cookies)

Same as warm, but the first `checkLoginStatus` returns `loggedIn:false`,
so loginAndFetch2b takes the **full login** branch:

```
loginAndFetch2b
  → checkLoginStatus → loggedIn:false
  → chrome.tabs.create({url:'https://services.gst.gov.in/services/login', active:false})  ← v0.7.6: hidden
  → executeScript({func: fillCredsAndCaptureCaptcha, args:[username,password]})
    → finds username field by /user/i regex on id/name/placeholder
    → sets value, dispatches input/change/blur (BLUR is critical — Angular waits for it before rendering captcha)
    → finds password field (skips hidden decoy by checking visibility/bounding box)
    → polls 6 captcha selectors for up to 8s, waits for img.complete && naturalWidth>0
    → draws to canvas, returns canvas.toDataURL('image/png')
  → returns { ok:true, type:'needsCaptcha', sessionId, captchaImage }

[Web app] callbacks.onCaptcha(captchaImage) → CaptchaLoginModal shows image
  → user types captcha, clicks "Sign in + fetch"
  → sendToExtension({type:submitLoginCaptcha, sessionId, captcha})

[Extension] submitLoginCaptcha
  → executeScript fillCaptchaAndSubmit
  → sleep(3500)
  → if URL matches /\/auth\/(fowelcome|dashboard)/ → popupAndFetch2b(session.tabId, period) ← reuse the LOGIN tab as opener
  → else if checkForOtpField → return needsOtp
  → else → refreshCaptchaAndCapture → return needsCaptcha (retry)
```

The login tab itself becomes the opener for the popup dance. After
fetch completes, the extension closes both the login tab and the
popup tab.

## v0.7.5 popup-detection fix (the key recent change)

### Bug history

- **v0.7.0–v0.7.1**: `chrome.tabs.create({url: gstr2bSummary})` from SW → WAF bounce → `/accessdenied`.
- **v0.7.2**: Tried using a return.gst.gov.in tab to fetch gstr2b → cross-origin "Failed to fetch".
- **v0.7.3**: Added `findOrCreateTabOnOrigin`, opened return.dashboard then redirected → still WAF bounce.
- **v0.7.4**: Switched to `executeScript(window.open)` from logged-in services tab — **WAF dance worked** — but `chrome.tabs.onCreated` listener never resolved because Chrome doesn't always set `openerTabId` when `window.open` fires from `executeScript` (MAIN world). 8 s timeout → `POPUP_OPEN_FAILED`. The popup tab was actually open at the right URL, but our detector missed it.
- **v0.7.5**: Race two strategies. Whichever finds the popup first wins.
- **v0.7.6**: Hide the popup via `chrome.tabs.update({active:false})` immediately after detection. Hide the cold-path login tab via `chrome.tabs.create({active:false})`. User only ever sees the FillGST modal.

### v0.7.5+ popupAndFetch2b detection logic

Located at [`src/background.ts:365-435`](../src/background.ts#L365):

```typescript
// Snapshot existing tab IDs so we ignore them when looking for the popup.
const beforeIds = new Set<number>();
const allTabs = await chrome.tabs.query({});
for (const t of allTabs) { if (t.id != null) beforeIds.add(t.id); }

// Strategy A: chrome.tabs.onCreated event listener — fastest if openerTabId IS set.
let createdHandler;
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

// Strategy B: poll chrome.tabs.query every 300ms for 12s.
const pollPromise = (async () => {
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

// Trigger window.open from inside the logged-in services tab.
await chrome.scripting.executeScript({
  target: { tabId: openerTabId },
  func: (u: string) => { window.open(u, "_blank"); },
  args: [targetUrl],
});

// Whichever strategy resolves first wins.
try {
  popupTabId = await Promise.race([eventPromise, pollPromise]);
} finally {
  if (createdHandler) chrome.tabs.onCreated.removeListener(createdHandler);
}

// v0.7.6: hide popup immediately after detection.
await chrome.tabs.update(popupTabId, { active: false }).catch(() => {});
```

**Don't simplify this** — both detection strategies are needed.
The event listener catches the popup instantly when `openerTabId` IS
set (some Chrome versions do set it). The poll catches it when
`openerTabId` is missing, which is the actual failure mode v0.7.5
fixes.

## Invariants (do not violate, ever)

1. **Popup MUST be opened via `window.open` from inside an executeScript
   running in a logged-in `*.gst.gov.in` tab.** Not from the SW. Not via
   `chrome.tabs.create`. Not via any other API. Period.
2. **Sleep 5 seconds after the popup loads, before the same-origin fetch.**
   This is the WAF JS challenge window. Cutting this short causes 403s.
3. **The fetch URL is `/gstr2b/auth/api/gstr2b/getjson?rtnprd=MMYYYY`.**
   `rtnprd` has NO underscore. The leading `0` for months 1-9 IS
   required (e.g. `072025`, not `72025`).
4. **The opener tab must be on `services.gst.gov.in`** (any subpath
   under `/services/`). Not `return.gst.gov.in`, not `gstr2b.gst.gov.in`.
   The AuthToken cookie scope rules require this.
5. **Username field needs a `blur` event after value-set.** GST portal's
   Angular controller waits for blur before fetching the captcha image.
   If we omit it, captcha never loads.
6. **Captcha img must be polled for `complete && naturalWidth > 0`** before
   canvas-encoding. The portal swaps src ~2-3s after username blur;
   reading too early gets a 0×0 image.
7. **Canvas-encoding the captcha is same-origin** (services.gst.gov.in)
   so toDataURL() works. If GSTN ever serves the captcha cross-origin,
   the canvas is tainted and we'd need a different approach (img.outerHTML?).
8. **Web app and extension `messages.ts` must stay in sync.** The webapp
   has its own copy at `src/lib/portal/extension-bridge.ts`. Both define
   the same ToExtension/FromExtension union types.

## Production endpoints / IDs

- **Extension ID**: `cbkmghnncpgkoedbppgimdidbkffnbij` (deterministic from manifest.json `key` field; stable)
- **Update URL**: `https://fillgst.com/api/extension/updates.xml`
- **CRX hosting**: `https://fillgst.com/extension/fillgst-helper.crx` + `fillgst-helper.zip`
- **Public key**: in `manifest.json` `key` field (don't change without rotating extension ID)
- **Signing key**: `.keys/extension.pem` in fillgst-extension repo (stays put — never rotate; ID is derived from it)

## Verification commands (re-run end-to-end if anything changes)

### Prerequisites

- Extension loaded as unpacked at the local `dist/` directory
- FillGST webapp running on `http://localhost:3000` (or production)
- Test GSTIN `07AACCR1712R1Z5` (R M R MARMO PRIVATE LIMITED) has saved creds in DB

### Cold-path test (definitive)

1. Close all Chrome windows.
2. Open Chrome, navigate to
   `http://localhost:3000/clients/07AACCR1712R1Z5/returns/gstr2b/092025`.
3. Click "Fetch without OTP".
4. Captcha modal should appear within 5-7 s with a captcha image visible.
5. Solve, click "Sign in + fetch".
6. Within 15-20 s, modal closes and page shows
   `fetched <today> · Fetched 19 rows · schema V4.`
7. Numbers should match: ₹47,86,398.76 taxable, ₹4,30,389.29 CGST,
   ₹4,30,389.29 SGST.

### Warm-path test (faster validation)

After cold path succeeds, immediately re-trigger fetch on a different
period (e.g. `072025`) — should skip captcha entirely and complete in
~12 s.

### If WAF dance breaks (popup goes to /accessdenied)

1. **First check**: is the GSTIN's account flagged? Open
   `services.gst.gov.in/services/login` manually in a regular Chrome tab,
   log in. If you see Aadhaar/e-KYC nag screens, the account itself is
   flagged — no automation can bypass that.
2. **Second check**: too many automation attempts in last hour? GSTN does
   short-term IP throttling. Wait 30 minutes.
3. **Third check**: did `window.open` actually fire from the logged-in
   tab? In SW console: look for `[FillGST Helper] message from ...` log.
   Then in the services tab's console (DevTools), set a breakpoint on
   `window.open` to confirm.
4. **Fourth check**: is the 5 s sleep still there? Reducing it to <3 s
   causes 403s on the same-origin fetch.

### If captcha image doesn't load

- Username field's blur event missing → check
  `fillCredsAndCaptureCaptcha` is dispatching `blur`.
- Captcha selector list outdated → the GST portal occasionally tweaks
  the captcha img class. Add new selectors to the array; don't delete
  old ones (we keep all 6).

## Memory of what we tried and rejected

- **Headless Playwright in extension** — impossible. Chrome extensions
  can't run Playwright.
- **Server-side Playwright (FillGST cloud)** — works but: (a) creds leave
  user's PC, (b) /accessdenied risk because Cloud Run IPs are flagged,
  (c) GSP costs ₹2.50/call. Kept around as the "With OTP" fallback path
  (which uses Whitebooks GSP, not Playwright).
- **chrome.tabs.create with openerTabId** — WAF bounces it. The
  opener-id field isn't enough; the WAF cares about whether
  `window.open` was actually invoked.
- **Reusing an existing gstr2b tab via chrome.tabs.update** — same
  problem; URL change without page-side window.open is detected.
- **Single-strategy `chrome.tabs.onCreated` listener (v0.7.4)** —
  silently misses the popup when Chrome doesn't set openerTabId on
  window.open from MAIN-world executeScript. v0.7.5's race fixes this.
- **Removing the 5 s post-load sleep** — fetch returns 403 because WAF
  JS challenge hasn't completed.

## Sister project pointer

The full Playwright-based reference implementation lives in the
`fillgst-helper-node` repo at `src/portal-runner.ts` lines 470-572.
If the extension flow ever needs to be debugged or re-derived, that's
the original ground-truth implementation. Same window.open dance,
same 5 s sleep, same fetch URL — just running in Playwright instead
of chrome.scripting.

## How to apply

When a user reports "fetch is broken" or "captcha modal not appearing"
or `POPUP_OPEN_FAILED` or `WAF_ACCESSDENIED`:

1. Read this file end-to-end.
2. Check extension version via popup ping — should be ≥ 0.7.5.
3. Run the cold-path test above.
4. Compare against the **Invariants** section — find which one was
   violated.
5. Restore that invariant. Don't refactor the WAF dance code without
   understanding why each line is there.
