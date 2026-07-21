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

### Phase 2 — Browsing surface with persistent tabs (the "Arc feel")
4. Rust: multi-webview tab commands above (LRU cap, http(s)-only policy).
5. `/browse` route: placeholder rect + rect reporting; clicking a tree
   link opens/shows its tab. **Acceptance test: switching between two open
   tree items is instant and preserves page state (scroll, form input,
   playing video).**
6. Minimal chrome: current tab's label/URL + open-in-browser + close tab.
   Address bar / back-forward only if cheap (eval `history.back()`).

### Phase 3 — AI ↔ page interaction spike (promoted; the Studio deliverable)
7. Extraction path: Rust `Webview::eval()` into the active tab. Note:
   `eval` is fire-and-forget — the injected JS must post results back
   (child webview built with IPC enabled → `invoke`/event back to Rust →
   event to frontend). Prove: `outerHTML`, document title, selected text,
   console errors.
8. Feed extracted page content to ChatPanel as context ("ask about this
   page"), docked beside the webview like the repo view.
9. Write up findings (what's extractable, WKWebView/WebView2 differences,
   IPC-into-child-webview security posture) for the Xeto Studio decision.

### Phase 4 — Conveniences (only after 1–3 prove out)
10. "Pin current page" (requires current-URL tracking via navigation
    events — also unlocks a live address bar).
11. `[LINK:id]` citation chips in chat answers.
12. "Organize with AI": send flat bookmark list to Gemini, preview and
    apply a proposed folder structure.

## Deferred / explicitly out of scope

- **Command-execution bookmarks** ("run terminal and build commands").
  Real security implications (sidebar click → arbitrary local process).
  Own feature (`kind: "command"` + shell plugin) if ever.
- Tree polish: drag-and-drop, inline rename, spaces/workspaces.
- Webview session/login management beyond the persistent default profile.

## Risks / open questions

- **Memory:** N live WKWebViews is the cost of the Arc feel. Cap + LRU is
  the mitigation; measure real usage in the spike.
- **IPC into child webviews:** Phase 3 requires the child webview to talk
  back (eval alone is one-way). Expected path: build tabs with Tauri IPC
  enabled and use events; needs verification against the `unstable`
  feature's current capabilities — this is itself a spike finding.
- **Navigation tracking:** `on_navigation` is a build-time hook; per-nav
  events to the frontend need wiring. Deferred with Phase 4's address bar.
- Arbitrary-site browsing in a persistent-profile native webview — fine
  for a personal-tool POC; flag cookie isolation/allowlists in the Studio
  writeup.
