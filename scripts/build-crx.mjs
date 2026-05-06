/**
 * Build a signed CRX3 from the dist/ folder + .keys/extension.pem.
 *
 * Output: dist/fillgst-helper.crx
 *
 * Sequence:
 *   1. Read manifest.json from dist/ to get the version.
 *   2. Sign the dist/ contents with the PEM private key.
 *   3. Write the CRX3 to dist/fillgst-helper.crx (and dist/fillgst-helper-<version>.crx).
 *   4. Compute SHA256 of the binary and write dist/crx-meta.json
 *      so the FillGST app can serve it from /api/extension/updates.xml
 *      with the right hash + version.
 *
 * Run: `node scripts/build-crx.mjs`. Requires `npm run build` to have
 * produced dist/ first; package.json's `build:crx` script chains them.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, rm, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import crx3 from "crx3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const distDir = join(root, "dist");
const keyPath = join(root, ".keys", "extension.pem");
const outDir = distDir;

async function listFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listFiles(full, base)));
    } else if (e.isFile()) {
      // Skip our own outputs from prior runs.
      if (full.endsWith(".crx") || full.endsWith("crx-meta.json")) continue;
      out.push(full);
    }
  }
  return out;
}

async function main() {
  if (!existsSync(distDir)) {
    console.error("dist/ not found — run `npm run build` first.");
    process.exit(1);
  }
  if (!existsSync(keyPath)) {
    console.error(
      `.keys/extension.pem not found at ${keyPath}. The signing key is required to build a CRX.`,
    );
    process.exit(1);
  }

  const manifest = JSON.parse(await readFile(join(distDir, "manifest.json"), "utf8"));
  const version = manifest.version;

  // Build a list of files to bundle.
  const files = await listFiles(distDir);
  console.log(`Signing ${files.length} files for v${version}…`);

  const crxPath = join(outDir, "fillgst-helper.crx");
  const versionedPath = join(outDir, `fillgst-helper-${version}.crx`);

  // Remove stale .crx so the writer doesn't read its own output.
  if (existsSync(crxPath)) await rm(crxPath);
  if (existsSync(versionedPath)) await rm(versionedPath);

  await crx3(files, {
    keyPath,
    crxPath,
    zipPath: join(outDir, "fillgst-helper.zip"),
  });

  // Make a versioned copy too, useful for archives.
  await copyFile(crxPath, versionedPath);

  const crxBytes = await readFile(crxPath);
  const sha256 = createHash("sha256").update(crxBytes).digest("hex");
  const stats = await stat(crxPath);

  const meta = {
    version,
    crx: "fillgst-helper.crx",
    crxVersioned: `fillgst-helper-${version}.crx`,
    sizeBytes: stats.size,
    sha256,
    builtAt: new Date().toISOString(),
  };
  await writeFile(join(outDir, "crx-meta.json"), JSON.stringify(meta, null, 2) + "\n");

  console.log(`✓ Wrote ${crxPath} (${(stats.size / 1024).toFixed(1)} KB · sha256 ${sha256.slice(0, 12)}…)`);
  console.log(`  Versioned copy: ${versionedPath}`);
  console.log(`  Meta: dist/crx-meta.json`);

  // Copy into FillGST's public folder for serving via /api/extension/updates.xml.
  // OneDrive\Documents\GitHub\fillgst\public\extension is the canonical
  // location per the project plan; the env override and the absolute home
  // path take precedence over relative-walk candidates because Windows
  // is case-insensitive and the relative walks would otherwise match
  // unrelated FILLGST / FILLGSTV1 v0-prototype folders next to this one.
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const candidates = [
    // Explicit override.
    process.env.FILLGST_REPO_PATH
      ? resolve(process.env.FILLGST_REPO_PATH, "public", "extension")
      : null,
    // Canonical user-home path on the dev machine.
    home ? resolve(home, "OneDrive", "Documents", "GitHub", "fillgst", "public", "extension") : null,
    // From OneDrive\Desktop\claude code\fillgst-extension → ~\Documents\GitHub\fillgst (no OneDrive)
    resolve(root, "..", "..", "..", "..", "Documents", "GitHub", "fillgst", "public", "extension"),
    // Sibling layout (rare): claude code/fillgst-extension → claude code/fillgst
    resolve(root, "..", "fillgst", "public", "extension"),
    // Same-parent layout: <parent>/fillgst
    resolve(root, "..", "..", "fillgst", "public", "extension"),
  ].filter((p) => typeof p === "string");

  // Three artifacts are served from FillGST's /extension/ folder:
  //   - fillgst-helper.crx        → consumed by Chrome's auto-update channel (update_url)
  //   - fillgst-helper.zip        → user-initiated download from /install/extension
  //                                  (Chrome silently deletes user-clicked .crx files
  //                                  from non-Web-Store origins, so we serve the zip)
  //   - crx-meta.json             → version + sha256 for the updates.xml endpoint
  const zipPath = join(outDir, "fillgst-helper.zip");
  let copied = false;
  for (const fillgstPublic of candidates) {
    const fillgstRoot = resolve(fillgstPublic, "..", "..");
    if (existsSync(join(fillgstRoot, "package.json"))) {
      await mkdir(fillgstPublic, { recursive: true });
      await copyFile(crxPath, join(fillgstPublic, "fillgst-helper.crx"));
      if (existsSync(zipPath)) {
        await copyFile(zipPath, join(fillgstPublic, "fillgst-helper.zip"));
      }
      await copyFile(join(outDir, "crx-meta.json"), join(fillgstPublic, "crx-meta.json"));
      console.log(`✓ Copied .crx + .zip + crx-meta.json to ${fillgstPublic}/`);
      copied = true;
      break;
    }
  }
  if (!copied) {
    console.log(
      "ℹ FillGST repo not found at any expected location — copy dist/fillgst-helper.crx + dist/fillgst-helper.zip + crx-meta.json into <fillgst-repo>/public/extension/ manually.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
