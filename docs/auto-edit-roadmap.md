# Auto-Edit — AI Video Splicer (Projects add-on)

> **Status: planning complete, implementation starting.** macOS-only,
> opt-in (Settings → AI → "Auto-Edit"), default off. Built and tested
> locally before anything is committed.

## Origin

Paraphrased ask from Jason Briggs: point at a folder of local video clips
(e.g. his daughter's 7 iPhone videos), give a prompt like "pick the best
4-second moments in each and splice them together with this audio," and
get back a finished video clip. Follow-ups clarified: local files only
(iPhone-recorded, format unconfirmed), audio supplied by the user (or
sourced free — out of scope for v1), and that this fits naturally as a
new capability inside Clarity's existing Projects feature rather than a
separate webapp, since Projects already attaches videos to Gemini and
runs agentic prompts over them.

## Concept

Inside a Project: select local video members, give freeform edit
instructions, optionally attach a music track. Gemini watches the
attached videos and returns a strict JSON **edit plan** (which time
ranges from which videos, in what order, plus audio treatment and output
dimensions). Clarity then **renders a real MP4** natively — no
ffmpeg, no external process, no user install step.

```
Project
└─ edits: Edit[]
     ├─ id, title, prompt, createdAt, costUsd, sourceIds
     ├─ audioPath (user-chosen local track, or null)
     ├─ plan: EditPlan (clips[], audioMode, width, height) — kept for regenerate/debugging
     └─ outputPath → <appDataDir>/edits/<id>/output.mp4
```

Results show in a persistent **Edits** list on the project overview,
parallel to **Reports**: list, open in canvas (native player + plan
breakdown with clickable moments), export, regenerate, delete.

## Design decisions (locked in)

### Rendering approach: native AVFoundation, macOS-only — no ffmpeg, no WebCodecs, no cloud

Several alternatives were seriously evaluated before landing here:

- **Bundle ffmpeg as a Tauri sidecar.** Rejected: adds ~80–150MB per
  platform to the installer (re-downloaded on every auto-update), and
  the codecs actually wanted (libx264/libx265) are GPL — a real
  licensing/legal review item for a distributed binary, not just a size
  cost. Also requires PATH-free bundling, code-signing the sidecar
  binary, and new per-platform CI steps.
- **Require ffmpeg on the user's system PATH.** Rejected: fails silently
  for the target user (a non-technical relative with an iPhone full of
  clips) with no in-app install guidance in v1. Violates the "no
  pathing setup, no installation" requirement outright.
- **WebCodecs in the webview (client-side decode/encode/mux via
  `VideoEncoder`/`mp4-muxer`).** Seriously considered — zero bundle
  size, no licensing, architecturally consistent with how `frames.ts`
  already does canvas-based frame capture in-webview. Set aside in favor
  of AVFoundation once the platform scope narrowed to macOS-only,
  because AVFoundation is strictly more mature (frame-accurate
  composition primitives, hardware encode, orientation/transform
  handling) with the same zero-bundle-size property, at the cost of
  being macOS-only. Worth revisiting for cross-platform.
- **Veo 3 (generative) as the splicer.** Rejected as the core mechanism:
  Veo generates new synthetic video conditioned on references — it does
  not composite real footage. Using it here would mean returning an
  AI-hallucinated approximation of a real child's home video instead of
  the actual recording, which is both inaccurate (drift on faces/
  continuity) and a bad idea to ship for this use case. Gemini's role
  stays as the "creative director" (picking real moments via vision
  understanding); Veo/Lyria are flagged as a **possible future add-on**
  for generated intro/outro cards or a generated score layered on top of
  real spliced footage — never replacing the source footage itself.
- **Cloud/server-side rendering (Shotstack, Creatomate, custom Lambda).**
  Rejected for v1: introduces recurring per-render cost and a backend,
  which conflicts with Clarity's local-first / BYO-API-key / no-server
  architecture, and requires uploading someone's home videos to a third
  party — a privacy consideration worth avoiding by default.
- **EDL/FCPXML export instead of rendering.** Considered as a
  lower-risk alternative (Clarity just emits a timeline file opened in
  iMovie/Premiere/Resolve). Not chosen for v1 because it adds a manual
  "open and export" step that defeats the "just get me a finished clip"
  ask — but is a reasonable fallback shape if AVFoundation rendering
  proves too heavy to maintain.

**Chosen: `AVMutableComposition` + `AVMutableVideoComposition` +
`AVAssetExportSession`**, called from Rust via `objc2` — the same
native-interop pattern `src-tauri/src/lib.rs` already uses for its
WebKit research-view code (`objc2`, `objc2-web-kit`). This is a system
framework: **zero bundle size increase, no licensing bundle, no PATH,
no user install** — genuinely production-grade tooling (the same
framework Final Cut Pro is built on), at the cost of being macOS-only.
Windows support is an explicit non-goal for v1 (see below).

### Full production quality, not a POC

- Frame-accurate composition (not keyframe-constrained stream-copy).
- Correct handling of iPhone portrait `preferredTransform` metadata
  (the classic "sideways video" bug) via per-clip layer instructions.
- Real audio mixing via `AVMutableAudioMix` with deliberate, documented
  volume/fade defaults per `audioMode`, not placeholders.
- Atomic output writes (temp file + rename) so a crashed export never
  leaves a corrupt "successful" file.
- Real validation at both the Gemini-response boundary (reject
  out-of-range/unknown-video clips outright, don't silently clamp) and
  the Rust boundary (re-check every clip's time range against the
  asset's actual duration — the source of truth).
- Cancellable, progress-reporting renders (Tauri events polling
  `exportSession.progress`), matching the UX quality of report
  generation's status callbacks.

### Local-only source videos

Only project members with a local file (`local`/`loom` source types,
which have `localPath`) are eligible as Auto-Edit sources — YouTube and
GitHub members are shown but disabled with a "needs a local file" note.
AVFoundation needs real files on disk; this is a hard requirement, not a
current limitation to relax later.

### Settings-gated, opt-in, default off

Same pattern as `browseEnabled`: a Svelte `writable` store hydrated at
startup, persisted via `plugin-store`, toggled in Settings. Additionally
gated on `isMac` (new shared `$lib/platform.ts` helper, replacing the
ad-hoc `navigator.platform` sniff currently duplicated inline in
`+layout.svelte`) — the toggle doesn't render (or renders disabled with
a "macOS only" note) on Windows.

## Data model

`app/src/lib/projects.ts`:

```ts
export interface EditClip {
  videoId: string;
  startSec: number;
  endSec: number;
  reason: string; // why this moment was chosen — shown in the plan view
}

export interface EditPlan {
  clips: EditClip[];
  audioMode: "replace" | "mix" | "original";
  width: number;
  height: number;
}

export interface Edit {
  id: string;
  title: string;
  prompt: string;
  createdAt: string;
  costUsd: number;
  sourceIds: string[];
  audioPath: string | null;
  outputPath: string;   // relative: edits/<id>/output.mp4
  durationSec: number;
  plan: EditPlan;
}
```

`Project.edits: Edit[]` (defaulted to `[]` for legacy records, same
pattern as other array fields in `listVideos()`/`listProjects()`).
CRUD: `addEdit` / `removeEdit`, mirroring `addReport`/`removeReport`.

## Gemini plan generation

New `generateEditPlan()` in `app/src/lib/gemini.ts`:

- Attaches selected local videos as media (same `fileData` seeding
  pattern as project chat/reports — extracted into a shared helper
  rather than duplicated a third time).
- Passes each video's real duration in context so timestamps can't be
  out of range.
- Strict `responseSchema` JSON output: `title`, `clips[]` (with
  `videoId` enum-constrained to attached sources), `audioMode`, `width`,
  `height`.
- Post-parse validation (throws, does not clamp): every clip references
  an attached video, `0 ≤ startSec < endSec ≤ duration`, at least one
  clip, dimensions in a sane range.
- Cost tracked through the existing `usageFromResponse`/`trackSpend`
  path used everywhere else.

## Native render (Rust / `src-tauri`)

`#[cfg(target_os = "macos")]`-gated commands (non-macOS builds still
expose the commands but return a clear "Auto-Edit requires macOS" error,
so the JS layer gets a real failure rather than a missing-command
panic):

- `render_edit(request) -> RenderResult` — builds the composition,
  video composition (orientation-correct layer instructions, aspect-fit
  into the requested size), audio mix per `audioMode`, exports via
  `AVAssetExportSession` (`AVAssetExportPresetHighestQuality`) to a temp
  path under `<appDataDir>/edits/<id>/`, atomically renamed to
  `output.mp4` on success. Emits `auto-edit-progress` events polling
  `exportSession.progress` every ~250ms.
- `cancel_render(job_id)` — cancels an in-flight export tracked in a
  `Mutex`-guarded managed state (same shape as the existing `TabState`).

Dependencies: `objc2-av-foundation`, `objc2-core-media` added to the
existing macOS-only block in `Cargo.toml` alongside `objc2`,
`objc2-foundation`, `objc2-web-kit` already used for WebKit interop.

## Orchestration layer

`app/src/lib/autoEdit.ts` (mirrors `reports.ts`):

- `generateAndSaveEdit(opts)` — plan generation → pre-render validation
  against local paths → `render_edit` invoke + progress subscription →
  `addEdit` → return the `Edit`.
- `removeEditDir(editId)` — cleanup on delete (mirrors
  `removeReportDir`).
- `exportEdit(edit)` — save-dialog + file copy (no HTML flattening
  needed; the output is already a real MP4).

## UI

- Settings → AI tab: "Auto-Edit (beta)" card, toggle + explanation,
  macOS-only note/disabled state on other platforms.
- Project overview: new "Edits" section below Reports — list, "New
  edit" button, delete.
- `AutoEditModal.svelte` (new component, kept separate from the already
  1,300+ line project detail page): title, instructions textarea
  (`DEFAULT_EDIT_PROMPT`), local-only source checklist (non-local
  members shown disabled with an explanatory note), audio file picker +
  mode select, output-size presets (1920×1080, 1080×1920, 1080×1080).
- Canvas: new `{ kind: "edit"; editId }` state — native `<video>`
  player + plan breakdown (each clip: source name, time range, reason,
  clickable to open that source video seeked to the moment via the
  existing `showVideo()`), export/regenerate/delete actions matching
  the report canvas header.
- Progress: spinner + status line during planning, determinate bar
  during render driven by progress events — matching
  `report-progress`'s visual language.

## Capabilities / config

- Audit `src-tauri/capabilities/default.json` for fs scope covering
  reads of user-picked audio files and writes under `$APPDATA/edits/**`
  used by the export-copy path (render itself is pure Rust, not
  plugin-fs, so it isn't scope-limited the same way).
- No `tauri.conf.json` bundle changes — nothing new is bundled.

## Explicit non-goals for v1

- Windows support (blocked on a Windows-native render path — Media
  Foundation, or revisiting WebCodecs).
- Transitions/crossfades between clips (hard cuts only for v1;
  `AVVideoComposition` supports it later).
- In-app music discovery or generation (user supplies the file; a Veo/
  Lyria-generated intro/outro or score is a possible v2 add-on, never a
  replacement for real source footage).
- Editing/tweaking a plan before render — "regenerate with revised
  instructions" is the v1 iteration loop.

## Build order / progress checklist

- [x] `$lib/platform.ts` shared `isMac` helper + Settings flag
      (`autoEditEnabled`) + Settings "Auto-Edit (beta)" card
- [x] Data model: `Edit`/`EditPlan`/`EditClip` + CRUD in `projects.ts`
- [x] Rust: `render_edit` / `cancel_render` (AVFoundation) + progress
      events — compiles clean; manual verification pending
- [x] Gemini: `generateEditPlan` + schema + validation in `gemini.ts`
- [x] Orchestration: `autoEdit.ts`
- [x] UI: Edits section, `AutoEditModal.svelte`, canvas edit view,
      progress bar
- [x] Capabilities audit (added `fs:allow-copy-file` for MP4 export)
- [ ] Default `autoEditEnabled` to **on** (Jason: "work out of the box")
      — see `docs/studio-roadmap.md` Phase 1
- [ ] `docs/release-notes.md` entry
- [ ] Local end-to-end test with real multi-clip footage + a music
      track before anything is committed to git

## Workflow note

All of the above is built and manually tested locally. **Nothing is
committed or pushed to GitHub until the feature works end-to-end and is
explicitly approved.**
