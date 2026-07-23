# Clarity

A cross-platform desktop app (Tauri v2 + SvelteKit, macOS + Windows) that
turns videos, links, and GitHub repositories into structured, searchable
knowledge with Google Gemini — plus an opt-in research browser built in.

## Layout

- `app/` — the Tauri + SvelteKit desktop app.
- `docs/` — releasing process, release notes, and design/readiness docs.

## Features

**Library**
- **Multiple source types** — local videos, Loom and YouTube links, and
  GitHub repositories. Repos become activity trackers with browsable
  commits and AI change digests.
- **AI summaries** — structured Markdown summaries via Gemini
  (`gemini-2.5-flash`), with editable default prompts and per-source
  custom instructions.
- **Per-source chat** — clickable timestamps for videos; agentic,
  code-aware research (file reads, diffs, searches) for repos.
- **Ask your library** — chat across every summarized source at once,
  with answers that cite and link to their sources.
- **Learning diagrams & highlights** — AI-generated conceptual diagrams
  and key-moment screenshots.
- **Spend tracking** — estimated Gemini cost tracked locally, visible in
  Settings.

**Browse mode (opt-in beta)**
- Enable in *Settings → Browser*. Adds a Browse rail to the sidebar:
  - A curated **link tree** (folders, favicons) of the sites you work in.
  - **Persistent browser tabs** — native webviews that stay signed in
    across sessions; OAuth popups (Google/GitHub/etc.) work.
  - **Page-aware AI** — chat about the page you're viewing; the assistant
    can read and navigate your open tabs.
  - **Clear browsing data** in Settings signs you out of every site
    without touching the library or keys.

**App**
- Auto-updates on both platforms (signed releases + `latest.json`).
- Light/dark theme, collapsible sidebar, local-first storage.

## Development

```bash
cd app
npm install
npm run tauri dev      # launches the native window
```

The browser dev server (`npm run dev`) renders the UI but cannot call the
Tauri plugins or native webviews — use `npm run tauri dev` for full
functionality.

## Data

All data is local, in the app data dir:
- `settings.json` — Gemini API key, GitHub token, prompts, browse-mode
  opt-in, tool-turn budget (plugin-store; plaintext, never bundled or
  committed).
- `library.json` — source records (videos, links, repos).
- `bookmarks.json` / tab state — browse-mode link tree and sessions.
- `spend.json` — estimated Gemini spend.
- `<appDataDir>/videos/<id>.<ext>` — the video files themselves.

Media is uploaded to the Gemini File API only when you summarize, and the
app re-uploads automatically if the remote file expired (~48h).

## Releasing

Releases are cut by CI: push a `vX.Y.Z` tag and GitHub Actions builds,
signs (macOS Developer ID + notarization; Windows DigiCert KeyLocker EV),
and publishes both platforms plus the auto-updater manifest in one GitHub
release.

See **[`docs/releasing.md`](docs/releasing.md)** for the checklist
(unsigned Windows vet → version bump → release notes → tag).

## Stack / decisions

- Svelte 5 (runes) + SvelteKit, Tauri v2.
- Gemini calls from frontend JS (`@google/genai`); model
  `gemini-2.5-flash` (see `app/src/lib/gemini.ts`).
- plugin-store for all persisted state; native child webviews (wry) for
  browse tabs and the research view.
