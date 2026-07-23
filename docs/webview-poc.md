# Webview POC — Live Research View + Browse Mode

> **Status: shipped in v2.0.0** (merged to main; Windows verified on a
> real machine). Browse mode is opt-in via *Settings → Browser*. Kept as
> a historical design/implementation record.

One continuous effort in two stages, both on the `webview-poc` branch:

1. **Live Research View** — a single native child webview that follows the
   repo chat's agentic research on github.com. Proved the child-webview
   mechanics (Rust-owned lifecycle, rect placeholder, navigation).
2. **Browse Mode** — an Arc-browser-style surface built on those
   mechanics: sidebar mode switcher, bookmark/link tree, multiple
   persistent tab webviews, and AI chat that can read and navigate the
   live page.

Origin: Jason's ask (paraphrased) — Arc-style hyperlink tree in the left
sidebar, use Clarity to browse the web, chat with the AI about open pages.
Test bed for what web browsing in Tauri can and can't do, informing Xeto
Studio.

## What the POC set out to prove

1. **Live tab switching.** In Arc, tree items are *tabs*, not bookmarks —
   switching is instant and stateful, never a page reload. ✅ Proven:
   requires multiple persistent child webviews (Phase 2 below).
2. **AI ↔ webview interaction.** Can the AI read what's on the open page
   (HTML/CSS/JS, including SPA-rendered content)? ✅ Proven on macOS via
   native `evaluateJavaScript` with completion handler (Phase 3 below).
   This is the real Studio test-bed question.

---

## Stage 1 — Live Research View (shipped)

A native child-webview panel that follows the repo chat's agentic
research in real time. As Gemini calls `read_file`, `get_commit_diff`, or
`search_code`, the panel navigates to the corresponding github.com page so
the user can watch the agent browse — and keep browsing afterwards.

### Key findings (verified against Tauri 2.11.x)

- Child webviews inside an existing window (`Window::add_child`) are gated
  behind the **`unstable` Cargo feature** — added to `Cargo.toml`.
- The JS `Webview` class has no `navigate()`; re-targeting exists only in
  Rust (`tauri::webview::Webview::navigate`). Therefore **all webview
  lifecycle lives in Rust commands**; Svelte only invokes them. This is
  the architecture that transfers directly to Xeto Studio.
- Layering constraint (confirmed): the child webview is a native subview.
  HTML/CSS from the main (Svelte) webview **cannot render on top of it**.
  All chrome must occupy non-overlapping rects; overlapping panels (chat)
  shrink the webview's rect instead.

### Architecture

```
Svelte (ResearchPanel.svelte)  ← reserves rect, renders header above it
  └─ $lib/researchView.ts      ← invoke() wrappers + tool-call → URL mapping
        ▼ invoke()
Rust (lib.rs)
  open_research_view(url, rect)   → window.add_child(WebviewBuilder…)
  navigate_research_view(url)     → webview.navigate(url)
  set_research_view_rect(rect)    → set_position + set_size (logical px)
  close_research_view()           → webview.close()
```

- One child webview, label `"research"`, reused across navigations;
  URL policy restricted to `https://github.com/**`.
- Tool-call URL mapping: `read_file` → blob page, `list_directory` → tree,
  `get_commit_diff` → commit, `search_code` → code search,
  `list_commits` → commits.
- Citations: the repo chat cites `[FILE:path]` / `[COMMIT:sha]`; ChatPanel
  renders them as clickable chips that navigate the research view.
- As-built layout: an **overlay over main content** (not the originally
  planned three-column dock), anchored `left: var(--sidebar-w)`, shrinking
  when the chat opens. Placeholder `<div>` + ResizeObserver report the
  rect to Rust.

### Deferred — unified GitHub auth (OAuth)

The PAT authorizes API tool calls; the webview has its own github.com
session (one-time login for private repos; persists). PATs can't
authenticate page views, so true unification needs GitHub OAuth (Device
Flow, or Authorization Code with an embedded secret). Decision: stick
with the PAT; revisit if private-repo friction becomes real.

---

## Stage 2 — Browse Mode (shipped on macOS)

### Design decisions

- **Clarity stays Clarity.** Library mode is byte-for-byte today's
  sidebar. Browse mode is additive and self-contained.
- **Mode switcher, not a takeover.** Arc-style mode cards (Library |
  Browse) at the top of the sidebar; only the nav-links region swaps.
  Mode persists in localStorage.
- **One `/browse` route, not route-per-link.** The tree is a launcher,
  not a router; webviews outlive selection changes.
- **Tabs, not bookmarks, at the webview layer.** Clicking a tree item
  shows its (possibly already-loaded) webview.

### Data model (`$lib/bookmarks.ts`)

Separate store file (`bookmarks.json` via `@tauri-apps/plugin-store`):

