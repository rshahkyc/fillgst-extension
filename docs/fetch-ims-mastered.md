# GSTR-IMS without-OTP fetch — recovery guide

> **2026-05-10 status:** GSTR-IMS fetch via the Chrome extension works
> end-to-end for any new user without helper-node install.
> Frozen working state: git tag `v0.8.0` at commit `f237e7b`.
> Pairs with [`docs/fetch-2b-mastered.md`](./fetch-2b-mastered.md) — they
> share the same login state machine; only the post-login fetch step
> differs.

If the IMS fetch breaks, this is the canonical recovery checkpoint.
Mastered and verified end-to-end on **2026-05-10** with extension
v0.8.0 + webapp commit `f5c59c8` + helper-node commit `327296f`. Do
NOT refactor the post-login fetch logic without reading this end-to-end
first.

## TL;DR

A signed-in user on `fillgst.com` clicks **"Fetch IMS from portal"**.
The webapp tries three transports in order:

1. **fillgst-helper-node** (Playwright headless, zero Chrome windows) — power users
2. **fillgst-extension v0.8.0+** (this doc — captcha modal, one-click Chrome Web Store install) — new users
3. **Whitebooks GSP** (server-side, paid, OTP required) — last resort

The extension path: opens a minimized Chrome window, captures captcha,
user solves it in the FillGST modal, extension submits → on `/auth/
dashboard`, navigates the **same window cross-subdomain** to
`return.gst.gov.in/returns/auth/dashboard`, then runs **8 same-origin
fetches** for IMS sections (B2B / B2BA / B2BCN / B2BCNA / B2BDN /
B2BDNA / ECOM / ECOMA), assembles a GETINV envelope, returns it via
the `fetchImsResult` message. Webapp POSTs it to `/api/ims/upload` for
parse + persist.

## The single hardest insight (do not lose)

**IMS fetch is much simpler than 2B because there's NO WAF JS challenge
on `return.gst.gov.in`.** GSTR-2B's `gstr2b.gst.gov.in` subdomain has
the per-tab TS-cookie WAF that requires the popup `window.open` dance;
return.gst.gov.in just needs session cookies (which are scoped to
`.gst.gov.in` apex and transfer across subdomains).

So the IMS path can do the simplest thing: **navigate the same login
tab cross-subdomain via `window.location.href`**, then `fetch()` each
section URL with `credentials: "include"`. No popup, no race
detection, no WAF challenge wait.

## Architecture — shared with 2B

Both fetch flows use the same `LoginSession` map keyed by `sessionId`.
The session now carries a `kind: "2b" | "ims"` discriminator:

```typescript
interface LoginSession {
  tabId: number;
  windowId?: number;
  gstin: string;
  period: string;
  kind: "2b" | "ims";  // v0.8.0
  step: "captcha" | "otp" | "fetch" | "done";
}
```

When the user submits captcha (and optionally OTP), the same handler
funnels into `runPostLoginFetch(session)` which dispatches:

```typescript
async function runPostLoginFetch(session: LoginSession): Promise<FromExtension> {
  if (session.kind === "ims") {
    return fetchImsViaTab(session.tabId, session.gstin, session.period);
  }
  return popupAndFetch2b(session.tabId, session.period);
}
```

This means **all the captcha + OTP + URL polling + cookie propagation
fixes from v0.7.5–v0.7.9 apply equally to IMS**. If 2B's login flow
works, IMS's login flow works.

## End-to-end flow

