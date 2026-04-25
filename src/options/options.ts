/**
 * Options page — lets the user configure the FillGST server URL.
 * Stored in chrome.storage.local.
 */

const input = document.getElementById("serverUrl") as HTMLInputElement | null;
const saveBtn = document.getElementById("save");
const savedMsg = document.getElementById("saved");

async function load() {
  if (!input) return;
  const data = await chrome.storage.local.get("serverUrl");
  input.value = (data.serverUrl as string) ?? "http://192.168.1.24:3000";
}

async function save() {
  if (!input) return;
  const value = input.value.trim();
  await chrome.storage.local.set({ serverUrl: value });
  if (savedMsg) {
    savedMsg.style.display = "inline";
    setTimeout(() => {
      savedMsg.style.display = "none";
    }, 2000);
  }
}

saveBtn?.addEventListener("click", () => void save());
void load();
