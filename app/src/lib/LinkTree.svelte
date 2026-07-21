<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import {
    Folder, FolderOpen, ChevronRight, Plus, Trash2, Star, Globe, Link as LinkIcon,
    FolderPlus,
  } from "lucide-svelte";
  import {
    listBookmarks, addLink, addFolder, removeBookmark, updateBookmark,
    moveBookmark, normalizeUrl, faviconUrl, type BookmarkNode,
  } from "./bookmarks";
  import { selectedLink } from "./browseState";
  import { toast } from "./toast";

  interface Props {
    /** Collapsed rail: show only a vertical column of favorite favicons. */
    collapsed?: boolean;
  }

  let { collapsed = false }: Props = $props();

  let nodes = $state<BookmarkNode[]>([]);
  let expanded = $state<Record<string, boolean>>({});
  let selectedId = $state<string | null>(null);

  // Add form state: which parent it targets (null = top level) and kind.
  let addOpen = $state(false);
  let addKind = $state<"link" | "folder">("link");
  let addParentId = $state<string | null>(null);
  let addLabel = $state("");
  let addUrl = $state("");

  // Inline rename state.
  let renamingId = $state<string | null>(null);
  let renameValue = $state("");

  // Two-step delete: first trash click arms (no undo!), second deletes.
  let confirmDeleteId = $state<string | null>(null);
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;

  // Favicons that failed to load fall back to a generic icon.
  let brokenIcons = $state<Record<string, boolean>>({});

  // --- Drag & drop -------------------------------------------------------
  // The dragged id lives here (dataTransfer is unreadable during dragover
  // by spec). Drop target = row id + zone from the cursor's Y within it.
  type DropZone = "before" | "into" | "after";
  let dragId = $state<string | null>(null);
  let dropTarget = $state<{ id: string | null; zone: DropZone } | null>(null);
  // Spring-loaded folders: expand after hovering a collapsed folder.
  let springTimer: ReturnType<typeof setTimeout> | null = null;
  let springFor: string | null = null;

  function nodeById(id: string): BookmarkNode | undefined {
    return nodes.find((n) => n.id === id);
  }

  /** True if `id` is `maybeAncestor` or lives anywhere under it. */
  function isWithin(id: string | null, maybeAncestor: string): boolean {
    while (id) {
      if (id === maybeAncestor) return true;
      id = nodeById(id)?.parentId ?? null;
    }
    return false;
  }

  function onDragStart(e: DragEvent, node: BookmarkNode) {
    // WebKit refuses to start a drag session without data set.
    e.dataTransfer?.setData("text/plain", node.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    dragId = node.id;
  }

  function zoneFor(e: DragEvent, node: BookmarkNode): DropZone {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = (e.clientY - rect.top) / rect.height;
    if (node.kind === "folder") {
      return frac < 0.25 ? "before" : frac > 0.75 ? "after" : "into";
    }
    return frac < 0.5 ? "before" : "after";
  }

  function onRowDragOver(e: DragEvent, node: BookmarkNode) {
    if (!dragId || dragId === node.id) return;
    // A folder can't be dropped in or around its own subtree.
    if (isWithin(node.id, dragId)) return;
    // Required: without preventDefault the browser rejects the drop.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const zone = zoneFor(e, node);
    if (dropTarget?.id !== node.id || dropTarget?.zone !== zone) {
      dropTarget = { id: node.id, zone };
      armSpring(node, zone);
    }
  }

  function armSpring(node: BookmarkNode, zone: DropZone) {
    if (springTimer) { clearTimeout(springTimer); springTimer = null; }
    springFor = null;
    if (node.kind === "folder" && zone === "into" && !expanded[node.id]) {
      springFor = node.id;
      springTimer = setTimeout(() => {
        if (springFor && dropTarget?.id === springFor && dropTarget.zone === "into") {
          expanded[springFor] = true;
        }
      }, 500);
    }
  }

  function clearDrag() {
    dragId = null;
    dropTarget = null;
    if (springTimer) { clearTimeout(springTimer); springTimer = null; }
    springFor = null;
  }

  /** Index of `node` among its siblings (sorted by order). */
  function siblingIndex(node: BookmarkNode): number {
    return childrenOf(node.parentId).findIndex((n) => n.id === node.id);
  }

  async function onRowDrop(e: DragEvent, node: BookmarkNode) {
    e.preventDefault();
    const id = dragId;
    const target = dropTarget;
    clearDrag();
    if (!id || !target || target.id !== node.id) return;
    try {
      if (target.zone === "into") {
        await moveBookmark(id, node.id, childrenOf(node.id).length);
        expanded[node.id] = true;
      } else {
        const dragged = nodeById(id);
        let index = siblingIndex(node) + (target.zone === "after" ? 1 : 0);
        // Removing the dragged item from earlier in the same list shifts
        // the insertion point left by one.
        if (dragged?.parentId === node.parentId && siblingIndex(dragged) < siblingIndex(node)) {
          index -= 1;
        }
        await moveBookmark(id, node.parentId, index);
      }
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function onRootDragOver(e: DragEvent) {
    if (!dragId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dropTarget = { id: null, zone: "into" };
  }

  async function onRootDrop(e: DragEvent) {
    e.preventDefault();
    const id = dragId;
    clearDrag();
    if (!id) return;
    try {
      await moveBookmark(id, null, childrenOf(null).length);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }
  // -----------------------------------------------------------------------

  const favorites = $derived(nodes.filter((n) => n.kind === "link" && n.favorite));
  // Collapsed rail: favorites if any are pinned, otherwise every link.
  const railLinks = $derived(
    favorites.length > 0 ? favorites : nodes.filter((n) => n.kind === "link")
  );

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
    // The form renders inside the folder, so it must be open to be seen.
    if (parentId) expanded[parentId] = true;
  }

  function cancelAdd() {
    addOpen = false;
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
    // No undo exists, so require a second click to confirm.
    if (confirmDeleteId !== node.id) {
      confirmDeleteId = node.id;
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => (confirmDeleteId = null), 3000);
      return;
    }
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
    confirmDeleteId = null;
    await removeBookmark(node.id);
    if (selectedId === node.id) selectedId = null;
    await refresh();
  }

  async function toggleFavorite(node: BookmarkNode) {
    await updateBookmark(node.id, { favorite: !node.favorite });
    await refresh();
  }

  function startRename(node: BookmarkNode) {
    renamingId = node.id;
    renameValue = node.label;
  }

  async function commitRename() {
    if (renamingId && renameValue.trim()) {
      await updateBookmark(renamingId, { label: renameValue.trim() });
      await refresh();
    }
    renamingId = null;
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

<div class="tree" class:collapsed>
  {#if collapsed ? railLinks.length > 0 : favorites.length > 0}
    <div class="fav-row" class:fav-col={collapsed}>
      {#each collapsed ? railLinks : favorites as f (f.id)}
        <button
          class="fav"
          class:sel={selectedId === f.id}
          onclick={() => select(f)}
          title={f.label}
        >
          {#if f.url && !brokenIcons[f.id]}
            <img src={faviconUrl(f.url)} alt="" onerror={() => (brokenIcons[f.id] = true)} />
          {:else}
            <Globe size={16} />
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  {#if !collapsed}
    <div class="rows">
      {#each childrenOf(null) as node (node.id)}
        {@render row(node, 0)}
      {/each}
      <!-- Trailing drop zone: move to top level (end). -->
      <div
        class="root-drop"
        class:active={dragId !== null && dropTarget?.id === null}
        role="presentation"
        ondragover={onRootDragOver}
        ondrop={onRootDrop}
      ></div>
      {#if addOpen && addParentId === null}
        {@render addForm(0)}
      {:else}
        <!-- Ghost row: invisible until the tree is hovered (Arc-style). -->
        <div class="ghost-row">
          <button class="add-btn" onclick={() => openAdd("link", null)}>
            <Plus size={13} /> Link
          </button>
          <button class="add-btn" onclick={() => openAdd("folder", null)}>
            <Plus size={13} /> Folder
          </button>
        </div>
      {/if}
    </div>
  {/if}

  {#snippet row(node: BookmarkNode, depth: number)}
    <div
      class="row"
      class:sel={selectedId === node.id}
      class:dragging={dragId === node.id}
      class:drop-into={dropTarget?.id === node.id && dropTarget.zone === "into"}
      class:drop-before={dropTarget?.id === node.id && dropTarget.zone === "before"}
      class:drop-after={dropTarget?.id === node.id && dropTarget.zone === "after"}
      style:padding-left={`${0.4 + depth * 0.85}rem`}
      draggable="true"
      role="presentation"
      ondragstart={(e) => onDragStart(e, node)}
      ondragover={(e) => onRowDragOver(e, node)}
      ondrop={(e) => onRowDrop(e, node)}
      ondragend={clearDrag}
    >
      <button
        class="row-main"
        onclick={() => select(node)}
        ondblclick={() => startRename(node)}
        title={node.kind === "link" ? node.url : node.label}
      >
        {#if node.kind === "folder"}
          <span class="chev" class:open={expanded[node.id]}><ChevronRight size={12} /></span>
          {#if expanded[node.id]}<FolderOpen size={14} />{:else}<Folder size={14} />{/if}
        {:else if node.url && !brokenIcons[node.id]}
          <img class="ico" src={faviconUrl(node.url)} alt="" onerror={() => (brokenIcons[node.id] = true)} />
        {:else if node.kind === "link"}
          <LinkIcon size={13} />
        {/if}
        {#if renamingId === node.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="rename"
            type="text"
            bind:value={renameValue}
            autofocus
            onblur={commitRename}
            onkeydown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") renamingId = null;
            }}
            onclick={(e) => e.stopPropagation()}
          />
        {:else}
          <span class="label">{node.label}</span>
        {/if}
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
          <button class="mini" onclick={() => openAdd("folder", node.id)} title="Add folder inside">
            <FolderPlus size={12} />
          </button>
        {/if}
        <button
          class="mini danger"
          class:armed={confirmDeleteId === node.id}
          onclick={() => remove(node)}
          title={confirmDeleteId === node.id ? "No undo — click again to delete" : "Delete"}
        >
          {#if confirmDeleteId === node.id}<span class="confirm-label">Sure?</span>{/if}
          <Trash2 size={12} />
        </button>
      </span>
    </div>
    {#if node.kind === "folder" && expanded[node.id]}
      {#each childrenOf(node.id) as child (child.id)}
        {@render row(child, depth + 1)}
      {/each}
      {#if addOpen && addParentId === node.id}
        {@render addForm(depth + 1)}
      {/if}
    {/if}
  {/snippet}

  <!-- Inline add form, rendered exactly where the new node will appear. -->
  {#snippet addForm(depth: number)}
    <form
      class="add-form"
      style:margin-left={`${0.4 + depth * 0.85}rem`}
      onsubmit={(e) => { e.preventDefault(); submitAdd(); }}
    >
      {#if addKind === "link"}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          type="text" placeholder="URL (e.g. xeto.dev)" bind:value={addUrl} autofocus
          onkeydown={(e) => e.key === "Escape" && cancelAdd()}
        />
        <input
          type="text" placeholder="Label (optional)" bind:value={addLabel}
          onkeydown={(e) => e.key === "Escape" && cancelAdd()}
        />
      {:else}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          type="text" placeholder="Folder name" bind:value={addLabel} autofocus
          onkeydown={(e) => e.key === "Escape" && cancelAdd()}
        />
      {/if}
      <div class="add-actions">
        <button type="submit" class="add-save">Add</button>
        <button type="button" class="add-cancel" onclick={cancelAdd}>Cancel</button>
      </div>
    </form>
  {/snippet}

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
  .fav-row.fav-col {
    grid-template-columns: 1fr;
    justify-items: center;
  }
  .fav-row.fav-col .fav { width: 38px; }
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
    /* Anchor for the armed delete chip, which overlays the other actions. */
    position: relative;
  }
  .row:hover { background: var(--sidebar-hover); }
  .row.sel { background: rgba(109, 94, 252, 0.16); }
  .row.dragging { opacity: 0.4; }
  .row.drop-into {
    outline: 1.5px solid var(--accent);
    outline-offset: -1.5px;
    background: rgba(109, 94, 252, 0.12);
  }
  .row.drop-before { box-shadow: inset 0 2px 0 0 var(--accent); }
  .row.drop-after { box-shadow: inset 0 -2px 0 0 var(--accent); }
  .root-drop { min-height: 14px; flex: 1; border-radius: var(--radius-sm); }
  .root-drop.active { box-shadow: inset 0 2px 0 0 var(--accent); }
  .row.sel .row-main { color: var(--sidebar-text-bright); }

  .row-main {
    /* Sized to match the library-mode nav links for visual consistency. */
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    border: none;
    background: transparent;
    color: var(--sidebar-text);
    font-size: 0.92rem;
    font-family: inherit;
    cursor: pointer;
    padding: 0.55rem 0.3rem;
    text-align: left;
  }
  .row-main:hover { color: var(--sidebar-text-bright); }
  .chev { display: inline-flex; transition: transform 0.12s; flex-shrink: 0; }
  .chev.open { transform: rotate(90deg); }
  .ico { width: 17px; height: 17px; border-radius: 3px; flex-shrink: 0; }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rename {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--accent);
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.07);
    color: var(--sidebar-text-bright);
    font-size: 0.82rem;
    font-family: inherit;
    padding: 0.15rem 0.35rem;
    outline: none;
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
  .mini.armed {
    /* Overlay the row's action area instead of pushing siblings aside. */
    position: absolute;
    right: 0.25rem;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1;
    opacity: 1;
    background: rgba(242, 85, 90, 0.95);
    color: #fff;
    gap: 0.2rem;
    display: inline-flex;
    align-items: center;
    padding: 0.25rem 0.45rem;
  }
  .mini.armed:hover { background: #f2555a; color: #fff; }
  .confirm-label { font-size: 0.68rem; font-weight: 600; }

  /* Hidden until the tree is hovered — keeps the rail quiet (Arc-style). */
  .ghost-row {
    display: flex;
    gap: 0.35rem;
    padding-top: 0.3rem;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .tree:hover .ghost-row,
  .ghost-row:focus-within { opacity: 1; }
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

  .add-form { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.3rem 0.25rem 0.3rem 0; }
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
