<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { X, ExternalLink, Globe } from "lucide-svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import {
    openResearchView, navigateResearchView, setResearchViewRect,
    closeResearchView, type Rect,
  } from "$lib/researchView";
  import { toast } from "$lib/toast";

  interface Props {
    /** GitHub URL currently shown; changing it navigates the webview. */
    url: string;
    /** Called when the user closes the panel. */
    onClose: () => void;
    /**
     * CSS length reserved on the right for the chat panel. The native webview
     * always renders above HTML, so the research view must shrink out of the
     * chat's way rather than let the chat overlay it.
     */
    rightOffset?: string;
  }

  let { url, onClose, rightOffset = "0px" }: Props = $props();

  // The native child webview cannot be layered under HTML, so this component
  // only reserves screen space: the placeholder div's rect is reported to
  // Rust, which positions the real webview over it. All chrome (header strip)
  // lives OUTSIDE that rect.
  let placeholderEl = $state<HTMLElement | null>(null);
  let opened = false;

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
    (async () => {
      try {
        if (!opened) {
          const rect = currentRect();
          if (!rect || rect.width === 0) return;
          await openResearchView(target, rect);
          opened = true;
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
    observer?.disconnect();
    window.removeEventListener("resize", syncRect);
    window.removeEventListener("scroll", syncRect, true);
    void closeResearchView();
  });
</script>

<aside class="research" style:right={rightOffset}>
  <header class="research-head">
    <span class="glyph"><Globe size={16} /></span>
    <div class="head-text">
      <strong>Live view</strong>
      <span class="crumb" title={pageLabel}>{pageLabel}</span>
    </div>
    <button
      class="icon-btn"
      onclick={() => openUrl(url)}
      title="Open in browser"
      aria-label="Open in browser"
    >
      <ExternalLink size={14} />
    </button>
    <button class="icon-btn" onclick={onClose} title="Close research view" aria-label="Close research view">
      <X size={15} />
    </button>
  </header>
  <!-- Layout reservation only: the native webview renders over this rect. -->
  <div class="placeholder" bind:this={placeholderEl}></div>
</aside>

<style>
  .research {
    /* Main-content overlay: starts after the nav rail (--sidebar-w from the
       layout) and leaves room on the right for the chat via rightOffset. */
    position: fixed;
    top: 0;
    left: var(--sidebar-w, 0px);
    right: 0;
    bottom: 0;
    border-left: 1px solid var(--border);
    z-index: 500;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    transition: right 0.2s ease, left 0.2s ease;
  }
  .research-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    /* Match the chat panel's header padding so the two align. */
    padding: 2.6rem 1rem 0.8rem;
    border-bottom: 1px solid var(--border);
  }
  .glyph { display: inline-flex; color: var(--accent); flex-shrink: 0; }
  .head-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.25;
  }
  .crumb {
    min-width: 0;
    font-size: 0.78rem;
    font-family: "JetBrains Mono", monospace;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    flex-shrink: 0;
  }
  .icon-btn:hover { background: var(--hover); color: var(--text); }
  .placeholder { flex: 1; background: var(--bg); }
</style>
