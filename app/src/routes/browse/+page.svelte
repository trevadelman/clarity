<script lang="ts">
  import { Globe, ExternalLink } from "lucide-svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { selectedLink } from "$lib/browseState";
  import { faviconUrl } from "$lib/bookmarks";
</script>

<div class="browse">
  {#if $selectedLink?.url}
    <!-- Phase 2 replaces this card with the persistent tab webview surface. -->
    <div class="placeholder">
      <img class="big-ico" src={faviconUrl($selectedLink.url, 128)} alt="" />
      <h2>{$selectedLink.label}</h2>
      <p class="url">{$selectedLink.url}</p>
      <p class="note">
        The in-app browsing surface lands in Phase 2 — for now this opens
        externally.
      </p>
      <button class="btn primary" onclick={() => openUrl($selectedLink!.url!)}>
        <ExternalLink size={15} /> Open in browser
      </button>
    </div>
  {:else}
    <div class="placeholder">
      <span class="empty-icon"><Globe size={42} /></span>
      <h2>Browse</h2>
      <p class="note">Pick a link from the sidebar tree, or add one to get started.</p>
    </div>
  {/if}
</div>

<style>
  .browse {
    display: grid;
    place-items: center;
    min-height: 70vh;
  }
  .placeholder {
    text-align: center;
    color: var(--text-dim);
    border: 1px dashed var(--border);
    border-radius: 16px;
    background: var(--surface);
    padding: 3rem 3.5rem;
    max-width: 480px;
  }
  .big-ico { width: 48px; height: 48px; border-radius: 10px; }
  .empty-icon { color: var(--accent); display: inline-flex; }
  h2 { margin: 0.8rem 0 0.2rem; color: var(--text); font-size: 1.15rem; }
  .url {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.78rem;
    margin: 0.2rem 0 0;
    word-break: break-all;
  }
  .note { font-size: 0.88rem; margin: 0.8rem 0 1.2rem; }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.55rem 0.95rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-size: 0.92rem;
    font-family: inherit;
    cursor: pointer;
  }
  .btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .btn.primary:hover { background: var(--accent-hover); }
</style>