```
[Web app] click "Fetch IMS from portal"
  → fetch-ims-from-portal-button.tsx :: fetchIms()
  → probeHelperForIms()                    // 1. helper-node (preferred)
  → probeExtensionWithVersion()            // 2. extension fallback
  → runLoginAndFetchImsViaExtension()      // ← THIS DOC

[runLoginAndFetchImsViaExtension]
  → POST /api/portal/helper/credentials    // server decrypts vaulted creds
  → sendToExtension({type:"loginAndFetchIms",sessionId,gstin,period,username,password})

[Extension :: loginAndFetchIms]
  → chrome.windows.create({state:"minimized"})
  → tab opens services.gst.gov.in/services/login
  → if URL is /auth/* (cookies still valid): navigate back to /services/login
  → executeScript(fillCredsAndCaptureCaptcha)
  → return needsCaptcha {captchaImage}

[Web app captcha modal] user types captcha
  → sendToExtension({type:"submitLoginCaptcha", sessionId, captcha})

[Extension :: submitLoginCaptcha]
  → executeScript(fillCaptchaAndSubmit)
  → waitForUrlMatch(/auth/(fowelcome|dashboard)/, 15s)
  → sleep(4000)                           // cross-subdomain cookie propagation
  → runPostLoginFetch(session)            // session.kind === "ims" → fetchImsViaTab
  → close minimized window
  → return fetchImsResult

[Extension :: fetchImsViaTab]
  → executeScript(window.location.href = "https://return.gst.gov.in/returns/auth/dashboard")
  → waitForTabLoad(25s)
  → sleep(2000)                            // SPA bootstrap
  → guard: URL contains "return.gst.gov.in" + not "/accessdenied"
  → executeScript(sameOriginFetchImsSections)
  → return {envelope, rowCount, fetchedSections}

[Extension :: sameOriginFetchImsSections]
  → fetch("/imsweb/auth/api/ims/getCount?goods_typ=ALL_OTH")  // get section counts
  → for each non-empty section in [B2B, B2BA, B2BCN, B2BCNA, B2BDN, B2BDNA, ECOM, ECOMA]:
     → fetch("/imsweb/auth/api/ims/getInvoices?gstin=...&section=" + UPPER)
     → assemble envelope[lower] = data[lower] array
  → return {envelope: {gstin, rtnprd, b2b: [...], b2ba: [...], ...}, rowCount, fetchedSections}

[Web app] receives fetchImsResult
  → POST /api/ims/upload {gstinId, finYear, envelope}
  → server parses envelope (parseImsEnvelope) + persists (ImsInwardSnapshot + ImsInwardRow)
  → returns {snapshotId, rowCount, alreadyExisted}
  → router.refresh() → page renders new snapshot
```

Total time: ~25–35s (most spent on captcha solve + the 8 fetches).

## GSTN response shapes (verified live 2026-05-10)

These are NOT what the documentation says — verified against the real
portal because the docs were inaccurate.

### `getCount?goods_typ=ALL_OTH`

```json
{
  "data": {
    "tradenm": "...",
    "legalnm": "...",
    "gstin": "07AABFL2260Q2Z2",
    "all_oth": {
      "b2b":   { "accept": 90, "noaction": 207, "pending": 0, "reject": 0 },
      "b2ba":  { "accept": 0,  "noaction": 1,   "pending": 0, "reject": 0 },
      "b2bcn": { "accept": 3,  "noaction": 5,   "pending": 0, "reject": 0 },
      "b2bcna":{ ... }, "b2bdn": { ... }, "b2bdna": { ... },
      "ecom":  { ... }, "ecoma": { ... },
      "ttl_cnt": 306
    },
    "imp_gds": { ... },
    "inv_supp_isd": { ... }
  },
  "status": "..."
}
```

**Section keys are LOWERCASE** in the count response. Total per section
= sum of `accept + noaction + pending + reject`. `ttl_cnt` is the grand
total across sections within that goods_typ. We only fetch `ALL_OTH`
because regular B2B traders don't use ISD or imports here.

### `getInvoices?gstin=<G>&section=<UPPER>`

```json
{
  "data": {
    "b2b": [
      { "stin": "...", "tradenm": "...", "ispendactblocked": false,
        "rtnprd": "112025", "srcform": "...", "inum": "...", "idt": "01-11-2025",
        "inv_typ": "R", "pos": "07", "srcfilstatus": "F", "val": 247800,
        "txval": 210000, "iamt": 0, "camt": 18900, "samt": 18900, "cess": 0,
        "action": "N", "hash": "...", "isItcRedReqBlocked": false,
        "isRemarksBlocked": false }
      // ... 296 more rows
    ]
  },
  "status": "..."
}
```

**Section param in URL is UPPERCASE** (`B2B`); response key is
**LOWERCASE** (`data.b2b`). Each invoice has GSTN's full IMS field
set including the four hidden flags (`ispendactblocked`, `isItcRedReqBlocked`,
`isRemarksBlocked`, `ItcAvailabilityCheck`).

### `/api/ims/upload` envelope

The webapp's IMS parser at `src/lib/ims/parser.ts` expects an envelope
with **lowercase section keys** matching the wire format:

```json
{
  "gstin": "07AABFL2260Q2Z2",
  "rtnprd": "112025",
  "b2b": [...],
  "b2ba": [...],
  "b2bcn": [...],
  "b2bcna": [...],
  "b2bdn": [...],
  "b2bdna": [...],
  "ecom": [...],
  "ecoma": [...]
}
```

Our envelope assembly mirrors this 1:1. Don't normalise to uppercase
keys before upload — the parser will silently miss them.

## Critical invariants (do not violate)

