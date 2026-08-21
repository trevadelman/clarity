# Studio — Generative Images & Video (Projects add-on)

> **Status: Phases 1-3 built (Phase 3 awaiting manual test pass).** Extends
> Projects with generative capabilities: standalone image generation,
> image-to-video generation (Veo), and a reorganized "Studio" project
> overview. Built and tested locally before anything is committed.

## Origin

Paraphrased ask from Jason Briggs: generate an image from a prompt at a
chosen resolution (e.g. Instagram square, "a pink flamingo"), then turn
that image into a ~10-second video clip, and — because generated clips
live in the same library as uploaded footage — splice generated and real
videos together with the existing Auto-Edit pipeline. Also: Auto-Edit
should be **on by default** out of the box.

## Concept

```
prompt ──► generated image (library entry)
                │
                ▼
        image + motion prompt ──► generated video clip (library entry)
                                        │
                                        ▼
                        Auto-Edit sources (unchanged pipeline)
```

The elegant part: once a generated video is saved as a normal
`VideoRecord` with a `localPath`, everything downstream — Gemini plan
generation, `render_edit`, the canvas player — already works unmodified.

## What already exists

- **Image generation**: `generateDiagram()` in `gemini.ts` already calls
  `gemini-3.1-flash-image` and produces PNGs. The standalone flow reuses
  this call with a free-form prompt instead of the fixed diagram prompt.
- **Video generation SDK support**: the installed `@google/genai`
  (v2.8.0) exposes `ai.models.generateVideos()` (Veo models,
  image-to-video capable). It returns a long-running
  `GenerateVideosOperation` you poll — the same async shape as the
  Files-API `uploadAndWait` pattern already in `gemini.ts`.
- **Library storage**: `addVideo()`-style byte-copy into
  `<appDataDir>/videos/` + a `VideoRecord`.

Note: Jason's pasted curl example uses `gemini-omni-flash-preview` via a
`/v1beta/interactions` endpoint — a different/newer unified API than
`generateVideos()`+Veo in the SDK. Phase 0 decides which is real/stable.

## Phases

### Phase 0 — API validation spike (gates everything)

