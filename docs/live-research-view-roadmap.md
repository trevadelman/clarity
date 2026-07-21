# Live Research View — Roadmap

> **Status: shipped.** All phases below are implemented (with the layout
> deltas noted in "As-built changes"). Remaining open item: OAuth-based
> GitHub auth to unify the PAT + webview login (deferred; see bottom).

A native Tauri child-webview panel that follows the repo chat's agentic
research in real time. As Gemini calls `read_file`, `get_commit_diff`, or
`search_code`, the panel navigates to the corresponding page on github.com so
the user can watch the agent browse — and keep browsing themselves after the
answer arrives. Doubles as the Tauri multiwebview POC (Arc-style embedded
browsing) requested for the xeto studio work.

## Research findings (verified against this repo's dependency versions)

- **Tauri 2.11.2** (Cargo.lock) / `@tauri-apps/api` 2.11.0.
- Child webviews inside an existing window (`Window::add_child`, and the
  `create_webview` IPC command backing the JS `Webview` class) are gated
  behind the **`unstable` Cargo feature** — not currently enabled in
  `app/src-tauri/Cargo.toml`. Must add:
  `tauri = { version = "2", features = ["protocol-asset", "unstable"] }`.
- The JS `Webview` class has `setSize` / `setPosition` / `show` / `hide` /
  `close` / `reparent` — but **no `navigate()`**. Re-targeting an existing
  child webview to a new URL exists only in Rust:
  `tauri::webview::Webview::navigate(Url)` (stable API, not feature-gated).
- Therefore: **all webview lifecycle lives in Rust commands**; Svelte only
  invokes them. This is also the architecture that transfers directly to the
  xeto studio use case (app UI drives it; native layer owns the surface).
- Layering constraint (confirmed expectation): the child webview is a native
  `WKWebView` subview. HTML/CSS from the main (Svelte) webview **cannot
  render on top of it**. All chrome (close button, breadcrumb) must occupy
  screen rects that do not overlap the child webview's rect.
- Relevant ACL permissions already exist in the generated schema
  (`core:webview:allow-create-webview`, `allow-set-webview-size`,
  `allow-set-webview-position`, `allow-webview-show/hide/close`) — but since
  we go through custom `#[tauri::command]`s, the main webview only needs the
  usual `core:default` invoke permission; no webview ACL entries are needed
  for the custom-command route.

## Architecture

```
Svelte (+page.svelte, repo view)
  └─ ResearchPanel.svelte      ← reserves a right-hand column (flex), measures
      │                          its rect, renders header strip ABOVE the rect
      └─ $lib/researchView.ts  ← thin invoke() wrapper + URL mapping
            │
            ▼ invoke()
Rust (lib.rs)
  open_research_view(url, x, y, w, h)   → window.add_child(WebviewBuilder…)
  navigate_research_view(url)           → webview.navigate(url)
  set_research_view_rect(x, y, w, h)    → set_position + set_size (logical px)
  close_research_view()                 → webview.close()
```

- One child webview, label `"research"`, reused across navigations (no
  reload-flicker; the "Arc-like" instant retarget at single-panel scope).
- Multi-tab caching is explicitly **out of scope** for v1.

## Layout (as built)

The original plan was a three-column docked layout; user feedback during
implementation changed it to a **main-content overlay**:

```
┌─────────┬─────────────────────────────────────┬──────────────┐
│ sidebar │ research overlay (fixed)            │ chat panel   │
│ (always │ ┌─────────────────────────────────┐ │ (overlay,    │
│ visible)│ │ header: Live view · path · ⧉ ✕ │ │  as before)  │
│         │ ├─────────────────────────────────┤ │              │
│         │ │ native child webview            │ │              │
│         │ │ (rect = placeholder div)        │ │              │
│         │ └─────────────────────────────────┘ │              │
└─────────┴─────────────────────────────────────┴──────────────┘
```

- The overlay covers the main content, anchored `left: var(--sidebar-w)` —
  a CSS variable the layout sets reactively (220px / 64px collapsed), so the
  nav rail stays visible and the overlay tracks its collapse animation.
- When the chat is open, the overlay's `right` shrinks by the chat width
  (the native webview always renders above HTML, so it must yield space).
- The header matches ChatPanel's header padding exactly so the two align.
- Placeholder `<div>` reserves layout space; a `ResizeObserver` + resize/
  scroll listeners report its rect (CSS px = logical px) to Rust.
- Closing the chat also closes the research view (it follows the
  conversation); "Live view" header button opens both together.

## Implementation phases

