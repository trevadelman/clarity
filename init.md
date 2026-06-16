# MVP Spec — Whiteboard Video Summarizer (Desktop)

**One-liner:** A lightweight macOS desktop app that takes a local video file (someone talking through a whiteboard session), sends it to Google Gemini for multimodal understanding, and returns a written summary.

**Audience:** Internal use only. Not production-grade, not distributed to external users. Optimize for speed of build and "it works," not hardening.

**Deliverable:** A signed-or-unsigned `.dmg` the team can install on macOS.

---

## 1. Scope

**In scope (MVP):**
- Pick a local video file.
- Enter and persist a Gemini API key in-app (no key bundled in the binary).
- Upload the video to Gemini's File API, wait for processing, request a summary.
- Show the summary text; allow copy-to-clipboard.

**Out of scope (for now):**
- Multi-user / auth / cloud sync.
- Editing or trimming video in-app.
- Windows/Linux builds (architecture stays portable, but only macOS DMG is required).
- Storing/organizing past summaries (nice-to-have, see §8).

---

## 2. Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri v2** | Uses the OS webview (WKWebView) + a small Rust binary. DMG lands in the low-tens-of-MB vs ~100–150 MB for Electron. |
| Frontend | **Svelte + Vite** | Single-screen tool; minimal boilerplate. Swap for React if the team prefers — see decision point D1. |
| Gemini integration | **`@google/genai` JS SDK, called from the frontend** | Fastest path. SDK handles the resumable upload protocol. See decision point D2. |
| File picking | `@tauri-apps/plugin-dialog` | Native file picker → returns a path. |
| File reading | `@tauri-apps/plugin-fs` | Read bytes to hand the SDK a Blob. |
| Key storage | `@tauri-apps/plugin-store` | Persisted JSON key-value. Plaintext — acceptable for internal single-user use. |

Scaffold with `npm create tauri-app@latest` (choose the Svelte + TS template).

**Decision points for the dev to confirm:**
- **D1 — Frontend framework:** Svelte (recommended) vs React. Either is fine; pick what the team maintains.
- **D2 — Where the Gemini call lives:** Frontend JS (recommended for MVP speed) vs Rust backend (`reqwest`). Rust keeps the API key out of the webview and is more robust for large uploads — worth it later, overkill now.
- **D3 — Key storage:** `plugin-store` (plaintext, recommended for MVP) vs macOS Keychain (encrypted, via a keyring/stronghold plugin) if anyone objects to plaintext.

---

## 3. Data flow

```
[User picks video]
      ↓ (plugin-dialog → path)
[Read file bytes]
      ↓ (plugin-fs → Blob)
[Upload to Gemini File API]   ← ai.files.upload()
      ↓ (returns file handle, state = PROCESSING)
[Poll file state until ACTIVE]   ← ai.files.get(), loop with backoff
      ↓
[generateContent(model, [filePart, promptText])]
      ↓
[Render summary text]
```

Three states the UI must represent: **uploading**, **processing** (polling), **generating**. Don't skip the processing state — see §5.

---

## 4. Core features (MVP)

1. **Settings:** a text field for the Gemini API key + Save. Persist via `plugin-store`. Load on launch; show a "set your key" prompt if empty.
2. **File picker:** button → native dialog filtered to common video types (`.mp4`, `.mov`, `.webm`).
3. **Run:** uploads, polls, generates. Disabled until both a key and a file are present.
4. **Status indicator:** reflects upload → processing → generating, with a clear failure state and the error message.
5. **Output:** the summary text in a scrollable, selectable panel + a Copy button.

---

## 5. Gemini integration notes (the parts that bite)

These are the non-obvious bits — please read before estimating.

**Two-step async upload.** After `files.upload()`, the file sits in `PROCESSING`. You **must poll** `files.get()` until state is `ACTIVE` before calling `generateContent`, or the call fails. Poll with a short interval (e.g. 2–5s) and a timeout. This wait is the main reason the UI needs a distinct "processing" state.

**Context/token budget on long videos.** Gemini samples video at roughly ~1 frame/sec; combined with audio this is on the order of ~300 tokens per second of video at default resolution (~17k tokens/min). A ~30-min session fits comfortably in Gemini 2.5 Pro's large context; a ~60-min session at default resolution can exceed it. Mitigations:
- Request **low-resolution** media processing (cuts per-frame tokens substantially). For whiteboard sessions the value is in speech + general board state, not pixel detail, so low-res is usually fine.
- Optionally expose a **time-range clip** input later.

**File retention.** Uploaded files are auto-deleted by Gemini after ~48h. Fine for this flow (upload → summarize → done); don't build anything that assumes persistence.

**Model:** use a current Gemini 2.5 multimodal model. ⚠️ Confirm the exact model ID, File API size/duration limits, retention window, and SDK method names against the **live Google GenAI docs** — these change and this spec was written from early-2026 knowledge.

**Prompt (starting point — tune in testing):**
> "This video is a whiteboard working session with a person narrating. Produce a structured summary: (1) the main topic, (2) key points and decisions in order, (3) any action items or open questions raised, (4) a short description of what's drawn on the whiteboard and how it evolves. Use the spoken audio as the primary source and the whiteboard visuals as support."

---

## 6. API key handling

- Field in Settings → saved via `plugin-store` to the app's data dir.
- **Never** bundle a key in the binary or commit one to the repo.
- Load on launch; if empty, gate the Run button and show a prompt.
- (Optional hardening, D3) move to macOS Keychain if plaintext-on-disk is a concern.

---

## 7. UI

Single window, two regions:
- **Top bar / settings drawer:** API key field + Save (collapsed once a key is set).
- **Main:** "Choose video" button + selected filename → "Summarize" button → status line → summary panel with Copy.

No design system needed. Keep it one screen.

---

## 8. Out of scope / future (don't build yet)

- Saving a history of summaries (local SQLite or JSON).
- Time-range clipping before upload.
- Export to Markdown/PDF.
- Windows/Linux builds.
- Moving the Gemini call into Rust (D2) for tighter key handling and large-file robustness.

---

## 9. Rough effort

For someone comfortable with Tauri + JS: **roughly a day** for a working MVP (scaffold + file pick + key storage are quick; the upload→poll→generate flow and its UI states are the real work), plus a few hours for polish and DMG packaging. The Gemini async flow and token/context handling are where time goes, not Tauri itself.

---

## 10. References to verify (live docs)

- Tauri v2 — bundling/DMG, `plugin-dialog`, `plugin-fs`, `plugin-store`.
- Google Gemini — File API (resumable upload, processing states, retention/size limits), `@google/genai` JS SDK, current 2.5 model IDs, low-resolution media option, video token accounting.

> All Gemini-specific figures above (token rates, retention window, limits, model names) are approximate and from early-2026 knowledge — confirm against current docs before locking the implementation.