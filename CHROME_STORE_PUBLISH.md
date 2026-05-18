# Publishing FillGST Helper to the Chrome Web Store

A practical, ready-to-execute checklist for shipping `fillgst-extension`
to the Chrome Web Store. Reflects the manifest as of 2026-05-18.

> **What this gets you**: a one-click install link CAs can paste into
> their browser, instead of "download crx → enable developer mode →
> drag into chrome://extensions". Roughly 90% of users won't install
> a sideloaded extension; Web Store distribution unblocks adoption.

---

## 0. One-time prerequisites

| | Status |
|---|---|
| Chrome Web Store **developer account** (US$5 one-time registration) | □ done · open <https://chrome.google.com/webstore/devconsole> with `rshahkyc@gmail.com` (the FillGST owner email) |
| Privacy policy URL — must be live + linkable | □ Use <https://fillgst.com/privacy> (already exists in repo) |
| 2-step verification on the developer Google account | □ |

If you've never published a Chrome extension before, expect Google to ask for
a "Why are you publishing to Chrome Web Store?" justification and an
identity verification step. Allow ~24 h for that to clear.

---

## 1. What's in the repo (ready to upload)

```
fillgst-extension/
├── manifest.json              ← keeps update_url for self-hosted .crx
├── manifest.webstore.json     ← clean Web-Store variant (use THIS for upload)
├── icons/
│   ├── icon-16.png            ← FillGST mark @ 16²
│   ├── icon-32.png            ← FillGST mark @ 32²
│   ├── icon-48.png            ← FillGST mark @ 48²
│   └── icon-128.png           ← FillGST mark @ 128² (Web Store listing thumbnail)
├── dist/                      ← built bundle ready to zip
└── CHROME_STORE_PUBLISH.md    ← this file
```

The difference between `manifest.json` and `manifest.webstore.json`:

- `manifest.json` keeps `update_url`, `key`, and dev URLs (`localhost`,
  `*.vercel.app`, `*.run.app`) — used by the self-hosted .crx flow we
  already support at `https://fillgst.com/api/extension/updates.xml`.
- `manifest.webstore.json` drops `update_url` (Web Store auto-updates),
  drops `key` (Web Store assigns its own), and trims dev URLs from
  `content_scripts.matches`, `externally_connectable.matches`, and
  `host_permissions` — so the review team doesn't have to ask "why
  does this extension run on localhost".

---

## 2. Build the production bundle

```sh
cd fillgst-extension

# Use the Web-Store variant during build
cp manifest.webstore.json manifest.json.bak.during-build  # safety
cp manifest.webstore.json manifest.json

npm install
npm run build

# Restore the self-hosted manifest so dev continues unaffected
mv manifest.json.bak.during-build manifest.json
```

Confirm:

- `dist/manifest.json` exists
- `dist/icons/icon-{16,32,48,128}.png` exist
- `dist/src/background.js`, `dist/src/popup/popup.html`, etc. exist
- Open `dist/manifest.json` and verify NO `update_url`, NO `key`, NO
  `localhost`/`vercel.app`/`run.app` entries.

Zip the bundle:

```sh
cd dist && zip -r ../fillgst-helper-webstore-v0.9.3.zip . && cd ..
```

That zip is what you upload.

---

## 3. Store listing assets — to produce manually

The Web Store dashboard asks for:

| Asset | Spec | Where to get it |
|---|---|---|
| **Store icon** | 128×128 PNG, < 1 MB | `icons/icon-128.png` (already in repo) |
| **Small promo tile** | 440×280 PNG/JPG | Render from `design/homepage-2026-prototype.html` Hero (crop product card) |
| **Marquee promo tile** *(optional, raises ranking)* | 1400×560 PNG/JPG | Render full Hero w/ headline + product card |
| **Screenshot 1** | 1280×800 PNG | FillGST `/clients/{gstin}/returns/gstr3b/{period}` — the live GSTR-3B viewer with the new per-row source picker (just shipped) |
| **Screenshot 2** | 1280×800 PNG | Reconciliation tabs `/clients/{gstin}/reconcile/{period}` — Summary / Partywise / Recordwise view |
| **Screenshot 3** | 1280×800 PNG | The Chrome extension popup itself, showing "Sign in to GST" / "Fetch 2B" buttons |
| **Screenshot 4** | 1280×800 PNG | Books-vs-2B reconciliation row drill-down |
| **Screenshot 5** *(optional)* | 1280×800 PNG | DSC signing dialog with EVC/PFX/USB options |

> Minimum required: **1 screenshot + 1 store icon**. Five screenshots
> noticeably improves conversion, especially for a B2B tool where the
> install decision is made by a CA who needs to see the UI.

---

## 4. Store listing copy (paste into the dashboard)

### Title
```
FillGST Helper
```

### Short description (≤ 132 characters)
```
Connect FillGST to the GST portal + your local TallyPrime. No OTP marathons. Books and credentials stay on your PC.
```