```ts
interface BookmarkNode {
  id: string;
  parentId: string | null;   // null = top level
  kind: "folder" | "link";
  label: string;
  url?: string;              // kind === "link" only
  favorite?: boolean;        // pinned into the favorites row
  order: number;             // sibling sort key
  addedAt: string;
}
```

Favicons come from Google's favicon service (direct `/favicon.ico`
fetches fail on too many modern sites).

### Multi-webview tabs (Rust command family)

```
open_tab(id, url, rect, bg)   create-or-show webview `tab-{id}`
set_tab_rect(rect)            reposition all tabs' shared rect
close_tab(id)                 destroy one
hide_all_tabs()               hide without destroying (leaving /browse)
close_all_tabs()              destroy all
tab_history(id, action)       back / forward / hard reload
navigate_tab(id, url)         AI navigate tool (same http(s)-only policy)
eval_in_tab(id, js)           run JS in the page, return its result
```

- **Hard cap of 4 live webviews with LRU eviction** (each is a full
  native webview; evicted tabs reload on next click).
- URL policy: any `http(s)://`; reject `file:`, `data:`, `javascript:`.

### AI ↔ page interaction (the key spike finding)

Extraction was solved WITHOUT child-webview IPC: Rust `eval_in_tab` calls
WKWebView's `evaluateJavaScript:completionHandler:` directly (objc2 /
block2, versions matching wry's tree), so injected JS results return
synchronously — no init scripts or event plumbing needed.
`$lib/pageTools.ts` proves five extractions against the live DOM
(SPA-rendered included): meta, readable text, raw HTML, user selection,
links — each capped at 60K chars.

- "Ask AI" docks the reused ChatPanel beside the webview (per-tab
  threads, tool trails, cost tracking). `generatePageChatReply` shares
  the agentic loop (`runAgenticChat`) with the repo chat.
- `navigate_to` tool: the AI can navigate the visible tab, with a
  readyState-poll load wait. Guardrails: visible-tab-only, tool-trail
  transparency, 15-turn cap. Interaction tools (click/fill) deliberately
  deferred as too risky for the POC.
- **Non-macOS returns a clear "not implemented" error** — Windows needs
  the WebView2 `ExecuteScript` twin (see the readiness doc).

### Webview sessions / user agent (spike findings)

- Logins persist: tabs share the webview's default persistent data store,
  surviving eviction and restarts.
- Sites sniff embedded-webview UAs as unsupported browsers (Gmail showed
  "browser version no longer supported"), so tab/research webviews send a
  real browser UA — Safari on macOS, Edge/Chrome on Windows — via a
  platform-conditional `BROWSER_UA`. Bump versions occasionally.
- The builder UA races the initial navigation on macOS, so webviews are
  created at about:blank, UA set natively, then navigated.
- SPAs cache their degraded shell in service workers, so the tab reload
  button is always a **hard reload**: unregister SWs + clear Cache API +
  reload; cookies/logins untouched.
- **DnD finding:** HTML5 drop events never reach the DOM in Tauri unless
  the window sets `dragDropEnabled: false` — wry's native file-drop
  handling swallows dragover/drop at the webview layer.

### UX polish (done alongside)

- Tree DnD: three drop zones (before/into/after), spring-loaded folder
  expansion, cycle guard, one atomic `moveBookmark` store op.
- Inline rename (double-click), nested folder creation, two-click delete
  confirm, hover-reveal add row.
- Minimal titlebar chrome: fixed `--titlebar-h` strip (draggable); all
  surfaces start below it. Traffic lights centered via
  `trafficLightPosition` (macOS-only — see readiness doc for Windows).
- Panel headers share a fixed `--panel-head-h` so they align by
  construction. Collapsed rail shows vertical mode icons + favicon rail.
- Theme-aware sidebar and themed webview pre-paint background (avoids the
  white flash before first paint).
- Any docked chat auto-collapses the sidebar (`$lib/chatDock.ts`).

### Phase 4 conveniences (not started)

- "Pin current page" (requires current-URL tracking via navigation
  events — also unlocks a live address bar).
- `[LINK:id]` citation chips in chat answers.
- "Organize with AI": Gemini proposes a folder structure for the tree.

### Explicitly out of scope

- **Command-execution bookmarks** — real security implications (sidebar
  click → arbitrary local process). Own feature if ever.
- Spaces/workspaces; session management beyond the persistent default
  profile.

## Risks / open questions

- **Memory:** N live webviews is the cost of the Arc feel; cap + LRU is
  the mitigation.
- **`unstable` Tauri feature:** child-webview APIs may change between
  Tauri minors; acceptable for POC-grade, worth remembering at upgrades.
- **Navigation tracking:** per-nav events to the frontend need wiring;
  deferred with Phase 4's address bar.
- Arbitrary-site browsing in a persistent-profile native webview — fine
  for a personal tool; flag cookie isolation/allowlists in the Studio
  writeup.
- ⏳ Still owed: findings writeup (what's extractable, WKWebView vs
  WebView2 eval paths, native-handle security posture) for the Xeto
  Studio decision.
