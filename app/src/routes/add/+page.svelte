<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fade } from "svelte/transition";
  import { goto } from "$app/navigation";
  import { open } from "@tauri-apps/plugin-dialog";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { UploadCloud, Film } from "lucide-svelte";
  import { addVideo, setThumbnail } from "$lib/videoLibrary";
  import { probeVideo } from "$lib/thumbnail";
  import { toast } from "$lib/toast";

  const VIDEO_EXTS = ["mp4", "mov", "webm"];

  let dragOver = $state(false);
  let busy = $state(false);
  let stage = $state("");

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
    <h1>Add a video</h1>
    <p class="sub">Bring a whiteboard session into your library.</p>
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

<div class="info" in:fade>
  <Film size={16} />
  <p>
    The video is copied into the app's local library. It's uploaded to Gemini
    only when you summarize it, and re-uploaded automatically if that upload
    later expires.
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
