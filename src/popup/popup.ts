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
    statusEl.textContent = `Ready · GST portal session live (${cookies.length} cookies). Pick "Browser session (no OTP)" in FillGST to fetch for free.`;
  } else {
    statusEl.className = "status warn";
    statusEl.textContent =
      "Not signed into GST Portal yet — log into services.gst.gov.in in another tab, then click Fetch in FillGST.";
  }
}

void init();
