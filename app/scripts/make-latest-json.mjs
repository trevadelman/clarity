#!/usr/bin/env node
// Generate the Tauri updater manifest (latest.json) from the release build
// output. Reads the version from tauri.conf.json, locates the macOS updater
// artifact (.app.tar.gz) and its signature (.sig), and writes a manifest that
// can be attached to the GitHub release.
//
// Usage: node scripts/make-latest-json.mjs [--notes "Release notes"]

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = join(__dirname, "..");
const REPO = "trevadelman/clarity";

const conf = JSON.parse(
  readFileSync(join(appDir, "src-tauri", "tauri.conf.json"), "utf8")
);
const version = conf.version;

const macDir = join(
  appDir,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos"
);

const files = readdirSync(macDir);
const sigFile = files.find((f) => f.endsWith(".app.tar.gz.sig"));
if (!sigFile) {
  throw new Error(
    `No .app.tar.gz.sig found in ${macDir}. Did you build with the signing env vars set and createUpdaterArtifacts enabled?`
  );
}
const tarFile = sigFile.replace(/\.sig$/, "");
const signature = readFileSync(join(macDir, sigFile), "utf8").trim();

const notesArg = process.argv.indexOf("--notes");
const notes =
  notesArg !== -1 ? process.argv[notesArg + 1] : `Clarity v${version}`;

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": {
      signature,
      url: `https://github.com/${REPO}/releases/download/v${version}/${encodeURIComponent(
        tarFile
      )}`,
    },
  },
};

const outPath = join(macDir, "latest.json");
writeFileSync(outPath, JSON.stringify(manifest, null, 2));
console.log(`Wrote ${outPath}`);
console.log(`  version:   ${version}`);
console.log(`  artifact:  ${tarFile}`);
