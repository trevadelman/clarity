# Browse Mode — Roadmap

An Arc-browser-style POC inside Clarity: a sidebar mode switcher that keeps
today's app untouched in "Library" mode and adds a "Browse" mode — a
favorites row + folder/link tree whose links open in persistent native
webviews with the AI chat alongside. Test bed for what web browsing in
Tauri can and can't do, informing Xeto Studio.

Origin: Jason's ask (paraphrased) — Arc-style hyperlink tree in the left
sidebar, use Clarity to browse the web, chat with the AI about open pages,
eventually have AI generate the categories/links.

## What the POC is actually proving

Two things matter (per review); everything else is scaffolding:

1. **Live tab switching.** In Arc, tree items are *tabs*, not bookmarks —
   switching is instant and stateful, never a page reload. Reproducing that
   feel requires multiple persistent child webviews, so tab persistence is
   a Phase 2 core requirement, not a later retrofit.
2. **AI ↔ webview interaction.** Can the AI read what's on the open page
   (HTML/CSS/JS, including SPA-rendered content)? This is the real Studio
   test-bed question, so it's promoted to Phase 3 — right after browsing
   works — not parked at the end.

Tree/sidebar polish (drag-and-drop, inline rename, deep-nesting UX) is
explicitly deprioritized: only if trivial.

## Design decisions

- **Clarity stays Clarity.** Library mode is byte-for-byte today's sidebar
  (Library / Add source / Settings). Browse mode is additive and
  self-contained. No changes to the video/repo library behavior.
- **Mode switcher, not a takeover.** The top of the sidebar gains two
  Arc-style mode cards (Library | Browse). Only the nav-links region below
  swaps per mode; brand header and bottom chrome row (theme, collapse,
  version) are mode-agnostic. Mode persists in localStorage (same pattern
  as `sidebarCollapsed`).
- **One `/browse` route, not route-per-link.** Real browsing navigates away
  from the bookmark (click a link on a page — which bookmark are you "on"?).
  The tree is a launcher, not a router: `/browse` owns the browsing
  surface, the selected tree item is highlighted as active, and webviews
  outlive selection changes.
- **Tabs, not bookmarks, at the webview layer.** Clicking a tree item
  shows its (possibly already-loaded) webview; it does not navigate a
  shared one. See Phase 2.

## Data model (new `$lib/bookmarks.ts`)

Separate store file (`bookmarks.json` via `@tauri-apps/plugin-store`) — a
bookmark has no video/summary concept, so it does not touch `VideoRecord`.

```ts
interface BookmarkNode {
  id: string;
  parentId: string | null;   // null = top level
  kind: "folder" | "link";
  label: string;
  url?: string;              // kind === "link" only
  favorite?: boolean;        // pinned into the favorites row
  order: number;             // sibling sort key (order-by-added in v1)
  addedAt: string;
}
```

Favicons: Google's favicon service
(`https://www.google.com/s2/favicons?domain={host}&sz=64`) referenced
directly by URL — no fetching/caching pipeline. Direct `/favicon.ico`
fetches fail on too many modern sites (icons declared via `<link>` tags)
to be worth it.

Store operations mirror `videoLibrary.ts` patterns: `listBookmarks()`,
`addBookmark()`, `updateBookmark()`, `removeBookmark()` (folders cascade).

## Architecture: multi-webview tabs

The live research view proved single-child-webview mechanics (rect
placeholder + Rust commands). Browse mode extends the Rust side to
**multiple named child webviews**:

```
Rust (lib.rs)
  open_tab(id, url, rect)     create-or-show webview labeled `tab-{id}`
  show_tab(id)                hide others, show this one (instant switch)
  set_tab_rect(rect)          reposition all tabs' shared rect
  close_tab(id)               destroy one
  close_all_tabs()            destroy all (leaving /browse)
```

