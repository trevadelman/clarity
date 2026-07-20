# Releasing Clarity (signed auto-update builds)

Releases are cut by **CI** (`.github/workflows/release.yml`): push a version
tag and GitHub Actions builds, signs, and publishes both platforms into one
GitHub release — macOS (Developer ID + notarized) and Windows (DigiCert
KeyLocker EV) — plus the merged `latest.json` the auto-updater consumes.

## Per-release checklist (CI flow)

1. Bump the version in `app/package.json` and
   `app/src-tauri/tauri.conf.json` (must match), run `npm run check`,
   commit and push.
2. Tag and push:
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
3. Watch: `gh run watch` — the mac job signs + notarizes (minutes; Apple's
   queue), the Windows job KeyLocker-signs (consumes **2 metered DigiCert
   signatures**), the release job merges everything and publishes.
4. Verify:
   ```bash
   gh release view vX.Y.Z --json assets --jq '.assets[].name'
   # expect: Clarity.app.tar.gz, Clarity_X.Y.Z_aarch64.dmg,
   #         Clarity_X.Y.Z_x64-setup.exe, latest.json
   ```
5. Edit the auto-generated release notes if desired.

## What CI does per platform

**macOS job** (`macos-latest`):
- Imports the Developer ID certificate (base64 `.p12` secret) into a
  throwaway keychain on the runner.
- `tauri build` signs with hardened runtime, submits to Apple's notary
  service, waits, and staples the ticket (minutes — Apple's queue).
- Verifies with `spctl` (`accepted · source=Notarized Developer ID`) before
  uploading. Artifacts: DMG + `Clarity.app.tar.gz` + `.sig`.

**Windows job** (`windows-latest`):
- Signs via DigiCert KeyLocker (EV cert in a cloud HSM — nothing to
  install locally, instant SmartScreen trust, no notarization equivalent).
- **Signatures are metered** (bought in blocks of 1000). The build is
  deliberately trimmed to **2 per release**: NSIS-only bundling (no MSI)
  and `.github/sign.cmd` which skips embedded NSIS plugin DLLs and the
  uninstaller stub — Windows only validates `app.exe` and the outer
  `setup.exe`. Don't revert to `targets: "all"` or a plain signCommand:
  that costs 11 signatures per release for zero user-visible benefit.
- Artifacts: `Clarity_X.Y.Z_x64-setup.exe` + `.sig`.

**Release job** (`ubuntu-latest`): downloads both artifact sets, runs
`app/scripts/make-latest-json.mjs` to build the merged manifest (each
platform included only when its artifact + `.sig` exist), and publishes the
GitHub release.

## Secrets inventory (GitHub repo → Settings → Secrets)

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | base64 `.p12` export of the Developer ID Application identity |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Xetobase Inc (S3DGFW67TL)` |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | notarization: Apple ID, app-specific password, team ID |
| `SM_HOST` / `SM_API_KEY` | DigiCert KeyLocker endpoint + API token |
| `SM_CLIENT_CERT_FILE` / `SM_CLIENT_CERT_PASSWORD` | base64 client-auth `.p12` + password (authenticates CI to KeyLocker) |
| `SM_CODE_SIGNING_CERT_SHA1_HASH` | EV cert fingerprint `smctl` signs with |
| `TAURI_SIGNING_PRIVATE_KEY` | updater manifest key (same key as `app/.tauri-keys/clarity.key`; empty password) |

Secret *values*, rotation walkthroughs, and account details live outside
this repo (maintainer’s local "Xetobase App Signing" vault).

## FAQ / gotchas

- **Windows CI signing fails with 403 "Invalid credentials"** → the DigiCert
  client-auth cert or API token expired or was created in the wrong portal
  (they must come from **DigiCert One**, not CertCentral). Rotate and update
  the `SM_*` secrets.
- **A `.sig` is missing and the release job errors** → the corresponding
  build ran without `TAURI_SIGNING_PRIVATE_KEY`; check the job's env.
- **Tag pushed with wrong version in configs** → delete the release + tag
  (`gh release delete vX.Y.Z --cleanup-tag`), fix, re-tag.
- **Why no MSI?** Only useful for enterprise GPO deployment; costs extra
  metered signatures. Re-add `"msi"` to targets if a customer needs it.
- **DigiCert signature quota** — check remaining at one.digicert.com
  (KeyLocker dashboard). Expect exactly +2 per release.
- **Both jobs must succeed** for anything to publish — a failure on either
  platform means no release, no partial `latest.json` (existing installs
  are never left pointing at a broken manifest).

---

The rest of this document describes the **manual (local) macOS release
process** — kept as the fallback if CI is unavailable, and as reference for
how the pieces work. Every release must ship the updater bundle and the
signed manifest or auto-update will break.

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
  process, macOS does **not** quarantine them. And since v0.8.0 builds are
  notarized, first-time DMG installs are clean too — no `xattr` anywhere.

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
4. **Apple Developer ID signing + notarization** (added in v0.8.0):
   - A "Developer ID Application" certificate for **Xetobase Inc (S3DGFW67TL)**
     lives in the maintainer's login keychain (created via CSR from Keychain
     Access, downloaded from the developer portal).
   - Notarization credentials are stored in the keychain under the profile
     **`clarity-notary`**:
     ```bash
     xcrun notarytool store-credentials clarity-notary \
       --apple-id <apple-id email> --team-id S3DGFW67TL \
       --password <app-specific-password>
     ```
     (App-specific passwords are generated at account.apple.com → Sign-In and
     Security → App-Specific Passwords.)
   - With the `APPLE_*` env vars set (step 3 below), `tauri build` signs with
     hardened runtime, submits to Apple's notary service, waits for
     acceptance, and staples the ticket automatically. First-ever submission
     took ~45 min; subsequent ones are typically 1–10 min.

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

# Apple code signing + notarization (Developer ID)
export APPLE_SIGNING_IDENTITY="Developer ID Application: Xetobase Inc (S3DGFW67TL)"
export APPLE_ID="<apple-id email>"
export APPLE_PASSWORD="<app-specific password>"   # same one stored in clarity-notary
export APPLE_TEAM_ID="S3DGFW67TL"

npm run tauri build
```
The build now includes a "Notarizing" phase (Apple's queue; minutes, not
seconds — don't kill it). Check progress from another terminal with
`xcrun notarytool history --keychain-profile clarity-notary`.

Verify the result:
```bash
spctl -a -vv src-tauri/target/release/bundle/macos/Clarity.app
# expect: accepted · source=Notarized Developer ID
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
- **Apple notarization is configured** (since v0.8.0). Builds are signed with
  a Developer ID certificate and notarized, so first-time DMG installs open
  cleanly — **no `xattr` step needed**. If the `APPLE_*` env vars are omitted,
  the build still succeeds but ships un-notarized and Gatekeeper will block
  first installs; always set them for releases.
- **Apple Silicon only.** Builds target `darwin-aarch64`. To support Intel, build
  on/for `x86_64` and add a `darwin-x86_64` entry to the manifest.
