# Releasing Clarity (signed auto-update builds)

This is the exact, repeatable process for cutting a new Clarity release that the
in-app auto-updater can consume. Every release must ship three assets — the DMG
(for first-time manual installs), the updater bundle (`Clarity.app.tar.gz`), and
the signed manifest (`latest.json`) — or auto-update will break.

---

## How auto-update works (context)

- The app is configured (`app/src-tauri/tauri.conf.json` → `plugins.updater`) to
  poll `https://github.com/trevadelman/clarity/releases/latest/download/latest.json`.
- `latest.json` lists the new version, release notes, the download URL for
  `Clarity.app.tar.gz`, and a cryptographic **signature**.
- On launch (and via **Settings → Check for updates**) the app compares its
  version to the manifest. If newer, it downloads the tarball, verifies the
  signature against the **public key baked into the app**, installs it, and
  relaunches.
- Because the new files are written by the already-running, already-trusted app
  process, macOS does **not** quarantine them — so auto-updates need no `xattr`
  step. Only the very first manual DMG install does.

---

## One-time setup (already done — for reference)

These steps were done once and do **not** need to be repeated:

1. **Signing keypair generated:**
   ```bash
   cd app
   npx tauri signer generate -w .tauri-keys/clarity.key --password ""
   ```
   - Private key: `app/.tauri-keys/clarity.key` — **secret**, gitignored, never commit.
   - Public key: `app/.tauri-keys/clarity.key.pub` — embedded as `plugins.updater.pubkey`
     in `tauri.conf.json`.
2. **Plugins wired up:** `tauri-plugin-updater` + `tauri-plugin-process` (Rust in
   `Cargo.toml`/`lib.rs`, JS in `package.json`), with `updater`/`process`
   permissions in `app/src-tauri/capabilities/default.json`.
3. **`createUpdaterArtifacts: true`** set under `bundle` in `tauri.conf.json` so
   builds emit the `.app.tar.gz` updater artifact and its `.sig`.

> ⚠️ **If the private key or its password is lost, auto-update breaks permanently** —
> you'd have to ship a new public key in a new manual build, and existing installs
> could no longer auto-update. Keep `app/.tauri-keys/clarity.key` backed up safely.

### Where the private key is backed up

The signing private key is **gitignored** (never committed — not even to a private
repo, since git history would replicate it). It is backed up in the **macOS login
Keychain** on the maintainer's Mac.

- **Store / update it:**
  ```bash
  cd app
  security add-generic-password -a "$USER" \
    -s "clarity-tauri-updater-private-key" \
    -w "$(cat .tauri-keys/clarity.key)" -U
  ```
- **Recover it** (e.g. after a fresh checkout where `.tauri-keys/` is absent):
  ```bash
  mkdir -p app/.tauri-keys
  security find-generic-password -s "clarity-tauri-updater-private-key" -w \
    > app/.tauri-keys/clarity.key
  ```
- The key has an **empty password** (`TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`).

> The Keychain is local to that one Mac. For resilience against a lost/dead
> machine, also keep one off-machine copy (password manager or encrypted volume).
> Do **not** use GitHub Secrets for this — Secrets are write-only/CI-oriented and
> can't be read back, so they don't serve as a recoverable backup.

---

## Per-release checklist

Replace `X.Y.Z` with the new version (e.g. `0.4.2`).

### 1. Bump the version in two places
- `app/package.json` → `"version"`
- `app/src-tauri/tauri.conf.json` → `"version"`

(They must match.)

### 2. Sanity-check the frontend
```bash
cd app
npm run check
```
Fix any errors before building.

### 3. Build with the signing env vars set
The private key (and its empty password) must be exported so Tauri signs the
updater artifact:
```bash
cd app
# free the dev port / kill any stale dev process first
lsof -ti:1420 | xargs kill -9 2>/dev/null; pkill -f "target/debug/app" 2>/dev/null

export TAURI_SIGNING_PRIVATE_KEY="$(cat .tauri-keys/clarity.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build
```
On success you'll see, in `app/src-tauri/target/release/bundle/`:
- `dmg/Clarity_X.Y.Z_aarch64.dmg`
- `macos/Clarity.app.tar.gz` (updater)
- `macos/Clarity.app.tar.gz.sig` (signature)

> If `.sig` is missing, the signing env vars weren't set — re-run step 3.

### 4. Generate the manifest
```bash
cd app
node scripts/make-latest-json.mjs --notes "Short release notes here."
```
This reads the version from `tauri.conf.json`, finds the signed artifact, and
writes `app/src-tauri/target/release/bundle/macos/latest.json`.

### 5. Commit and push
```bash
cd <repo root>
git add -A
git commit -m "clarity: [type] vX.Y.Z — short description"
git push origin main
```

### 6. Create the GitHub release with all three assets
```bash
cd app/src-tauri/target/release/bundle
gh release create vX.Y.Z \
  "dmg/Clarity_X.Y.Z_aarch64.dmg" \
  "macos/Clarity.app.tar.gz" \
  "macos/latest.json" \
  --title "Clarity vX.Y.Z" \
  --notes "## Clarity vX.Y.Z

### Changed
- ...

### Auto-update
- If you're on a prior auto-update build, this installs automatically via
  Settings → Check for updates (or the banner). No \`xattr\` needed."
```

### 7. Verify the upload
```bash
gh release view vX.Y.Z --json assets --jq '.assets[].name'
# expect: Clarity.app.tar.gz, Clarity_X.Y.Z_aarch64.dmg, latest.json
```

That's it — installs on the previous auto-update build will pick up `vX.Y.Z`.

---

## Notes & gotchas

- **Asset names matter.** The updater fetches `latest.json` from the *latest*
  release, and that manifest points at `Clarity.app.tar.gz` by exact name. Always
  attach all three assets to every release.
- **The tarball name is unversioned** (`Clarity.app.tar.gz`) — that's expected;
  the version lives in the release tag and the manifest URL.
- **Apple notarization** is intentionally *not* configured. The updater signature
  guarantees integrity, but the app isn't notarized, so the **first** manual DMG
  install still needs:
  ```bash
  xattr -dr com.apple.quarantine /Applications/Clarity.app
  ```
  Every subsequent auto-update is seamless. If Clarity is ever distributed widely,
  add an Apple Developer cert + notarization to remove `xattr` even on first install.
- **Apple Silicon only.** Builds target `darwin-aarch64`. To support Intel, build
  on/for `x86_64` and add a `darwin-x86_64` entry to the manifest.
