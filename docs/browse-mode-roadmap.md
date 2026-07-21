# Browse Mode — Roadmap

An Arc-browser-style POC inside Clarity: a sidebar mode switcher that keeps
today's app untouched in "Library" mode and adds a "Browse" mode — a
favorites row + folder/link tree whose links open in a docked native webview
with the AI chat alongside. Test bed for what web browsing in Tauri can and
can't do, informing Xeto Studio.

Origin: Jason's ask (paraphrased) — Arc-style hyperlink tree in the left
sidebar, use Clarity to browse the web, chat with the AI about open pages,
eventually have AI generate the categories/links. Distilled here into
manual-first phases; AI features come after the mechanics are proven.

## Design decisions

- **Clarity stays Clarity.** Library mode is byte-for-byte today's sidebar
  (Library / Add source / Settings). Browse mode is additive, opt-in, and
  self-contained. No changes to the video/repo library behavior.
- **Mode switcher, not a takeover.** The top of the sidebar gains two
  Arc-style mode cards (Library | Browse). Only the nav-links region below
  swaps per mode; the brand header and the bottom chrome row (theme,
  collapse, version) are mode-agnostic. Mode persists in localStorage
  (same pattern as `sidebarCollapsed`).
- **Browsing lives in the router.** Clicking a tree link navigates to
  `/browse/[linkId]` — same shape as Library → `/video/[id]`. That route
  owns the docked webview + ChatPanel, reusing the live-research-view
  architecture wholesale rather than inventing a parallel one.
- **Manual first, AI later.** Tree building is hand-driven in v1 (add link /
  add folder / rename / delete / reorder). "AI generates the favorites" is a
  later phase layered on a proven UX.

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
  order: number;             // sibling sort key
  faviconPath?: string | null; // cached via media.ts, best-effort
  addedAt: string;
}
```

Store operations mirror `videoLibrary.ts` patterns: `listBookmarks()`,
`addBookmark()`, `updateBookmark()`, `removeBookmark()` (folders cascade),
`moveBookmark(id, newParentId, newOrder)`.

## Architecture reuse from the live research view

The docked-webview mechanics are already built and generic:

- Rust commands (`open_research_view` etc.) — only GitHub-specific piece is
  the `parse_github_url` allowlist. Browse mode needs a loosened policy:
  any `http(s)://` URL. Options: widen the existing commands' validation, or
  add a policy parameter. Keep one child webview label + one command set —
  do NOT fork a parallel set of commands.
- `ResearchPanel.svelte` → generalize into `BrowserView.svelte`: same
  placeholder-rect reporting, but header becomes a real address bar
  (editable URL, go), plus back/forward/reload via Rust-side
  `webview.eval("history.back()")` (same trick as xeto-studio's
  `titlebar_mac.rs`).
- `ChatPanel.svelte` — unchanged; docks beside the webview exactly as on
  the repo view (`showScrim={false}`, webview rect shrinks by chat width).

## Sidebar layout

```
┌──────────────────┐
│ Clarity brand    │
├──────────────────┤
│ [Library][Browse]│  ← mode cards
├──────────────────┤
│ Library mode:    │  Browse mode:
│  Library         │   ★ favorites row (grid of pinned links)
│  Add source      │   ▸ folder / link tree (nested, collapsible)
│  Settings        │   + Add link · + Add folder
├──────────────────┤
│ theme · collapse · version   (always)
└──────────────────┘
```

Collapsed-rail behavior: Browse mode collapses to favicon-only favorites
(tree hidden), mirroring how nav links collapse to icons today.

## Implementation phases

### Phase 1 — Mode switcher + LinkTree (no browsing yet)
1. `+layout.svelte`: mode state (`localStorage`), mode cards, conditional
   render of nav links vs. `LinkTree.svelte`.
2. `$lib/bookmarks.ts`: store + CRUD + move.
3. `$lib/LinkTree.svelte`: favorites row, nested tree with expand/collapse,
   add/rename/delete via inline UI, drag-and-drop reorder (HTML5 DnD,
   sibling reorder + reparent onto folders).
4. Favicon fetch (best-effort `https://{host}/favicon.ico` or Google's
   favicon service) cached through `media.ts`.

### Phase 2 — Browse route + generalized webview
5. Rust: loosen URL policy to any http(s) (validate + reject everything
   else: file:, data:, javascript: …).
6. `$lib/BrowserView.svelte`: generalized from `ResearchPanel` — address
   bar, back/forward/reload (via eval), open-in-browser, close.
7. `/browse/[id]` route: loads the bookmark, opens `BrowserView` docked
   over the content area (same `--sidebar-w` overlay pattern), tracks
   current URL as the user navigates links inside the page (webview
   `on_navigation` → event to frontend, if available; otherwise address bar
   reflects only app-driven navigations in v1 — document the limitation).

### Phase 3 — Chat about pages
8. ChatPanel docks beside the webview on `/browse/[id]` (reuse repo-view
   wiring). v1 context: the page URL + bookmark label + whatever we can
   fetch of the page over plain HTTP (`plugin-http` GET → strip tags) —
   honest limitation: JS-rendered SPAs won't fetch well this way; that's
   what Phase 5 is for.
9. `[LINK:id]` citation chips (same pattern as `[VIDEO:]`/`[FILE:]`) so
   answers can reference bookmarks; clicking navigates the webview.

### Phase 4 — AI tree organization (Jason item 1/3)
10. "Organize with AI" action: send the flat bookmark list to Gemini,
    receive a proposed folder structure, preview + apply. Also "suggest
    label/category" on add.

### Phase 5 — Page introspection spike (the real test-bed deliverable)
11. Research: Rust `Webview::eval()` into the child webview to extract
    `document.documentElement.outerHTML` (and computed CSS / console
    errors), returned via Tauri events. This is what makes "AI can see the
    open page" real for SPAs, and answers Jason's question 4 concretely.
12. Write up findings (what's extractable, cross-platform differences,
    security posture) for the Xeto Studio decision.

## Deferred / explicitly out of scope for now

- **Command-execution bookmarks** (Jason item 3b: "run terminal and build
  commands"). Different feature with real security implications (sidebar
  click → arbitrary local process). Revisit as its own `kind: "command"`
  node + Tauri shell plugin once the link tree is proven.
- Multi-tab webviews / tab caching (same v1 scope cut as the research view).
- Webview session/login management beyond what the persistent default
  profile already gives us.

## Risks / open questions

- `on_navigation` hooks for tracking in-page navigation: available at
  webview build time in Rust; feeding it back per-navigation needs an
  event channel. If flaky, v1 address bar shows app-driven URL only.
- Arbitrary-site browsing means arbitrary content in a native webview with
  a persistent profile — fine for a personal tool POC, but note it for the
  Xeto Studio writeup (cookie isolation, allowlists).
- Chat page-context quality is limited until Phase 5 (plain HTTP fetch
  misses JS-rendered content).
