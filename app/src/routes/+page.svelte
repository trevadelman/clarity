<script lang="ts">
  import { onMount } from "svelte";
  import { fly, fade } from "svelte/transition";
  import { confirm } from "@tauri-apps/plugin-dialog";
  import { Plus, Film, Sparkles, Cloud, Trash2, Search, Tag, X } from "lucide-svelte";
  import { listVideos, listAllTags, clearAll, type VideoRecord } from "$lib/videoLibrary";
  import { formatDuration } from "$lib/thumbnail";
  import { mediaSrc } from "$lib/media";
  import { loadApiKey } from "$lib/settings";
  import { toast } from "$lib/toast";

  let videos = $state<VideoRecord[]>([]);
  let allTags = $state<string[]>([]);
  let thumbUrls = $state<Record<string, string>>({});
  let loaded = $state(false);
  let clearing = $state(false);


  let query = $state("");
  let activeTags = $state<string[]>([]);

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return videos.filter((v) => {
      const matchesQuery = q === "" || v.videoName.toLowerCase().includes(q);
      const matchesTags =
        activeTags.length === 0 || activeTags.every((t) => v.tags?.includes(t));
      return matchesQuery && matchesTags;
    });
  });

  function toggleTag(tag: string) {
    activeTags = activeTags.includes(tag)
      ? activeTags.filter((t) => t !== tag)
      : [...activeTags, tag];
  }

  function clearFilters() {
    query = "";
    activeTags = [];
  }

  async function refresh() {
    videos = await listVideos();
    allTags = await listAllTags();
    const urls: Record<string, string> = {};
    for (const v of videos) {
      if (v.thumbnailPath) urls[v.id] = await mediaSrc(v.thumbnailPath);
    }
    thumbUrls = urls;
  }


  onMount(async () => {
    await refresh();
    loaded = true;
  });

  async function handleClearAll() {
    const ok = await confirm(
      "Delete ALL app data? This permanently removes every stored video, its summary, and its Gemini upload. This cannot be undone.",
      { title: "Delete all app data", kind: "warning" }
    );
    if (!ok) return;
    clearing = true;
    try {
      const apiKey = await loadApiKey();
      await clearAll(apiKey);
      videos = await listVideos();
      toast.success("All app data cleared.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      clearing = false;
    }
  }

  function fmtSize(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
  }

  function relTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
  }
</script>

