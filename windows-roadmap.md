# Windows Support Roadmap

Goal: ship Clarity for Windows (x64) alongside macOS, signed with the
Xetobase DigiCert EV certificate (KeyLocker cloud signing), built in CI.

The codebase is already ~98% OS-agnostic: no shell commands, no native
sidecar binaries, all I/O via Tauri's cross-platform plugins (`fs`, `path`,
`store`, `dialog`, `http`) and browser APIs (canvas frame capture). The
items below are everything that remains.

---

## Phase 1 — Cross-platform code fixes (do first, safe on macOS)

- [x] **`videoLibrary.ts` / `addVideo()`**: filename derived with
  `sourcePath.split("/").pop()` — breaks on Windows paths
  (`C:\Users\...\video.mp4`). Use `basename()` from `@tauri-apps/api/path`.
- [x] **`media.ts` / `mediaAbsPath()`**: stored relative media paths use `/`
  (portable store keys — keep that), but resolve them by splitting into
  segments and spreading into `join()` so no mixed-separator string is ever
  handed to the fs plugin.
- [x] **`scripts/make-latest-json.mjs`**: generalize to emit multiple
  platforms (`darwin-aarch64` + `windows-x86_64`), each platform included
  only when its artifact + `.sig` are present. Mac-only flow must keep
  working unchanged.
- [x] `npm run check` (0 errors) + manifest script verified against the
  v0.8.0 build output (emits `darwin-aarch64` only, as before). Full macOS
  build re-verified at next release.

## Phase 2 — Windows build in CI (GitHub Actions)

- [x] Manual test workflow `.github/workflows/windows-build.yml`
  (`workflow_dispatch`, `windows-latest`, rust-cache, installers uploaded as
  workflow artifacts only — invisible to the updater, no banner).
- [x] Un-signed Windows build smoke-tested on an AWS Windows instance:
  install, Loom + GitHub features, chat, restart persistence, uninstall
  (with user data removal), fresh reinstall — all working.
- [x] NSIS installer icon was the stock NSIS one — fixed with
  `bundle.windows.nsis.installerIcon` in `tauri.conf.json`.
- [x] Full release workflow on version tag push (`v*`):
  `.github/workflows/release.yml` — parallel macOS (Developer ID import →
  sign → notarize → verify) and Windows (KeyLocker, 2 signatures) jobs.
  All `APPLE_*`, `SM_*`, and `TAURI_SIGNING_PRIVATE_KEY` secrets set.
  ⚠️ Unverified until the first tag push (next release).

## Phase 3 — Windows code signing (DigiCert KeyLocker, EV) ✅

- [x] DigiCert One → KeyLocker: API token + client auth certificate
  (`github-actions-signing`). Gotcha: must be created in **DigiCert One**
  (one.digicert.com), NOT CertCentral — see
  the maintainer’s local signing vault.
- [x] CI: DigiCert `ssm-code-signing` action, `smctl` healthcheck +
  certsync, Tauri `bundle.windows.signCommand` → KeyLocker.
- [x] Secrets set: `SM_API_KEY`, `SM_CLIENT_CERT_FILE` (base64),
  `SM_CLIENT_CERT_PASSWORD`, `SM_HOST`, `SM_CODE_SIGNING_CERT_SHA1_HASH`.
- [x] Signature quota trimmed from 11 → **2 per release** (NSIS-only
  targets + selective `.github/sign.cmd` skipping embedded NSIS plugin
  DLLs and the uninstaller stub). Verified in run 29764105553.

## Phase 4 — Release integration

- [x] Merge job in `release.yml` combines macOS + Windows artifacts into one
  `latest.json` and attaches all assets (DMG, `.app.tar.gz`, NSIS `.exe`,
  manifest) to the GitHub release. Existing mac installs keep updating;
  Windows installs update via `windows-x86_64`.
- [x] `docs/releasing.md` rewritten for the CI flow (manual macOS process
  retained as fallback/reference).
- [ ] First tag-push release (vNext) — verify both jobs end-to-end, both
  platform updates apply, and DigiCert dashboard shows exactly +2.

## Phase 5 — Windows polish (post-first-ship)

- [ ] Title bar: `titleBarStyle: Overlay` is macOS-only; Windows shows a
  native title bar over the transparent drag strip. Decide: accept native
  bar (fine) or use `decorations: false` + custom controls (later).
- [x] Verify drag-drop file paths, asset-protocol video playback (WebView2),
  and store/media dirs on a real Windows machine — confirmed in the AWS
  smoke test.
- [ ] Consider `webview2` bootstrapper options in the NSIS installer
  (default "download bootstrapper" is fine for online users).

## Known non-issues (verified in review)

- URL building with `/` in `github.ts`, `videoLibrary.ts` — URLs, not file
  paths; fine everywhere.
- `$APPDATA/**` asset scope, `appDataDir()`, `join()` — resolve per-OS.
- `icon.ico` already present; `bundle.targets: "all"` covers Windows.
- WebView2 (Chromium) has broader codec support than macOS WebKit — video
  playback is fine or better.
- Gemini/GitHub/Loom/YouTube integrations are pure HTTPS — OS-agnostic.