### Phase 1 — Rust webview commands ✅
1. ✅ `Cargo.toml`: add `"unstable"` to tauri features.
2. ✅ `lib.rs`: add the four commands above (`open_research_view`,
   `navigate_research_view`, `set_research_view_rect`,
   `close_research_view`), registered in `invoke_handler`.
   - `open` is idempotent: if the `"research"` webview exists, navigate +
     reposition + show instead of re-creating.
   - Restrict navigation to `https://github.com/**` (validate the URL in
     Rust) — keeps the panel scoped to its purpose.
3. ✅ Smoke-tested; `cargo check` clean.

### Phase 2 — URL mapping for tool calls ✅
4. ✅ `$lib/researchView.ts` (new): wrappers over `invoke()`, plus
   `urlForToolCall(name, args, repo: RepoRef, defaultBranch): string | null`:
   - `read_file`      → `https://github.com/{o}/{r}/blob/{branch}/{path}`
   - `list_directory` → `https://github.com/{o}/{r}/tree/{branch}/{path}`
   - `get_commit_diff`→ `https://github.com/{o}/{r}/commit/{sha}`
   - `search_code`    → `https://github.com/search?q=repo:{o}/{r}+{q}&type=code`
   - `list_commits`   → `https://github.com/{o}/{r}/commits/{branch}`
5. ✅ `gemini.ts`: widened the repo-chat callback to
   `onToolCall(label, name, args)` (`RepoToolReporter`).

### Phase 3 — ResearchPanel + layout ✅
6. ✅ `$lib/ResearchPanel.svelte` (new): header ("Live view" title + current
   github.com path, "Open in browser" via plugin-opener, close ✕) +
   placeholder div + rect reporting + open/close lifecycle.
7. ✅ `+page.svelte` (repo branch): renders `ResearchPanel` when
   `researchUrl` is set; auto-navigates on each `onToolCall` of `askRepo`.
8. ✅ (Changed from plan) ChatPanel stays an overlay; the research view is a
   fullscreen-over-content overlay that shrinks to make room for the chat.
   ChatPanel gained `showScrim` + bindable `open` props instead of `docked`.

### Phase 4 — Citations ✅
9. ✅ `REPO_CHAT_SYSTEM_PROMPT` cites files as `[FILE:path]`, commits as
   `[COMMIT:sha]`.
10. ✅ `ChatPanel.svelte` renders them as clickable chips (`onCitation`);
    clicking opens/renavigates the research view. FILE regex is greedy
    (`\S+`) so bracketed paths like `routes/video/[id]/+page.svelte`
    survive, and `researchView.ts` percent-encodes each path segment.

### Phase 5 — Polish ✅
11. ✅ Sidebar collapse/expand handled via the layout's `--sidebar-w` CSS
    variable; window resize/scroll re-reports the rect.
12. ✅ Webview closes on panel unmount (component `onDestroy`), so route
    navigation cleans it up.
13. ✅ Layering findings confirmed: HTML cannot render over the native child
    webview; all chrome occupies non-overlapping rects, and overlapping
    panels (chat) must shrink the webview's rect instead.

## As-built changes vs. original plan

- Docked three-column layout → **overlay over main content** (nav rail kept
  visible via `--sidebar-w`); chat stays in its usual overlay slot.
- Chat `docked` prop → `showScrim` + bindable `open` props.
- Closing the chat dismisses the research view; "Live view" opens both.
- Chat panel now always opens scrolled to the latest message.

## Risks / open questions
- `unstable` feature: API may change between Tauri minor versions; acceptable
  for a POC-grade feature, worth noting in the readme.
- github.com may set `X-Frame-Options`-style protections — irrelevant here
  (this is a top-level native webview, not an iframe), but login state inside
  the child webview is separate from the app's GitHub token; private repos
  will require the user to sign in once inside the panel (session persists
  in the webview's data store).
- Chat overlay ↔ docked transition is the main UI complexity; if it drags,
  v1 fallback is to keep chat as the overlay and simply size the research
  column so the overlay never overlaps it. *(Resolved: overlay approach won.)*

## Deferred — unified GitHub auth (OAuth)

Today the PAT (Settings) authorizes API tool calls, while the live-view
webview has its own separate github.com session (private repos require a
one-time login inside the panel; the webview's storage is persistent so it
sticks). PATs cannot authenticate github.com page views — only the API — so
true unification requires replacing the PAT with **GitHub OAuth**:

- **Device Flow**: no client secret to ship; "Connect GitHub" in Settings
  replaces the PAT paste. Webview login for private repos remains a separate
  one-time step.
- **Authorization Code flow** (run inside the webview): a single login both
  authorizes the app and creates the github.com session — but requires
  embedding a client secret in the binary (accepted pattern, e.g. GitHub
  Desktop, but extractable).

Decision: stick with the PAT for now; revisit if private-repo live view
friction becomes a real problem.