- All tab webviews share one rect (the placeholder div's), reported by the
  same ResizeObserver pattern as `ResearchPanel`.
- **Hard cap (~4 live webviews) with LRU eviction** — each is a full
  WKWebView; evicted tabs just reload on next click. Non-negotiable memory
  guard.
- URL policy: any `http(s)://`; reject `file:`, `data:`, `javascript:` etc.
- The research view's github-scoped commands stay as-is for the repo chat;
  tabs are a separate command family (shared helpers where sensible).

## Sidebar layout

```
┌──────────────────┐
│ Clarity brand    │
├──────────────────┤
│ [Library][Browse]│  ← mode cards
├──────────────────┤
│ Library mode:    │  Browse mode:
│  Library         │   ★ favorites row (pinned links)
│  Add source      │   ▸ folder / link tree
│  Settings        │   + Add link · + Add folder
├──────────────────┤
│ theme · collapse · version   (always)
└──────────────────┘
```

## Implementation phases

### Phase 1 — Mode switcher + minimal tree ✅ (done)
1. ✅ `+layout.svelte`: mode cards (Library | Browse) persisted in
   localStorage; Library mode unchanged; collapsed rail falls back to
   classic icon nav.
2. ✅ `$lib/bookmarks.ts`: store + CRUD, URL normalization, cascade
   delete, Google-service favicons.
3. ✅ `$lib/LinkTree.svelte`: favorites row, nested folders with
   expand/collapse, add link/folder (top-level and inside folders), pin
   favorite, delete. Plus trivial polish: double-click inline rename,
   favicon error fallback to a generic icon.
4. ✅ `/browse` route + `$lib/browseState.ts`: selected-link placeholder
   surface (replaced by the tab webviews in Phase 2). No DnD; order by
   added.

### Phase 2 — Browsing surface with persistent tabs ✅ (done)
4. ✅ Rust: tab command family (`open_tab` create-or-show, `set_tab_rect`,
   `close_tab`, `hide_all_tabs`, `close_all_tabs`, `tab_history`) with
   MRU/LRU cap of 4 live webviews and http(s)-only policy.
5. ✅ `/browse` route: placeholder rect + ResizeObserver sync; tree links
   open/show tabs. **Acceptance test passed** — switching between open
   tabs is instant with page state preserved. Leaving `/browse` hides
   (not destroys) tabs so state survives Library round-trips.
6. ✅ Chrome bar: back/forward/reload (via eval), favicon + label + URL,
   open-in-browser, close tab. Plus polish: header top padding trimmed
   across ResearchPanel/ChatPanel/browse chrome, collapsed-sidebar Browse
   mode shows a vertical favicon rail, tree rows sized to match nav links.

### Phase 3 — AI ↔ page interaction spike ✅ (done; writeup pending)
7. ✅ Extraction path solved WITHOUT child-webview IPC: Rust `eval_in_tab`
   calls WKWebView's `evaluateJavaScript:completionHandler:` directly
   (objc2/block2, versions matching wry's tree), so injected JS results
   return synchronously — no init scripts or event plumbing needed.
   `$lib/pageTools.ts` proves five extractions against the live DOM
   (SPA-rendered included): meta, readable text, raw HTML, user
   selection, links — each capped at 60K chars. Non-macOS returns a
   clear "not implemented" error (spike finding: Windows needs the
   WebView2 equivalent, `ExecuteScript`).
8. ✅ "Ask AI" in the browse chrome docks the reused ChatPanel beside the
   webview (per-tab session threads, tool trails, cost tracking).
   `generatePageChatReply` mirrors the repo chat's agentic
   function-calling loop with the extraction tools. Global UX:
   `$lib/chatDock.ts` — any docked chat auto-collapses the sidebar
   (one-way; user re-expands manually).
9. ✅ Bonus (beyond plan): `navigate_to` tool — the AI can navigate the
   user's visible tab (Rust `navigate_tab`, same http(s)-only policy),
   with a readyState-poll load wait that returns landing-page meta.
   Guardrails: visible-in-tab navigation only, tool-trail transparency,
   15-turn cap, prompt instructs few purposeful hops. Interaction tools
   (click/fill) deliberately deferred as too risky for the POC.
10. ⏳ Write up findings (what's extractable, WKWebView vs WebView2
    eval-with-result paths, native-handle security posture) for the
    Xeto Studio decision.

### UX polish (done alongside Phase 3)
- Collapsed-sidebar mode switching: the mode cards become a vertical stack
  of icon buttons in the same spot (no force-expand on switch), with a
  divider below them in both states.
- Real minimal titlebar chrome: a fixed `--titlebar-h` strip (sidebar-dark,
  draggable) replaces the invisible drag region; all surfaces (sidebar,
  content, chat, browse chrome, research view) start below it and no
  longer carry per-surface "clear the titlebar" padding hacks.
- Header alignment: browse chrome, ChatPanel, and ResearchPanel headers
  share a fixed `--panel-head-h` (52px) so they align by construction.
- Traffic lights vertically centered in the strip via
  `trafficLightPosition` (13,17 for the 38px bar — dialed in visually;
  macOS anchors the inset in AppKit's coordinate space, not our CSS
  strip); double-click-to-zoom works natively with the Overlay style.
- Windows note: `titleBarStyle: "Overlay"` is macOS-only — Windows will
  show its native titlebar above our strip. Eventual fix:
  `decorations: false` + custom min/max/close buttons in the strip.

### Phase 4 — Conveniences (only after 1–3 prove out)
10. "Pin current page" (requires current-URL tracking via navigation
    events — also unlocks a live address bar).
11. `[LINK:id]` citation chips in chat answers.
12. "Organize with AI": send flat bookmark list to Gemini, preview and
    apply a proposed folder structure.

## Deferred / explicitly out of scope

- ~~Tree drag-and-drop~~ ✅ DONE: rows are draggable with three drop zones
  (before/into/after via cursor Y), spring-loaded folder expansion (500ms
  hover), self/descendant-cycle guard, trailing root drop zone, and one
  atomic `moveBookmark(id, parent, index)` store op that renumbers the
  destination siblings. **Key spike finding:** HTML5 drop events never
  reach the DOM in Tauri unless the window sets `dragDropEnabled: false` —
  wry's native file-drop handling swallows dragover/drop at the webview
  layer (cross-platform issue; nothing here used native file drop).
- **Command-execution bookmarks** ("run terminal and build commands").
  Real security implications (sidebar click → arbitrary local process).
  Own feature (`kind: "command"` + shell plugin) if ever.
- Tree polish: spaces/workspaces (DnD and inline rename are done).
- Webview session/login management beyond the persistent default profile.
  (Note: logins DO persist — tabs share WKWebView's default persistent
  data store, so sessions survive tab eviction and app restarts. Spike
  finding: sites sniff embedded-webview UAs as unsupported browsers
  (Gmail showed "browser version no longer supported"), so tab/research
  webviews now send a real browser UA — Safari on macOS, Edge/Chrome on
  Windows (WebView2 is Chromium) — via a platform-conditional
  `BROWSER_UA`. Bump versions occasionally. Follow-ups: builder UA races
  the initial navigation on macOS, so webviews are created at about:blank,
  UA set natively, then navigated — first request carries the right UA.
  And since SPAs cache their degraded shell in service workers, the tab
  reload button is always a hard reload: unregister SWs + clear Cache API
  + reload; cookies/logins untouched.)

## Risks / open questions

- **Memory:** N live WKWebViews is the cost of the Arc feel. Cap + LRU is
  the mitigation; measure real usage in the spike.
- **IPC into child webviews — RESOLVED (spike finding):** child-webview
  IPC turned out to be unnecessary. Dropping to the native handle
  (`with_webview` → WKWebView `evaluateJavaScript:completionHandler:`)
  returns eval results directly. Cross-platform cost: needs a WebView2
  `ExecuteScript` twin on Windows.
- **Navigation tracking:** `on_navigation` is a build-time hook; per-nav
  events to the frontend need wiring. Deferred with Phase 4's address bar.
- Arbitrary-site browsing in a persistent-profile native webview — fine
  for a personal-tool POC; flag cookie isolation/allowlists in the Studio
  writeup.
