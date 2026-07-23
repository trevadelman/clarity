# Windows Release Readiness — `webview-poc`

> **Status: gate passed — shipped in v2.0.0.** All blockers below were
> resolved and verified on a real Windows machine (EC2 smoke test of the
> unsigned installer) before tagging. Kept as a historical record.

The branch compiles and runs on Windows (all objc2 deps are
macos-cfg-scoped), but a Windows build produced from it at the time of
writing would have been silently degraded: CI would build and sign it
without any failure signal.

## Test loop (no signatures consumed)

Build unsigned in CI, download to the Mac, copy to the Windows EC2
testbed, install and smoke-test:

```bash
gh workflow run windows-build-unsigned.yml --ref webview-poc
gh run watch
gh run list --workflow=windows-build-unsigned.yml -L 1   # run id
gh run download <run-id>    # → clarity-windows-unsigned-installer/*.exe
# copy the .exe to the EC2 instance and install
```

SmartScreen will warn "Unknown publisher" (unsigned test build) —
expected; click through. This workflow never touches releases,
`latest.json`, or the DigiCert quota.

## Blockers

| # | Blocker | Status |
|---|---------|--------|
| 1 | `eval_in_tab` WebView2 twin | ✅ verified on EC2 |
| 2 | Windows titlebar | ✅ resolved — mac Overlay chrome, native on Windows |
| 3 | First-request UA on WebView2 | ✅ verified on EC2 |
| 4 | Full Windows smoke test | ✅ passed on EC2 |
| 5 | OAuth / popup-window handling | ✅ verified on mac + EC2 |

### 1. `eval_in_tab` WebView2 twin — the big one

Implemented: `eval_in_tab` now has a `#[cfg(windows)]` branch using
`with_webview` → `ICoreWebView2::ExecuteScript` with a completion handler
(`webview2-com`, same version as wry's tree). ExecuteScript returns the JS
value JSON-encoded, so the result is decoded back to the plain string the
WKWebView path returns (`decode_execute_script_result`). Same mpsc +
`spawn_blocking` + 10s timeout structure as macOS. Linux keeps the polite
"not implemented" error.

Written blind on macOS — the unsigned CI build is the compile gate, and
the page tools ("Ask AI about this page") must be exercised on the EC2
box before this is checked off.

### 2. Titlebar — ✅ resolved

The original problem: `titleBarStyle: "Overlay"` + the draggable HTML strip
is macOS-only, so Windows got double chrome (native titlebar *plus* the
38px strip). Resolution is platform-conditional chrome, not a revert:

- **macOS** keeps the Overlay config and the CSS titlebar strip — this is
  load-bearing, because with Overlay the main webview spans the full window
  frame, so DOM coordinates and child-webview (frame-anchored) coordinates
  are identical by construction. No offset code exists or is needed.
- **Windows** ignores the Overlay options (native titlebar), and the layout
  sets `--titlebar-h: 0px` and skips the strip, so content starts directly
  below the native titlebar. Child webviews are positioned in client-area
  coordinates on Windows, which already exclude the titlebar — alignment
  again holds with no offset.

A native-titlebar-everywhere revert was attempted and abandoned: it forces
a 28px child-webview offset on macOS that no tao/tauri geometry API can
measure (all report content == frame under the hood).

### 3. First-request UA on WebView2

Hardened: `add_browser_webview` now also sets the UA natively on Windows
(`ICoreWebView2Settings2::SetUserAgent`) between webview creation at
about:blank and the first real navigation — the same belt-and-suspenders
the macOS path uses. Verify on EC2 with a UA-echo site (should report the
Edge UA).

### 4. Full Windows smoke test

Browse mode end to end on the EC2 box: tabs open/switch instantly, LRU
eviction at 4, DnD tree, hard reload, research view, logins persist
across restarts, titlebar/window chrome acceptable (native titlebar, no
double chrome, `--titlebar-h` is 0), and child-webview alignment correct
under the native titlebar at 100%/125%/150% DPI.

### 5. OAuth / popup-window handling — mandatory pre-release

Implemented in `add_browser_webview` via `on_new_window`: http(s)
`window.open` requests from browse/research webviews open a real decorated
popup window (`NewWindowResponse::Create`) that shares the opener's web
context — `with_webview_configuration` on macOS, `with_environment` on
Windows — so `window.opener`/postMessage plumbing works and the popup can
close itself when the OAuth flow completes. Non-http(s) schemes are denied.
Popups are transient (`popup-<n>` labels, untracked, no IPC capabilities).

Verify with a "Sign in with Google"-style flow on macOS locally, then on
the EC2 box.

## Test log

| Date | Build (run id / commit) | Tested | Result |
|------|------------------------|--------|--------|
| _(add entries as tests happen)_ | | | |

## When everything is green

1. Merge `webview-poc` to main (rebase, no merge commits).
2. Follow `docs/releasing.md` (version bumps, release notes, tag) — the
   signed CI release consumes 2 DigiCert signatures.
