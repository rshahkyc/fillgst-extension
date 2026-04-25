# FillGST Helper (Chrome Extension)

Lets the FillGST web app talk to the GST portal directly from your local Chrome browser — no OTP needed after the first login, and no automation fingerprint.

## How it works

The extension lives in your Chrome browser. When you click "Connect" or "Fetch 2B" in FillGST:

1. The web page sends a message to this extension via `chrome.runtime.sendMessage`.
2. The extension opens a real GST portal tab in your Chrome (or re-uses an existing one).
3. You sign in once with captcha + OTP — your normal browser flow.
4. Chrome saves the cookies. Future fetches use those cookies silently for ~30 days.
5. 2B JSON is fetched via a same-origin call from inside the GST portal tab, then sent back to FillGST and saved to the database.

Because the extension uses your real Chrome browser, there is no Playwright/Puppeteer fingerprint — the GST portal cannot tell you're using automation.

## Build the extension

```sh
cd fillgst-extension
npm install
npm run build
```

Output is in `dist/`.

## Install in Chrome (one-time per user PC)

1. Open Chrome
2. Go to `chrome://extensions`
3. Toggle **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the `dist/` folder
6. Click the puzzle-piece icon in Chrome's toolbar → pin **FillGST Helper** for easy access

That's it — the extension is now installed.

## Configure the server URL

After install:

1. Right-click the FillGST Helper icon → **Options**
2. Enter the FillGST server URL (default: `http://192.168.1.24:3000`)
3. Click **Save**

This tells the extension which web origins are allowed to talk to it.

## First-time login (per GSTIN)

In FillGST:

1. Open a client → GSTR-2B page
2. Click the **Chrome Extension (No OTP)** tab
3. Click **Connect to GST Portal**
4. A new tab opens to gst.gov.in — sign in with username + password + captcha
5. If the portal asks for OTP (first time on this device), enter it
6. Once you reach the dashboard, the extension detects it automatically
7. Return to the FillGST tab → status will show "Connected ✓"

## Subsequent fetches

After the first login:

1. Click **Fetch GSTR-2B** in the FillGST tab
2. Extension uses the saved cookies — no captcha, no OTP
3. JSON arrives in ~2 seconds and is saved to FillGST

Cookies stay valid for ~30 days. After that, one re-login per GSTIN.

## Multi-user

Each user installs the extension on their own PC. Each PC's Chrome has its own cookie store, so different users can be logged into different clients simultaneously — no conflict.

## Permissions explained

| Permission | Why |
|---|---|
| `cookies` | Read GST portal cookies to verify login state and pass them to the same-origin fetch |
| `storage` | Save the FillGST server URL setting |
| `scripting` | Inject the 2B fetch function into the gstr2b.gst.gov.in tab |
| `tabs` | Open and track the GST portal login tab |
| `host_permissions: *.gst.gov.in` | Required for cookies + scripting on portal subdomains |
| `externally_connectable: 192.168.*.*` | Allow only LAN-hosted FillGST instances to send messages — no public website can talk to this extension |

## Updating

When the FillGST team releases a new extension version:

1. Pull the latest code or download the new `dist.zip`
2. Open `chrome://extensions`
3. Click the refresh icon on the FillGST Helper card
