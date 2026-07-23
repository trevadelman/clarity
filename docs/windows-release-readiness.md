# Windows Release Readiness — `webview-poc`

**This doc is the release gate for merging `webview-poc` to main and
tagging the next version.** Every blocker below must be resolved (or
explicitly accepted as a degraded ship) and verified on a real Windows
machine before signing anything.

The branch compiles and runs on Windows (all objc2 deps are
macos-cfg-scoped), but a Windows build produced from it today would be
silently degraded: CI would build and sign it without any failure signal.

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
| 1 | `eval_in_tab` WebView2 twin | ☐ not started |
| 2 | Windows titlebar | ✅ resolved — mac Overlay chrome, native on Windows |
| 3 | First-request UA on WebView2 | ☐ unverified |
| 4 | Full Windows smoke test | ☐ not run |
| 5 | OAuth / popup-window handling | ☐ not started (**mandatory** pre-release) |

### 1. `eval_in_tab` WebView2 twin — the big one

Everything "Ask AI about this page" (all page tools, `navigate_to`'s
readiness poll) currently errors politely on Windows: the
`#[cfg(not(target_os = "macos"))]` branch in `lib.rs` returns
"Page extraction is not implemented on this platform yet."

Implement via `with_webview` → `ICoreWebView2::ExecuteScript` (the
completion handler returns the JSON result — same shape as the WKWebView
path; use the `webview2-com` crate wry already depends on). Write and
test this on a Windows machine, not blind.

Alternative if it slips: gate the "Ask AI" UI behind a platform check so
Windows users see a clear "not available on Windows yet" state instead
of tool errors mid-chat.

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

Builder `.user_agent()` is *believed* applied before the first request on
Windows (the about:blank bootstrap only exists for the macOS race).
Verify with a UA-echo site; if it races too, the fix is
`ICoreWebView2Settings2::PutUserAgent` before navigate.

### 4. Full Windows smoke test

Browse mode end to end on the EC2 box: tabs open/switch instantly, LRU
eviction at 4, DnD tree, hard reload, research view, logins persist
across restarts, titlebar/window chrome acceptable (native titlebar, no
double chrome, `--titlebar-h` is 0), and child-webview alignment correct
under the native titlebar at 100%/125%/150% DPI.

### 5. OAuth / popup-window handling — mandatory pre-release

Sites that authenticate via a popup window (`window.open` — Google, GitHub
"Sign in with Google", Microsoft, etc.) are not handled in the browse/research
webviews on **either** platform. An uncaptured `window.open()` in a child
webview is silently swallowed or spawns an untracked native popup, so those
logins can't complete.

This is a missing feature (not a platform bug) and is a hard blocker for
shipping Browse mode. Design one OS-agnostic approach via wry's new-window
hook (open the requested URL as another managed tab, or force a
redirect-based flow), then test it on Windows **and** locally on macOS.

## Test log

| Date | Build (run id / commit) | Tested | Result |
|------|------------------------|--------|--------|
| _(add entries as tests happen)_ | | | |

## When everything is green

1. Merge `webview-poc` to main (rebase, no merge commits).
2. Follow `docs/releasing.md` (version bumps, release notes, tag) — the
   signed CI release consumes 2 DigiCert signatures.
