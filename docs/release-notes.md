# Clarity v2.1.0

Clarity 2.1 brings **Projects** to life with generated reports, an AI
**Studio** for creating images and video clips, and opt-in **Auto-Edit**
video rendering.

## Highlights

- **Projects & reports** — group sources into project workspaces and
  generate agentic research reports: the AI reads your sources (including
  live repo research with screenshots), proposes reports from chat, and
  exports self-contained HTML.
- **Studio (macOS)** — create inside a project:
  - **Generate images** from a prompt with Gemini's image model, refine
    them on a canvas, and keep them in your library.
  - **Animate images into video** — turn any generated image into an
    ~8-second Veo clip from a motion prompt, from the project canvas or
    the image's own page.
  - **Video model tiers** — pick Veo Lite / Fast / Standard in
    *Settings → AI*, with per-clip cost shown up front. Lite is the
    default; all Gemini/Veo spend feeds the existing spend tracker.
- **Auto-Edit (opt-in beta, macOS only)** — enable it in
  *Settings → AI* to add an **Edits** section to every project:
  - Give freeform instructions ("pick the best 4-second moment from
    each clip"), pick the project's local videos, and optionally attach
    a music track (replace or mix under the original audio).
  - Gemini watches the videos and plans the edit; Clarity renders a
    real MP4 natively via AVFoundation — no ffmpeg, no installs,
    nothing added to the app bundle.
  - Review the finished video with its clip-by-clip plan (each moment
    links back to its source video), export the MP4, or delete and
    regenerate with revised instructions.

## Auto-update

- If you're on a prior build, this installs automatically via
  *Settings → Check for updates* (or the update banner). Studio and
  Auto-Edit are macOS-only; the Windows experience is unchanged.

---

# Clarity v2.0.0

Clarity 2.0 introduces **Browse mode** — an opt-in beta that turns Clarity
into a focused research browser alongside your library.

## Highlights

- **Browse mode (opt-in beta)** — enable it in *Settings → Browser* to add
  a Browse rail to the sidebar:
  - A curated **link tree** of the sites you work in, with folders and
    favicons.
  - **Persistent browser tabs** — real native webviews that stay signed
    in across sessions and switch instantly.
  - **Sign in with popups** — OAuth flows (Google, GitHub, Microsoft…)
    open in proper popup windows that share your session.
  - **AI that reads the page** — chat about the page you're viewing; the
    assistant can read and navigate your open tabs.
- **Live research view** — GitHub repo pages open in an embedded research
  panel with AI assistance.
- **Clear browsing data** — one click in Settings signs you out of every
  site (cookies, storage, caches) without touching your library or keys.

## Fixed & improved

- **Windows:** fixed an app-wide freeze when opening browser views
  (webview creation now runs on the UI thread, as WebView2 requires).
- Browser-grade user agent on embedded views — no more "unsupported
  browser" banners on Google and friends.
- Hard reload purges stale service workers and caches.
- Diagnostic logging to a local log file, and an **Open console** button
  in Settings for debugging shipped builds.

## Auto-update

- If you're on a prior build, this installs automatically via
  *Settings → Check for updates* (or the update banner). Browse mode is
  disabled by default — your current workflow is unchanged until you
  opt in.