### Detailed description (~16,000-char limit; this draft ~800)
```
FillGST Helper is the companion extension for fillgst.com — a GST compliance suite built by practising CAs in Mumbai.

The extension lives quietly in your Chrome browser and handles two jobs:

1. FETCH FROM THE GST PORTAL — when you click "Fetch 2B" or "Sync filing status" in FillGST, the extension uses your own logged-in GST portal session to pull the data directly. No OTP after the first sign-in. No automation fingerprint (it's your real Chrome session). No credentials ever leave your PC.

2. CONNECT TO LOCAL TALLY — when FillGST asks for fresh books, the extension relays to TallyPrime running on the same PC (via the FillGST helper service at localhost:9876). Your books data is read directly into FillGST without uploading anything to a third-party server.

WHAT THIS REPLACES
• OTP juggling every time you log in to gst.gov.in
• Manually downloading GSTR-2B from the portal and re-uploading to your filing software
• ClearTax / CompuGST / Marg with their stored credentials and cloud round-trips

PRIVACY MODEL
• GSTN username, password, OTP, DSC private key — NEVER leave your computer.
• 2B / IMS / e-invoice data fetched via cookies on YOUR Chrome session.
• Books data read directly from local TallyPrime — no cloud relay.
• See https://fillgst.com/privacy for the full policy.

WHO IT'S FOR
• CA firms managing multi-GSTIN clients
• Corporate tax teams with in-house compliance
• Solo CAs and individual filers

REQUIRES
• A fillgst.com account (free tier: 1 GSTIN, 5 returns/month forever)
• Chrome 111 or newer
• For Tally integration: TallyPrime running locally + the FillGST helper service

OPEN-SOURCE TRANSPARENCY
The extension source is published at github.com/rshahkyc/fillgst — every line that runs in your browser is auditable.

QUESTIONS?
hello@fillgst.com — a CA replies, not a bot.
```

### Category
```
Productivity
```

### Language
```
English (United States) — primary
Hindi — secondary (optional, raises India SEO)
```

### Single-purpose statement (Web Store requires this since 2024)
> "Single purpose: act as the local bridge between fillgst.com and the
> user's GST portal session + local TallyPrime, so the user can prepare
> and file GST returns without manually downloading/uploading data."

### Permissions justifications

For each permission in `manifest.webstore.json`, paste this justification
in the corresponding box on the Web Store form:

| Permission | Justification (copy-paste) |
|---|---|
| `cookies` | Used to read the GST portal session cookies from the user's own logged-in tab, so we can fetch GSTR-2B / IMS / filing status data on their behalf. Never sent to a third party. |
| `storage` | Persist the user's per-extension settings (which fillgst.com origin to talk to, opt-in flags) across browser restarts. |
| `scripting` | Inject a small bridge into fillgst.com tabs (window.postMessage relay between the page and the extension's service worker). No external code execution. |
| `tabs` | Find the user's existing GST portal tab (or open one) to run portal fetches inside their own session. |
| `host_permissions: *.gst.gov.in` | The GST portal — where we fetch 2B / IMS / filing status using the user's already-authenticated session. |
| `host_permissions: localhost:9876` | The FillGST helper service running on the user's own machine (handles TallyPrime / DSC signing locally). Optional — extension still works without it. |
| `externally_connectable: fillgst.com` | Allows fillgst.com pages to send `chrome.runtime.sendMessage` to the extension (the user-initiated "Fetch 2B" trigger). |

### Privacy policy URL
```
https://fillgst.com/privacy
```

### Homepage URL
```
https://fillgst.com
```

### Support URL
```
mailto:hello@fillgst.com
```

---

## 5. Submission flow (~10 min in the dashboard, then 1-3 days review)

1. Open <https://chrome.google.com/webstore/devconsole>
2. Click **New Item** → upload `fillgst-helper-webstore-v0.9.3.zip`
3. Fill in **Store listing** (paste copy from §4 above)
4. Upload screenshots from §3 (drag-drop)
5. **Privacy practices** tab — declare:
   - Single purpose: as in §4
   - Data the extension handles: "User browsing activity within gst.gov.in only, to fetch return data the user owns"
   - Confirm it does NOT sell/transfer user data
6. **Distribution** tab — start with **Unlisted** (you control who installs)
   - Unlisted means anyone with the link can install, but it doesn't appear in store search
   - Switch to **Public** once you've validated on 5-10 real users
7. Click **Submit for review**
8. Wait 1-3 business days. Google emails approval/rejection.

If rejected, the email tells you why. Most common rejections for an
extension like this:

- **"Permissions too broad"** → already trimmed in `manifest.webstore.json`
- **"Single purpose unclear"** → make the statement in §4 more
  explicit ("the extension does one thing: bridge fillgst.com to the
  user's GST portal session + local Tally")
- **"No privacy policy"** → ensure `/privacy` is live and lists the
  three permission justifications verbatim

---

## 6. After approval

Once Approved + Published:

1. The install URL is `https://chromewebstore.google.com/detail/<ID>` —
   put it on `https://fillgst.com/install` (already exists in repo).
2. Update the onboarding flow so the "Install our extension" CTA goes
   to the Web Store URL instead of the .crx download.
3. Drop `update_url` from the runtime `manifest.json` for future
   builds — once on the store, auto-update is handled there.
4. Tag the released version in git:
   ```sh
   git tag webstore-v0.9.3 && git push --tags
   ```

---

## 7. Self-hosted .crx path stays available

The Web Store flow is *additive* — the existing self-hosted .crx at
`https://fillgst.com/api/extension/updates.xml` still works for
internal / enterprise users who don't want a Web Store dependency.

Use **Unlisted** Web Store distribution + the .crx flow side-by-side:
public CAs get the Web Store link; enterprise CAs who don't trust
external stores keep the .crx.

---

## 8. Anything blocking publication right now?

| Blocker | Status |
|---|---|
| Icons exist | ✅ generated 2026-05-18 in `icons/` |
| Web-Store-clean manifest | ✅ `manifest.webstore.json` |
| Production build | ⏳ run `npm run build` after copying manifest variant |
| Screenshots | ⏳ produce from live fillgst.com (5 recommended) |
| Privacy policy live | ✅ `/privacy` exists; verify it covers the 3 permissions above |
| Developer account | ⏳ $5 fee + 2FA enable on `rshahkyc@gmail.com` |
| Store listing copy | ✅ in this doc |

Everything except screenshots + the dev account fee is in the repo
ready to go.
