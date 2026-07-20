<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fade } from "svelte/transition";
  import { goto } from "$app/navigation";
  import { open } from "@tauri-apps/plugin-dialog";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { UploadCloud, Film, Link } from "lucide-svelte";
  import {
    addVideo, addYouTubeVideo, addLoomVideo, addGitHubRepo,
    parseYouTubeId, parseLoomId, setThumbnail,
  } from "$lib/videoLibrary";
  import { parseGitHubRepo } from "$lib/github";
  import { probeVideo } from "$lib/thumbnail";
  import { loadGitHubToken } from "$lib/settings";
  import { toast } from "$lib/toast";

  const VIDEO_EXTS = ["mp4", "mov", "webm"];

  let dragOver = $state(false);
  let busy = $state(false);
  let stage = $state("");
  let ytUrl = $state("");
  let ytBusy = $state(false);
  let ytStage = $state("");

  const linkKind = $derived(
    parseYouTubeId(ytUrl)
      ? "youtube"
      : parseLoomId(ytUrl)
        ? "loom"
        : parseGitHubRepo(ytUrl)
          ? "github"
          : null
  );
  const ytValid = $derived(linkKind !== null);

  let unlistenDrop: (() => void) | null = null;

  onMount(async () => {
    const webview = getCurrentWebview();
    unlistenDrop = await webview.onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        dragOver = true;
      } else if (event.payload.type === "drop") {
        dragOver = false;
        const path = event.payload.paths?.[0];
        if (path) handlePath(path);
      } else {
        dragOver = false;
      }
    });
  });

  onDestroy(() => unlistenDrop?.());

  async function handlePath(path: string) {
    const ext = (path.split(".").pop() ?? "").toLowerCase();
    if (!VIDEO_EXTS.includes(ext)) {
      toast.error(`Unsupported file type: .${ext}. Use mp4, mov, or webm.`);
      return;
    }
    busy = true;
    try {
      stage = "Copying into your library…";
      const record = await addVideo(path);
      stage = "Generating thumbnail…";
      const probe = await probeVideo(record.localPath);
      await setThumbnail(record, probe.thumbnail, probe.durationSec);
      toast.success("Video added to your library.");
      await goto(`/video/${record.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      busy = false;
      stage = "";
    }
  }

  async function handleAddLink() {
    if (!ytValid || ytBusy) return;
    ytBusy = true;
    try {
      if (linkKind === "github") {
        ytStage = "Fetching repo info…";
        const token = await loadGitHubToken();
        const record = await addGitHubRepo(ytUrl, token);
        toast.success("GitHub repo added to your library.");
        await goto(`/video/${record.id}`);
      } else if (linkKind === "loom") {
        ytStage = "Fetching from Loom…";
        const record = await addLoomVideo(ytUrl, (downloaded, total) => {
          const pct = total ? ` ${Math.round((downloaded / total) * 100)}%` : "";
          ytStage = `Downloading from Loom…${pct}`;
        });
        ytStage = "Generating thumbnail…";
        const probe = await probeVideo(record.localPath);
        await setThumbnail(record, probe.thumbnail, probe.durationSec ?? record.durationSec);
        toast.success("Loom video added to your library.");
        await goto(`/video/${record.id}`);
      } else {
        const record = await addYouTubeVideo(ytUrl);
        toast.success("YouTube video added to your library.");
        await goto(`/video/${record.id}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      ytBusy = false;
      ytStage = "";
    }
  }

  async function handleChoose() {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Video", extensions: VIDEO_EXTS }],
    });
    if (typeof selected === "string") handlePath(selected);
  }
</script>

<header class="page-head">
  <div>
    <h1>Add a source</h1>
    <p class="sub">Bring a video, Loom, YouTube link, or GitHub repo into your library.</p>
  </div>
</header>

<button
  type="button"
  class="dropzone"
  class:over={dragOver}
  disabled={busy}
  onclick={handleChoose}
>
  {#if busy}
    <div class="spinner"></div>
    <span class="big">{stage}</span>
  {:else}
    <span class="icon" class:bob={dragOver}><UploadCloud size={40} /></span>
    <span class="big">Drag &amp; drop a video here</span>
    <span class="sub">or click to choose · mp4 · mov · webm</span>
  {/if}
</button>

<div class="or-divider"><span>or</span></div>

<form class="yt-row" onsubmit={(e) => { e.preventDefault(); handleAddLink(); }}>
  <span class="yt-icon"><Link size={18} /></span>
  <input
    type="url"
    placeholder="Paste a YouTube, Loom, or GitHub repo link…"
    bind:value={ytUrl}
    disabled={ytBusy}
  />
  <button type="submit" class="yt-btn" disabled={!ytValid || ytBusy}>
    {#if ytBusy}<span class="mini-spin"></span> {ytStage || "Adding…"}{:else}Add{/if}
  </button>
</form>
{#if ytUrl.trim() && !ytValid}
  <p class="yt-hint">Enter a full YouTube, Loom, or GitHub URL, e.g. https://www.youtube.com/watch?v=… or https://github.com/owner/repo</p>
{/if}

<div class="info" in:fade>
  <Film size={16} />
  <p>
    Local files are copied into the app's library and uploaded to Gemini only
    when you summarize them. YouTube videos are analyzed straight from their
    URL — nothing is downloaded. Loom videos are downloaded into your library
    and behave like local files. GitHub repos become activity trackers: browse
    recent commits and generate AI digests of what changed (add a token in
    Settings for private repos).
  </p>
</div>

<style>
  .page-head { margin-bottom: 1.25rem; }
  h1 { font-size: 1.5rem; margin: 0; letter-spacing: -0.01em; }
  .sub { color: var(--text-dim); font-size: 0.9rem; margin: 0.2rem 0 0; }

  .dropzone {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 3.5rem 1rem;
    border: 2px dashed var(--border);
    border-radius: 16px;
    background: var(--surface);
    color: var(--text);
    text-align: center;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.18s, background 0.18s, transform 0.18s;
  }
  .dropzone:hover:not(:disabled) { border-color: var(--accent); }
  .dropzone.over {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--surface));
    transform: scale(1.01);
  }
  .dropzone:disabled { cursor: progress; }
  .icon { color: var(--accent); transition: transform 0.2s; }
  .icon.bob { transform: translateY(-4px); }
  .big { font-size: 1.05rem; font-weight: 600; }

  .info {
    display: flex;
    gap: 0.6rem;
    align-items: flex-start;
    margin-top: 1.25rem;
    padding: 0.85rem 1rem;
    border-radius: var(--radius);
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-size: 0.85rem;
  }
  .info :global(svg) { color: var(--accent); flex-shrink: 0; margin-top: 2px; }
  .info p { margin: 0; line-height: 1.5; }

  .or-divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 1.1rem 0;
    color: var(--text-dim);
    font-size: 0.8rem;
  }
  .or-divider::before,
  .or-divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .yt-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    transition: border-color 0.15s;
  }
  .yt-row:focus-within { border-color: var(--accent); }
  .yt-icon { color: #ff0033; display: inline-flex; flex-shrink: 0; }
  .yt-row input {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 0.92rem;
    font-family: inherit;
    outline: none;
  }
  .yt-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.45rem 0.95rem;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    font-size: 0.88rem;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
  }
  .yt-btn:hover:not(:disabled) { background: var(--accent-hover); }
  .yt-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .yt-hint { margin: 0.4rem 0 0; font-size: 0.8rem; color: var(--text-dim); }

  .mini-spin {
    width: 13px;
    height: 13px;
    border: 2px solid rgba(255, 255, 255, 0.4);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  .spinner {
    width: 30px;
    height: 30px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