<header class="page-head">
  <div>
    <h1>Library</h1>
    <p class="sub">
      {#if loaded && videos.length > 0}
        {videos.length} video{videos.length === 1 ? "" : "s"} stored locally
      {:else}
        Your locally-stored whiteboard sessions
      {/if}
    </p>
  </div>
  <a class="btn primary" href="/add"><Plus size={16} /> Add video</a>
</header>

{#if !loaded}
  <div class="grid">
    {#each Array(3) as _}
      <div class="skeleton"></div>
    {/each}
  </div>
{:else if videos.length === 0}
  <div class="empty" in:fade>
    <span class="empty-icon"><Film size={42} /></span>
    <h2>No videos yet</h2>
    <p>Add a whiteboard session to get started.</p>
    <a class="btn primary" href="/add"><Plus size={16} /> Add your first video</a>
  </div>
{:else}
  <div class="toolbar">
    <div class="search">
      <Search size={16} />
      <input type="text" placeholder="Search by name…" bind:value={query} />
      {#if query}
        <button class="clear-q" onclick={() => (query = "")} aria-label="Clear search">
          <X size={14} />
        </button>
      {/if}
    </div>
    {#if allTags.length > 0}
      <div class="tag-filter">
        {#each allTags as t (t)}
          <button class="chip" class:on={activeTags.includes(t)} onclick={() => toggleTag(t)}>
            <Tag size={11} /> {t}
          </button>
        {/each}
        {#if query || activeTags.length > 0}
          <button class="chip clear" onclick={clearFilters}>Clear</button>
        {/if}
      </div>
    {/if}
  </div>

  {#if filtered.length === 0}
    <div class="empty small" in:fade>
      <p>No videos match your filters.</p>
      <button class="btn" onclick={clearFilters}>Clear filters</button>
    </div>
  {:else}
  <ul class="grid">
    {#each filtered as v, i (v.id)}
      <li in:fly={{ y: 14, duration: 240, delay: i * 40 }}>
        <a class="card" href={`/video/${v.id}`}>
          <div class="thumb">
            {#if thumbUrls[v.id]}
              <img src={thumbUrls[v.id]} alt="" />
            {:else}

              <span class="thumb-fallback"><Film size={28} /></span>
            {/if}
            {#if formatDuration(v.durationSec)}
              <span class="duration">{formatDuration(v.durationSec)}</span>
            {/if}
          </div>
          <div class="body">
            <div class="title">{v.videoName}</div>
            <div class="meta">{fmtSize(v.sizeBytes)} · {relTime(v.addedAt)}</div>
            {#if v.tags && v.tags.length > 0}
              <div class="card-tags">
                {#each v.tags as t (t)}
                  <span class="tag-pill"><Tag size={10} /> {t}</span>
                {/each}
              </div>
            {/if}
            <div class="badges">
              {#if v.summary}
                <span class="badge ok"><Sparkles size={12} /> Summarized</span>
              {:else}
                <span class="badge">Not summarized</span>
              {/if}
              {#if v.geminiName}
                <span class="badge gem"><Cloud size={12} /> On Gemini</span>
              {:else}
                <span class="badge">Local only</span>
              {/if}
            </div>
          </div>
        </a>
      </li>
    {/each}
  </ul>
  {/if}

  <div class="danger-zone">
    <button class="btn danger" onclick={handleClearAll} disabled={clearing}>
      <Trash2 size={15} />
      {clearing ? "Clearing…" : "Delete all app data"}
    </button>
  </div>
{/if}

<style>
  .page-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    margin-bottom: 1.5rem;
  }
  h1 { font-size: 1.5rem; margin: 0; letter-spacing: -0.01em; }
  .sub { color: var(--text-dim); font-size: 0.9rem; margin: 0.2rem 0 0; }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.55rem 0.95rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    text-decoration: none;
    color: var(--text);
    font-size: 0.92rem;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, transform 0.1s;
  }
  .btn:active { transform: translateY(1px); }
  .btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .btn.primary:hover { background: var(--accent-hover); }

  .toolbar { margin-bottom: 1.25rem; display: flex; flex-direction: column; gap: 0.75rem; }
  .search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.55rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text-dim);
    transition: border-color 0.15s;
  }
  .search:focus-within { border-color: var(--accent); }
  .search input {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 0.92rem;
    font-family: inherit;
    outline: none;
  }
  .clear-q {
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    padding: 0.1rem;
    border-radius: 5px;
  }
  .clear-q:hover { background: var(--hover); color: var(--text); }

  .tag-filter { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.78rem;
    padding: 0.28rem 0.6rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-dim);
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .chip:hover { background: var(--hover); color: var(--text); }
  .chip.on {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  }
  .chip.clear { color: var(--danger); }

  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 1rem;
  }
  .card {
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    text-decoration: none;
    color: inherit;
    transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
  }
  .card:hover {
    transform: translateY(-3px);
    box-shadow: var(--shadow-lg);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  }
  .thumb {
    position: relative;
    aspect-ratio: 16 / 9;
    background: var(--hover);
    display: grid;
    place-items: center;
    overflow: hidden;
  }
  .thumb img { width: 100%; height: 100%; object-fit: cover; }
  .thumb-fallback { color: var(--text-dim); }
  .duration {
    position: absolute;
    bottom: 6px;
    right: 6px;
    background: rgba(0, 0, 0, 0.72);
    color: #fff;
    font-size: 0.72rem;
    padding: 0.1rem 0.35rem;
    border-radius: 5px;
    font-variant-numeric: tabular-nums;
  }
  .body { padding: 0.8rem 0.9rem 0.95rem; }
  .title {
    font-weight: 600;
    font-size: 0.95rem;
    margin-bottom: 0.25rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta { font-size: 0.8rem; color: var(--text-dim); }
  .card-tags { margin-top: 0.5rem; display: flex; gap: 0.3rem; flex-wrap: wrap; }
  .tag-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.7rem;
    padding: 0.12rem 0.45rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
  }
  .badges { margin-top: 0.65rem; display: flex; gap: 0.35rem; flex-wrap: wrap; }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.72rem;
    padding: 0.18rem 0.5rem;
    border-radius: 999px;
    background: var(--hover);
    color: var(--text-dim);
  }
  .badge.ok { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
  .badge.gem { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }

  .skeleton {
    aspect-ratio: 16 / 9;
    border-radius: var(--radius);
    background: linear-gradient(100deg, var(--surface) 30%, var(--hover) 50%, var(--surface) 70%);
    background-size: 200% 100%;
    animation: shimmer 1.3s infinite;
  }
  @keyframes shimmer { to { background-position: -200% 0; } }

  .empty {
    text-align: center;
    padding: 4rem 1rem;
    color: var(--text-dim);
    border: 1px dashed var(--border);
    border-radius: 16px;
    background: var(--surface);
  }
  .empty-icon { color: var(--accent); display: inline-flex; }
  .empty h2 { margin: 0.8rem 0 0.2rem; color: var(--text); font-size: 1.15rem; }
  .empty p { margin: 0 0 1.1rem; }
  .empty.small { padding: 2.5rem 1rem; }

  .danger-zone {
    margin-top: 2rem;
    border-top: 1px solid var(--border);
    padding-top: 1.25rem;
  }
  .btn.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
  .btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 10%, transparent); }
  .btn.danger:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
