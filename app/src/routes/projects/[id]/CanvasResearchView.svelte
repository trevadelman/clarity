<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { ExternalLink } from "lucide-svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import {
    openResearchView, navigateResearchView, setResearchViewRect,
    closeResearchView, type Rect,
  } from "$lib/researchView";
  import { toast } from "$lib/toast";

  interface Props {
    /** GitHub URL currently shown; changing it navigates the webview. */
    url: string;
  }

  let { url }: Props = $props();

  // Inline variant of ResearchPanel: instead of a fullscreen overlay, the
  // native webview is positioned over this component's own rect, so it
  // renders in normal document flow (like the video player in the canvas).
  let placeholderEl = $state<HTMLElement | null>(null);
  let opened = false;
  let destroyed = false;

  function currentRect(): Rect | null {
    if (!placeholderEl) return null;
    const r = placeholderEl.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  /** Short human label for the current page (path within github.com). */
  const pageLabel = $derived.by(() => {
    try {
      const u = new URL(url);
      return decodeURIComponent(u.pathname.replace(/^\//, "")) + u.search;
    } catch {
      return url;
    }
  });

  async function syncRect() {
    if (!opened) return;
    const rect = currentRect();
    if (rect && rect.width > 0) {
      try {
        await setResearchViewRect(rect);
      } catch {
        // Webview may have been closed externally; ignore.
      }
    }
  }

  // Open on first URL, navigate on subsequent URL changes.
  $effect(() => {
    const target = url;
    const el = placeholderEl;
    (async () => {
      try {
        if (destroyed || !el) return;
        if (!opened) {
          // Freshly-mounted placeholders can measure 0-width for a tick;
          // wait for layout and re-measure instead of bailing.
          let rect = currentRect();
          if (!rect || rect.width === 0) {
            await tick();
            await new Promise(requestAnimationFrame);
            rect = currentRect();
          }
          if (destroyed || !rect || rect.width === 0) return;
          await openResearchView(target, rect);
          opened = true;
          if (destroyed) await closeResearchView();
        } else {
          await navigateResearchView(target);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    })();
  });

  let observer: ResizeObserver | null = null;

  onMount(() => {
    observer = new ResizeObserver(() => void syncRect());
    if (placeholderEl) observer.observe(placeholderEl);
    window.addEventListener("resize", syncRect);
    window.addEventListener("scroll", syncRect, true);
  });

  onDestroy(() => {
    destroyed = true;
    observer?.disconnect();
    window.removeEventListener("resize", syncRect);
    window.removeEventListener("scroll", syncRect, true);
    void closeResearchView();
  });
</script>

<div class="crumb-row">
  <span class="crumb" title={pageLabel}>{pageLabel}</span>
  <button
    class="icon-btn"
    onclick={() => openUrl(url)}
    title="Open in browser"
    aria-label="Open in browser"
  >
    <ExternalLink size={13} />
  </button>
</div>
<!-- Layout reservation only: the native webview renders over this rect. -->
<div class="placeholder" bind:this={placeholderEl}></div>

<style>
  .crumb-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.8rem;
    border-bottom: 1px solid var(--border);
  }
  .crumb {
    flex: 1;
    min-width: 0;
    font-size: 0.76rem;
    font-family: "JetBrains Mono", monospace;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    flex-shrink: 0;
  }
  .icon-btn:hover { background: var(--hover); color: var(--text); }
  .placeholder { height: 68vh; background: var(--bg); }
</style>
