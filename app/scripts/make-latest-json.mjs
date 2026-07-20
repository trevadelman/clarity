#!/usr/bin/env node
// Generate the Tauri updater manifest (latest.json) from release build
// output. Reads the version from tauri.conf.json, then scans for updater
// artifacts per platform — each platform is included only when its artifact
// and .sig are present, so a mac-only build still produces a valid manifest.
//
// Usage: node scripts/make-latest-json.mjs [--notes "Release notes"]
//        [--bundle-dir <path>]   (default: src-tauri/target/release/bundle)
//        [--out <path>]          (default: <bundle-dir>/macos/latest.json,
//                                 or <bundle-dir>/latest.json if no macos dir)

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = join(__dirname, "..");
const REPO = "trevadelman/clarity";

const conf = JSON.parse(
  readFileSync(join(appDir, "src-tauri", "tauri.conf.json"), "utf8")
);
const version = conf.version;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

const bundleDir =
  argValue("--bundle-dir") ??
  join(appDir, "src-tauri", "target", "release", "bundle");
const notes = argValue("--notes") ?? `Clarity v${version}`;

/**
 * Find an updater artifact (matching `suffix`, with a companion .sig) in
 * `dir` and return { url, signature }, or null if absent.
 */
function findArtifact(dir, suffix) {
  if (!existsSync(dir)) return null;
  const sigFile = readdirSync(dir).find((f) => f.endsWith(`${suffix}.sig`));
  if (!sigFile) return null;
  const artifact = sigFile.replace(/\.sig$/, "");
  return {
    signature: readFileSync(join(dir, sigFile), "utf8").trim(),
    url: `https://github.com/${REPO}/releases/download/v${version}/${encodeURIComponent(artifact)}`,
    artifact,
  };
}

// Platform → where its updater artifact lives and what it looks like.
const PLATFORMS = {
  "darwin-aarch64": { dir: join(bundleDir, "macos"), suffix: ".app.tar.gz" },
  "windows-x86_64": { dir: join(bundleDir, "nsis"), suffix: ".exe" },
};

const platforms = {};
for (const [key, { dir, suffix }] of Object.entries(PLATFORMS)) {
  const found = findArtifact(dir, suffix);
  if (found) {
    platforms[key] = { signature: found.signature, url: found.url };
    console.log(`  ${key}: ${found.artifact}`);
  }
}

if (Object.keys(platforms).length === 0) {
  throw new Error(
    `No signed updater artifacts found under ${bundleDir}. Did you build with the signing env vars set and createUpdaterArtifacts enabled?`
  );
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};

const macDir = join(bundleDir, "macos");
const outPath =
  argValue("--out") ??
  (existsSync(macDir) ? join(macDir, "latest.json") : join(bundleDir, "latest.json"));
writeFileSync(outPath, JSON.stringify(manifest, null, 2));
console.log(`Wrote ${outPath}`);
console.log(`  version:   ${version}`);
