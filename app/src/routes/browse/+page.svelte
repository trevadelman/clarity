<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    Globe, ExternalLink, X, ArrowLeft, ArrowRight, RotateCw,
  } from "lucide-svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { selectedLink } from "$lib/browseState";
  import { faviconUrl, type BookmarkNode } from "$lib/bookmarks";
  import { openTab, setTabRect, closeTab, hideAllTabs, tabHistory } from "$lib/tabs";
  import type { Rect } from "$lib/researchView";
  import { toast } from "$lib/toast";

  // The native child webview renders above all HTML, so this page only
  // reserves screen space: the placeholder div's rect is reported to Rust,
  // which positions the active tab webview over it (same pattern as the
  // repo research view).
  let placeholderEl = $state<HTMLElement | null>(null);
  let active = $state<BookmarkNode | null>(null);

  function currentRect(): Rect | null {
    if (!placeholderEl) return null;
    const r = placeholderEl.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  async function syncRect() {
    if (!active) return;
    const rect = currentRect();
    if (rect && rect.width > 0) {
      try {
        await setTabRect(rect);
      } catch {
        // Tab may have been evicted; ignore.
      }
    }
  }

  // React to tree selections: open (or re-show) that link's tab.
  $effect(() => {
    const link = $selectedLink;
    if (!link?.url) return;
    (async () => {
      const rect = currentRect();
      if (!rect || rect.width === 0) return;
      try {
        await openTab(link.id, link.url!, rect);
        active = link;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    })();
  });

  async function closeActive() {
    if (!active) return;
    try {
      await closeTab(active.id);
    } catch {
      // Already gone; fine.
    }
    active = null;
    selectedLink.set(null);
  }

  async function history(action: "back" | "forward" | "reload") {
    if (!active) return;
    try {
      await tabHistory(active.id, action);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  let observer: ResizeObserver | null = null;

  onMount(() => {
    observer = new ResizeObserver(() => void syncRect());
    if (placeholderEl) observer.observe(placeholderEl);
    window.addEventListener("resize", syncRect);
  });

  onDestroy(() => {
    observer?.disconnect();
    window.removeEventListener("resize", syncRect);
    // Hide (don't destroy) so page state survives a round trip to Library.
    void hideAllTabs();
  });
</script>

<div class="surface">
  <header class="chrome">
    <div class="nav-btns">
      <button class="icon-btn" onclick={() => history("back")} disabled={!active} title="Back" aria-label="Back">
        <ArrowLeft size={14} />
      </button>
      <button class="icon-btn" onclick={() => history("forward")} disabled={!active} title="Forward" aria-label="Forward">
        <ArrowRight size={14} />
      </button>
      <button class="icon-btn" onclick={() => history("reload")} disabled={!active} title="Reload" aria-label="Reload">
        <RotateCw size={13} />
      </button>
    </div>
    {#if active?.url}
      <img class="ico" src={faviconUrl(active.url)} alt="" />
      <div class="head-text">
        <strong>{active.label}</strong>
        <span class="crumb" title={active.url}>{active.url}</span>
      </div>
      <button class="icon-btn" onclick={() => openUrl(active!.url!)} title="Open in browser" aria-label="Open in browser">
        <ExternalLink size={14} />
      </button>
      <button class="icon-btn" onclick={closeActive} title="Close tab" aria-label="Close tab">
        <X size={15} />
      </button>
    {:else}
      <span class="glyph"><Globe size={15} /></span>
      <div class="head-text"><strong>Browse</strong></div>
    {/if}
  </header>

  <!-- Layout reservation only: the active tab webview renders over this. -->
  <div class="placeholder" bind:this={placeholderEl}>
    {#if !active}
      <div class="empty">
        <span class="empty-icon"><Globe size={40} /></span>
        <h2>Nothing open</h2>
        <p>Pick a link from the sidebar tree, or add one to get started.</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .surface {
    /* Fill the content area edge-to-edge (the layout adds padding we undo). */
    margin: -2.75rem -2.25rem -2rem;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .chrome {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 2.4rem 1rem 0.65rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .nav-btns { display: inline-flex; gap: 0.25rem; }
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
  .icon-btn:hover:not(:disabled) { background: var(--hover); color: var(--text); }
  .icon-btn:disabled { opacity: 0.4; cursor: default; }
  .ico { width: 16px; height: 16px; border-radius: 4px; flex-shrink: 0; }
  .glyph { display: inline-flex; color: var(--accent); flex-shrink: 0; }
  .head-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.25;
    font-size: 0.85rem;
  }
  .crumb {
    min-width: 0;
    font-size: 0.74rem;
    font-family: "JetBrains Mono", monospace;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .placeholder {
    flex: 1;
    background: var(--bg);
    display: grid;
    place-items: center;
  }
  .empty { text-align: center; color: var(--text-dim); }
  .empty-icon { color: var(--accent); display: inline-flex; }
  .empty h2 { margin: 0.7rem 0 0.2rem; color: var(--text); font-size: 1.1rem; }
  .empty p { font-size: 0.88rem; margin: 0.3rem 0 0; }
</style>