1. **Section name in URL = UPPERCASE.** `?section=B2B` works, `?section=b2b` returns empty.
2. **Section key in response + envelope = lowercase.** `data.b2b`, envelope `b2b`. The parser tolerates both wire forms but our assembly only writes one.
3. **Tax delta tolerance for "trivial match" auto-resolve doesn't apply here** — IMS has no delta concept. Just persist the snapshot.
4. **In-tab cross-subdomain navigation is fine for return.gst.gov.in.** Don't try to do a popup-WAF dance — gstr2b's WAF doesn't apply.
5. **Cookie propagation wait (4s after /auth/dashboard) still applies.** Without it, the first IMS fetch races GSTN's auth handshake.
6. **8 sections, fetched serially in-page.** Could be parallel via `Promise.all` but serial is simpler + more bandwidth-friendly. Don't optimise without testing.
7. **Skip sections where count is 0.** Saves 5–7 round-trips for typical filers.
8. **Fiscal year is required by `/api/ims/upload`.** Pass it from the page (`finYear` prop).

## Frozen working state

Restore from these tags if anything regresses:

| Repo | Tag | Commit | What it pins |
|---|---|---|---|
| `fillgst-extension` | `v0.8.0` | `f237e7b` | IMS fetch via extension (this doc) + 2B (v0.7.9 baseline) |
| `fillgst` (webapp) | `fetch-ims-extension-v1` | `f5c59c8` | IMS button: helper → extension → GSP fallback chain |
| `fillgst-helper-node` | `pna-cors-v1` | `327296f` | PNA + CORS so fillgst.com → localhost:9876 works in Chrome 130+ |

Restore example:
```bash
cd fillgst-extension
git checkout v0.8.0
npm run build:crx
# dist/ now matches the verified-working state
```

## Verification commands

### Cold-path test

1. Stop helper-node (so the extension path runs).
2. Reload the FillGST Helper extension at `chrome://extensions`.
3. On `fillgst.com/clients/<gstin>/ims/<period>` click "Fetch IMS from portal".
4. Captcha modal appears within 5–7 s with a clear captcha image.
5. Solve, click "Sign in + fetch".
6. Within 25–35 s, modal closes; page shows the fetched snapshot
   with the section breakdown table.

### Direct API smoke test

From DevTools console on a logged-in fillgst.com page:
```javascript
const resp = await new Promise((resolve) =>
  chrome.runtime.sendMessage('cbkmghnncpgkoedbppgimdidbkffnbij',
    { type: 'ping' }, resolve));
console.log(resp.version);  // should be 0.8.0+
```

### Failure-mode triage

| Error | Likely cause | Fix |
|---|---|---|
| `IMS_NAV_FAILED` | Could not run executeScript on login tab | Tab closed mid-flight; reload extension |
| `IMS_NAV_TIMEOUT` | return.gst.gov.in didn't load within 25 s | Network slow or GSTN down; retry |
| `WAF_ACCESSDENIED` | GSTN bounced returns dashboard | Account flagged (Aadhaar/e-KYC pending) — manual login first |
| `IMS_UNEXPECTED_URL` | Page redirected somewhere unexpected | Inspect `finalUrl` in error message; might be a portal-side change |
| `IMS_FETCH_FAILED` (`firstError` shown) | A specific section returned non-200 | Parse the firstError field to see which section + status |
| `IMS_EMPTY` | All 8 sections returned 0 rows | Genuinely empty IMS (no inward invoices), OR session was invalid → check via manual portal login |

## What we tried and rejected

- **Popup-WAF dance for IMS** — overkill, return.gst.gov.in has no WAF JS challenge. Adds complexity and a popup tab the user could close.
- **Parallel fetches via `Promise.all`** — works but harder to attribute errors. Serial is cleaner; total time delta is small (3–5 s).
- **Pre-filter sections via the count call's `accept+noaction+pending+reject` sum** — kept this; saves 5–7 round-trips.
- **`chrome.tabs.update` to navigate cross-subdomain** — Chrome rejected with cross-origin issues. `executeScript(window.location.href = ...)` runs in MAIN world and works.
- **Single `/api/ims/fetch` server-side endpoint** — won't work because helper-node lives on user's PC, not Cloud Run; the extension is browser-side. Both must orchestrate from the browser.

## How to apply this knowledge

When a user reports IMS fetch broken:

1. Check extension version: should be ≥ 0.8.0
2. Check browser version: ≥ Chrome 130 needs PNA-allow header (see helper-node `server.ts`)
3. Run the smoke test above
4. If captcha modal appears but post-submit fails → debug `fetchImsViaTab` + check tab URL after navigation
5. If captcha doesn't load → fall through to the same triage as 2B (see `fetch-2b-mastered.md`)
6. If all else fails, restore from tag `v0.8.0`.
