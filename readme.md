# Clarity

A lightweight macOS desktop app (Tauri v2 + SvelteKit) that takes a local
video, sends it to Google Gemini for multimodal understanding, and returns a structured
written summary.

See `init.md` for the full MVP spec.

## Layout


- `app/` — the Tauri + SvelteKit desktop app.


## App — development

```bash
cd app
npm install
npm run tauri dev      # launches the native macOS window
```

Features:
- **Local video library** — videos are copied into the app data dir and listed in
  a Library view. This is the source of truth; the list shows only your local videos.
- **Multi-page UI** — Library (`/`), Add video (`/add`), video detail
  (`/video/[id]`), and Settings (`/settings`), with a persistent sidebar nav.
- **Lazy / self-healing Gemini uploads** — a video is uploaded to the Gemini File
  API only when you summarize it. On each summarize the app checks whether the
  existing Gemini file is still `ACTIVE`; if it's missing or expired (~48h), it
  re-uploads from the local copy and remaps automatically.
- Drag-and-drop (or click to choose) to add a video.
- Editable, persisted summary prompt in Settings (with reset-to-default).
- Single summary stored per video (re-summarize overwrites it).
- Summary rendered as Markdown, with **Copy** and **Export .md**.
- **Delete** removes the local copy, the stored summary, and the Gemini upload
  (with a confirmation prompt).

Data:
- `settings.json` (plugin-store) — API key + default prompt.
- `library.json` (plugin-store) — `VideoRecord[]` metadata.
- `<appDataDir>/videos/<id>.<ext>` — the video files themselves.

Notes:
- The API key is entered in Settings and persisted via `plugin-store`
  (plaintext, in the app data dir). It is never bundled or committed.


- The browser dev server (`npm run dev`) renders the UI but cannot call the Tauri
  plugins (dialog/fs/store) — use `npm run tauri dev` for full functionality.

## Build a DMG

```bash
cd app
npm run tauri build
```

The `.dmg` lands in `app/src-tauri/target/release/bundle/dmg/`.

## Releasing (signed auto-update builds)

Clarity ships **in-app auto-update** (Tauri updater). Cutting a release is more
than `tauri build` — each release must include a signed updater artifact and a
`latest.json` manifest so installed copies can update themselves.

See **[`docs/releasing.md`](docs/releasing.md)** for the exact, step-by-step
process (version bump → signed build → manifest → GitHub release).


## Stack / decisions

- **D1 Svelte**, **D2 Gemini call in frontend JS** (`@google/genai`),
  **D3 plugin-store plaintext key** — all per the spec's recommendations.
- Model: `gemini-2.5-flash` (see `app/src/lib/gemini.ts`).