- [x] Model availability confirmed via `scripts/veo-spike.mjs` (free
      list-models call). Available to our key:
      - `gemini-omni-flash-preview` — `generateContent` (standard
        method; the `interactions` endpoint isn't required)
      - `veo-3.1-generate-preview` / `-fast-` / `-lite-` — all via
        `predictLongRunning` (matches the SDK's `generateVideos()`
        poll-an-operation pattern)
- [x] One real generation call (`scripts/veo-gen-test.mjs`,
      `veo-3.1-lite`): text-to-video succeeded in **~84s**, output is a
      **4.5MB 8s MP4** delivered as a Files-API download URI
      (`files/<id>:download?alt=media`). Response shape:
      `response.generateVideoResponse.generatedSamples[0].video.uri`.
      Verified playable. **Decision: `veo-3.1-lite` is the default
      model; the higher-end `-fast`/full models become a Settings → AI
      model picker.**
- [x] Image-to-video input format confirmed (`scripts/veo-i2v-test.mjs`):
      **inline base64** (`instances[0].image.bytesBase64Encoded` +
      `mimeType`) works directly — no Files API upload needed. Test call
      with a Phase-1 generated PNG finished in **~38s**, 10.9MB 8s MP4.
- [x] Official Veo 3.1 pricing (paid tier, per second, with audio —
      poll response carries no usage metadata, so spend tracking uses
      these published rates):
      | Model | 720p | 1080p | 4k |
      |---|---|---|---|
      | Standard | $0.40 | $0.40 | $0.60 |
      | Fast | $0.10 | $0.12 | $0.30 |
      | **Lite (default)** | **$0.05** | $0.08 | not supported |
      An 8s lite clip at 720p ≈ **$0.40**; standard ≈ $3.20.

### Phase 1 — Auto-Edit default-on + standalone image generation ✅

- [x] Flip `autoEditEnabled` default to `true` in `settings.ts`
      (safe: feature is `isMac`-gated regardless of the flag).
- [x] "Generate Image" flow: `generateImage()` in `gemini.ts` + a
      "Generate an image with AI" card on the Add page with prompt,
      aspect presets (1:1 / 9:16 / 16:9), cost hint, and API-key gating.
- [x] New library `sourceType: "image"` (simpler than the planned
      `"generated-image"`); `addGeneratedImage()` saves the PNG via
      `saveMedia` — the image is its own thumbnail, `localPath` points at
      the stored PNG (ready for Phase 2 image-to-video), and the prompt
      is kept in `customInstructions`. Detail page renders the image in
      place of the player, hides summarize/diagram/highlight controls,
      and shows a "Generated with AI" badge. Project chips/pickers use an
      image icon.
- [x] Cost tracked through the existing spend path
      (`IMAGE_COST_PER_IMAGE`, stored on `summaryCostUsd`).
- [x] Manual test pass: happy path, all aspect ratios, empty-prompt /
      missing-key guards, library grid, project membership, deletion.

### Phase 2 — Image-to-video generation ✅

- [x] "Animate this image" box on the generated-image detail page:
      motion-description prompt, cost/time hint shown *before*
      generation (~$0.40, 1-2 min), API-key gating.
- [x] `generateVideoFromImage()` in `gemini.ts`: REST
      `predictLongRunning` on `veo-3.1-lite-generate-preview` with the
      image inline as base64, 5s polling with elapsed-time status
      callbacks (10-min timeout), MP4 download, spend tracked via
      `VIDEO_COST_PER_CLIP` ($0.05/s × 8s).
- [x] `addGeneratedVideo()` in `videoLibrary.ts`: saves the MP4 into
      `<appDataDir>/videos/` as a normal local `VideoRecord` (tagged
      `generated`, motion prompt in `customInstructions`) — instantly
      usable everywhere, including Auto-Edit.
- [x] Auto-navigate to the new clip after generation (required fixing
      same-route `[id]` navigation: record now reloads on param change
      via `$effect`, not just `onMount`).
- [x] Manual test pass: image → animated 8s clip in the library,
      playable, navigation works.

### Phase 3 — Studio UX reorganization

- [x] Project overview adapts to content: "Reports" section hidden when
      the project has no repos/reports/run-in-flight; Edits + generation
      grouped under a collapsible "Studio" section header, ordered first
      when `project.focus === "studio"`.
- [x] Create-project nudge: optional Research/Studio focus choice at
      creation, stored as `Project.focus` — emphasis/ordering only, not
      a hard type.
- [x] Generated images/videos get distinct icons (image icon; Sparkles
      for generated clips).
- [x] **Member tree** (went beyond chips): the chip row was replaced by
      a sticky "Sources" sidebar to the left of the canvas — collapsible
      folders by asset type (Repos / Videos / Generated) with counts,
      hover-remove, active highlight, and the add-from-library picker at
      the bottom.
- [x] Image members render in the canvas via a dedicated `image` canvas
      kind (previously fed to a `<video>` element and showed nothing);
      images excluded from `videoMembers` so they're never uploaded as
      chat/report "videos".
- [x] Library-style source controls on the canvas head: inline rename,
      size/duration/MIME metadata, open-in-library link, and
      delete-from-library with confirm.

### Phase 4 — In-studio generation pipeline (bonus, built)

- [x] "New image" button in the Studio section: prompt + aspect modal;
      the generated image is auto-added to the project's sources and
      opened in the canvas.
- [x] "Animate this image" box in the image canvas: motion prompt →
      Veo clip, probed for real duration + thumbnail (`probeVideo` +
      `setThumbnail`), auto-added to sources, canvas switches to it —
      immediately usable in Auto-Edit.
- [x] Generated-clip duration fix: `addGeneratedVideo` callers now probe
      the MP4; existing null-duration records self-heal when opened on
      the video detail page (Auto-Edit validates plan timestamps against
      `durationSec`).

## Explicit non-goals

- A separate "Studio project" type/route — one `Project` type, adaptive
  UI only.
- Video-to-video restyling or generative editing of real footage
  (Auto-Edit remains a compositor of real sources; see the Veo
  discussion in `auto-edit-roadmap.md`).
- In-app music generation (unchanged from auto-edit non-goals).

## Workflow note

All of the above is built and manually tested locally. **Nothing is
committed or pushed to GitHub until the feature works end-to-end and is
explicitly approved.**
