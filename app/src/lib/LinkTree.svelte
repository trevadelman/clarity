<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import {
    Folder, FolderOpen, ChevronRight, Plus, Trash2, Star, Globe, Link as LinkIcon,
  } from "lucide-svelte";
  import {
    listBookmarks, addLink, addFolder, removeBookmark, updateBookmark,
    normalizeUrl, faviconUrl, type BookmarkNode,
  } from "./bookmarks";
  import { selectedLink } from "./browseState";
  import { toast } from "./toast";

  let nodes = $state<BookmarkNode[]>([]);
  let expanded = $state<Record<string, boolean>>({});
  let selectedId = $state<string | null>(null);

  // Add form state: which parent it targets (null = top level) and kind.
  let addOpen = $state(false);
  let addKind = $state<"link" | "folder">("link");
  let addParentId = $state<string | null>(null);
  let addLabel = $state("");
  let addUrl = $state("");

  const favorites = $derived(nodes.filter((n) => n.kind === "link" && n.favorite));

  function childrenOf(parentId: string | null): BookmarkNode[] {
    return nodes.filter((n) => n.parentId === parentId);
  }

  async function refresh() {
    nodes = await listBookmarks();
  }

  onMount(refresh);

  function openAdd(kind: "link" | "folder", parentId: string | null) {
    addOpen = true;
    addKind = kind;
    addParentId = parentId;
    addLabel = "";
    addUrl = "";
  }

  async function submitAdd() {
    try {
      if (addKind === "folder") {
        if (!addLabel.trim()) return;
        await addFolder(addLabel, addParentId);
        if (addParentId) expanded[addParentId] = true;
      } else {
        const url = normalizeUrl(addUrl);
        if (!url) {
          toast.error("That doesn't look like a valid web address.");
          return;
        }
        await addLink(addLabel || hostOf(url), url, addParentId);
        if (addParentId) expanded[addParentId] = true;
      }
      addOpen = false;
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }

  async function remove(node: BookmarkNode) {
    await removeBookmark(node.id);
    if (selectedId === node.id) selectedId = null;
    await refresh();
  }

  async function toggleFavorite(node: BookmarkNode) {
    await updateBookmark(node.id, { favorite: !node.favorite });
    await refresh();
  }

  function select(node: BookmarkNode) {
    if (node.kind === "folder") {
      expanded[node.id] = !expanded[node.id];
      return;
    }
    selectedId = node.id;
    selectedLink.set(node);
    goto("/browse");
  }
</script>

<div class="tree">
  {#if favorites.length > 0}
    <div class="fav-row">
      {#each favorites as f (f.id)}
        <button
          class="fav"
          class:sel={selectedId === f.id}
          onclick={() => select(f)}
          title={f.label}
        >
          {#if f.url}
            <img src={faviconUrl(f.url)} alt="" />
          {:else}
            <Globe size={16} />
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  <div class="rows">
    {#each childrenOf(null) as node (node.id)}
      {@render row(node, 0)}
    {/each}
  </div>

  {#snippet row(node: BookmarkNode, depth: number)}
    <div
      class="row"
      class:sel={selectedId === node.id}
      style:padding-left={`${0.4 + depth * 0.85}rem`}
    >
      <button class="row-main" onclick={() => select(node)} title={node.kind === "link" ? node.url : node.label}>
        {#if node.kind === "folder"}
          <span class="chev" class:open={expanded[node.id]}><ChevronRight size={12} /></span>
          {#if expanded[node.id]}<FolderOpen size={14} />{:else}<Folder size={14} />{/if}
        {:else if node.url}
          <img class="ico" src={faviconUrl(node.url)} alt="" />
        {:else}
          <LinkIcon size={13} />
        {/if}
        <span class="label">{node.label}</span>
      </button>
      <span class="row-actions">
        {#if node.kind === "link"}
          <button class="mini" onclick={() => toggleFavorite(node)} title={node.favorite ? "Unpin favorite" : "Pin to favorites"}>
            <Star size={12} fill={node.favorite ? "currentColor" : "none"} />
          </button>
        {:else}
          <button class="mini" onclick={() => openAdd("link", node.id)} title="Add link inside">
            <Plus size={12} />
          </button>
        {/if}
        <button class="mini danger" onclick={() => remove(node)} title="Delete">
          <Trash2 size={12} />
        </button>
      </span>
    </div>
    {#if node.kind === "folder" && expanded[node.id]}
      {#each childrenOf(node.id) as child (child.id)}
        {@render row(child, depth + 1)}
      {/each}
    {/if}
  {/snippet}

  {#if addOpen}
    <form class="add-form" onsubmit={(e) => { e.preventDefault(); submitAdd(); }}>
      {#if addKind === "link"}
        <!-- svelte-ignore a11y_autofocus -->
        <input type="text" placeholder="URL (e.g. xeto.dev)" bind:value={addUrl} autofocus />
        <input type="text" placeholder="Label (optional)" bind:value={addLabel} />
      {:else}
        <!-- svelte-ignore a11y_autofocus -->
        <input type="text" placeholder="Folder name" bind:value={addLabel} autofocus />
      {/if}
      <div class="add-actions">
        <button type="submit" class="add-save">Add</button>
        <button type="button" class="add-cancel" onclick={() => (addOpen = false)}>Cancel</button>
      </div>
    </form>
  {:else}
    <div class="add-row">
      <button class="add-btn" onclick={() => openAdd("link", null)}>
        <Plus size={13} /> Link
      </button>
      <button class="add-btn" onclick={() => openAdd("folder", null)}>
        <Plus size={13} /> Folder
      </button>
    </div>
  {/if}
</div>

<style>
  .tree {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-height: 0;
    overflow-y: auto;
    flex: 1;
  }

  .fav-row {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(38px, 1fr));
    gap: 0.35rem;
  }
  .fav {
    display: grid;
    place-items: center;
    aspect-ratio: 1;
    border: 1px solid var(--sidebar-border);
    border-radius: var(--radius-sm);
    background: var(--sidebar-hover);
    color: var(--sidebar-text);
    cursor: pointer;
    padding: 0;
    transition: background 0.15s, border-color 0.15s;
  }
  .fav:hover { background: rgba(255, 255, 255, 0.12); }
  .fav.sel { border-color: var(--accent); }
  .fav img { width: 18px; height: 18px; border-radius: 4px; }

  .rows { display: flex; flex-direction: column; }

  .row {
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
    padding-right: 0.25rem;
  }
  .row:hover { background: var(--sidebar-hover); }
  .row.sel { background: rgba(109, 94, 252, 0.16); }
  .row.sel .row-main { color: var(--sidebar-text-bright); }

  .row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.45rem;
    border: none;
    background: transparent;
    color: var(--sidebar-text);
    font-size: 0.85rem;
    font-family: inherit;
    cursor: pointer;
    padding: 0.4rem 0.2rem;
    text-align: left;
  }
  .row-main:hover { color: var(--sidebar-text-bright); }
  .chev { display: inline-flex; transition: transform 0.12s; flex-shrink: 0; }
  .chev.open { transform: rotate(90deg); }
  .ico { width: 15px; height: 15px; border-radius: 3px; flex-shrink: 0; }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-actions {
    display: none;
    align-items: center;
    gap: 0.1rem;
    flex-shrink: 0;
  }
  .row:hover .row-actions { display: inline-flex; }
  .mini {
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--sidebar-text);
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 5px;
    opacity: 0.75;
  }
  .mini:hover { opacity: 1; background: rgba(255, 255, 255, 0.1); }
  .mini.danger:hover { color: #f2555a; }

  .add-row { display: flex; gap: 0.35rem; }
  .add-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    border: 1px dashed var(--sidebar-border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--sidebar-text);
    font-size: 0.78rem;
    font-family: inherit;
    cursor: pointer;
    padding: 0.3rem 0.55rem;
  }
  .add-btn:hover { background: var(--sidebar-hover); color: var(--sidebar-text-bright); }

  .add-form { display: flex; flex-direction: column; gap: 0.35rem; }
  .add-form input {
    border: 1px solid var(--sidebar-border);
    border-radius: var(--radius-sm);
    background: rgba(255, 255, 255, 0.05);
    color: var(--sidebar-text-bright);
    font-size: 0.82rem;
    font-family: inherit;
    padding: 0.35rem 0.5rem;
    outline: none;
  }
  .add-form input:focus { border-color: var(--accent); }
  .add-actions { display: flex; gap: 0.35rem; }
  .add-save, .add-cancel {
    border: none;
    border-radius: var(--radius-sm);
    font-size: 0.78rem;
    font-family: inherit;
    cursor: pointer;
    padding: 0.3rem 0.6rem;
  }
  .add-save { background: var(--accent); color: #fff; }
  .add-save:hover { background: var(--accent-hover); }
  .add-cancel { background: transparent; color: var(--sidebar-text); }
  .add-cancel:hover { color: var(--sidebar-text-bright); }
</style>
