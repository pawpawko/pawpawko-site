// Stage the web assets that ship inside the Android APK.
// Copies HTML/CSS/JS/images from the repo root into ./www, which Capacitor
// then bundles via `cap sync`. Server-side stuff (scripts/, SQL, docs) is
// excluded so it never lands on a user's device.

import { rm, mkdir, cp, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const wwwDir = join(repoRoot, "www");

const includeDirs = ["css", "js", "images"];
const includeFiles = ["_redirects"];

await rm(wwwDir, { recursive: true, force: true });
await mkdir(wwwDir, { recursive: true });

for (const entry of await readdir(repoRoot)) {
  if (entry.endsWith(".html")) {
    await cp(join(repoRoot, entry), join(wwwDir, entry));
  }
}

for (const dir of includeDirs) {
  const src = join(repoRoot, dir);
  try {
    if ((await stat(src)).isDirectory()) {
      await cp(src, join(wwwDir, dir), { recursive: true });
    }
  } catch {}
}

for (const file of includeFiles) {
  try {
    await cp(join(repoRoot, file), join(wwwDir, file));
  } catch {}
}

console.log(`Staged web assets → ${wwwDir}`);
