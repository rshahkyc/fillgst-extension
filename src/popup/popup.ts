/**
 * Popup — shows extension status and active GST portal session info.
 */

const statusEl = document.getElementById("status");
const versionEl = document.getElementById("version");

async function init() {
  const manifest = chrome.runtime.getManifest();
  if (versionEl) versionEl.textContent = `v${manifest.version}`;

  // Check if there are GST portal cookies
  const cookies = await chrome.cookies.getAll({ domain: ".gst.gov.in" });
  const sessionCookie = cookies.find(
    (c) => /sess/i.test(c.name) || /JSESSIONID/i.test(c.name) || /authToken/i.test(c.name),
  );

  if (!statusEl) return;
  if (sessionCookie) {
    statusEl.className = "status ok";
    statusEl.textContent = `Connected to GST Portal (${cookies.length} cookies)`;
  } else {
    statusEl.className = "status warn";
    statusEl.textContent = "Not signed into GST Portal yet — open FillGST and click Login.";
  }
}

void init();
