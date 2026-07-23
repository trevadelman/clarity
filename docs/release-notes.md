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
