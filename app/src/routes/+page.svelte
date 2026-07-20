<script lang="ts">
  import { onMount } from "svelte";
  import { fly, fade } from "svelte/transition";
  import { confirm } from "@tauri-apps/plugin-dialog";
  import { Plus, Film, Sparkles, Cloud, Trash2, Search, Tag, X, FolderGit2, Star, Video } from "lucide-svelte";
  import {
    listVideos, listAllTags, clearAll, isYouTube, isLoom, isGitHub,
    loadLibraryChat, saveLibraryChat, type VideoRecord,
  } from "$lib/videoLibrary";
  import { generateLibraryChatReply, type ChatMessage } from "$lib/gemini";
  import ChatPanel from "$lib/ChatPanel.svelte";
  import { formatDuration } from "$lib/thumbnail";
  import { mediaSrc } from "$lib/media";
  import { loadApiKey } from "$lib/settings";
  import { toast } from "$lib/toast";

  let videos = $state<VideoRecord[]>([]);
  let allTags = $state<string[]>([]);
  let thumbUrls = $state<Record<string, string>>({});
  let loaded = $state(false);
  let clearing = $state(false);
  let apiKey = $state("");
  let libraryChat = $state<ChatMessage[]>([]);


  let query = $state("");
  let activeTags = $state<string[]>([]);
  let typeFilter = $state<"all" | "video" | "youtube" | "repo">("all");

  /** Coarse source kind used for the type filter and card visuals. */
  function kindOf(v: VideoRecord): "video" | "youtube" | "repo" {
    if (isGitHub(v)) return "repo";
    if (isYouTube(v)) return "youtube";
    return "video";
  }

  const counts = $derived.by(() => {
    const c = { all: videos.length, video: 0, youtube: 0, repo: 0 };
    for (const v of videos) c[kindOf(v)]++;
    return c;
  });

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return videos.filter((v) => {
      if (typeFilter !== "all" && kindOf(v) !== typeFilter) return false;
      const matchesQuery =
        q === "" ||
        v.videoName.toLowerCase().includes(q) ||
        (v.tags ?? []).some((t) => t.includes(q)) ||
        (v.summary ?? "").toLowerCase().includes(q);
      const matchesTags =
        activeTags.length === 0 || activeTags.every((t) => v.tags?.includes(t));
      return matchesQuery && matchesTags;
    });
  });

  /**
   * When a video matches only via its summary text, show a short snippet
   * around the first occurrence so the user sees why it matched.
   */
  function summarySnippet(v: VideoRecord): { before: string; hit: string; after: string } | null {
    const q = query.trim().toLowerCase();
    if (!q || !v.summary) return null;
    if (v.videoName.toLowerCase().includes(q)) return null;
    const text = v.summary;
    const idx = text.toLowerCase().indexOf(q);
    if (idx < 0) return null;
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + q.length + 60);
    return {
      before: (start > 0 ? "…" : "") + text.slice(start, idx),
      hit: text.slice(idx, idx + q.length),
      after: text.slice(idx + q.length, end) + (end < text.length ? "…" : ""),
    };
  }

  function toggleTag(tag: string) {
    activeTags = activeTags.includes(tag)
      ? activeTags.filter((t) => t !== tag)
      : [...activeTags, tag];
  }

  function clearFilters() {
    query = "";
    activeTags = [];
    typeFilter = "all";
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
    apiKey = await loadApiKey();
    libraryChat = await loadLibraryChat();
    loaded = true;
  });

  const summarized = $derived(videos.filter((v) => v.summary));
  const chatVideoNames = $derived(
    Object.fromEntries(videos.map((v) => [v.id, v.videoName]))
  );

  async function handleLibraryAsk(question: string) {
    const userMsg: ChatMessage = { role: "user", text: question, at: new Date().toISOString() };
    libraryChat = [...libraryChat, userMsg];
    try {
      const reply = await generateLibraryChatReply(
        apiKey, question, libraryChat.slice(0, -1),
        summarized.map((v) => ({
          id: v.id,
          name: v.videoName,
          tags: v.tags ?? [],
          summary: v.summary ?? "",
        }))
      );
      libraryChat = [
        ...libraryChat,
        { role: "model", text: reply.text, at: new Date().toISOString(), costUsd: reply.usage.costUsd },
      ];
      await saveLibraryChat(libraryChat);
    } catch (err) {
      libraryChat = libraryChat.slice(0, -1);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleClearLibraryChat() {
    libraryChat = [];
    await saveLibraryChat([]);
  }

  async function handleClearAll() {
    const ok = await confirm(
      "Delete ALL app data? This permanently removes every stored source, its summary, and its Gemini upload. This cannot be undone.",
      { title: "Delete all app data", kind: "warning" }
    );
    if (!ok) return;
    clearing = true;
    try {
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
        {counts.video + counts.youtube} video{counts.video + counts.youtube === 1 ? "" : "s"}{counts.repo > 0 ? ` · ${counts.repo} repo${counts.repo === 1 ? "" : "s"}` : ""} stored locally
      {:else}
        Your locally-stored sessions & sources
      {/if}
    </p>
  </div>
  <a class="btn primary" href="/add"><Plus size={16} /> Add source</a>
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
    <h2>Nothing here yet</h2>
    <p>Add a video or GitHub repo to get started.</p>
    <a class="btn primary" href="/add"><Plus size={16} /> Add your first source</a>
  </div>
{:else}
  <div class="toolbar">
    <div class="search">
      <Search size={16} />
      <input type="text" placeholder="Search names, tags & summaries…" bind:value={query} />
      {#if query}
        <button class="clear-q" onclick={() => (query = "")} aria-label="Clear search">
          <X size={14} />
        </button>
      {/if}
    </div>
    {#if counts.repo > 0 || counts.youtube > 0}
      <div class="type-filter">
        <button class="chip" class:on={typeFilter === "all"} onclick={() => (typeFilter = "all")}>
          All ({counts.all})
        </button>
        <button class="chip" class:on={typeFilter === "video"} onclick={() => (typeFilter = "video")}>
          <Video size={11} /> Videos ({counts.video})
        </button>
        {#if counts.youtube > 0}
          <button class="chip" class:on={typeFilter === "youtube"} onclick={() => (typeFilter = "youtube")}>
            <Film size={11} /> YouTube ({counts.youtube})
          </button>
        {/if}
        {#if counts.repo > 0}
          <button class="chip" class:on={typeFilter === "repo"} onclick={() => (typeFilter = "repo")}>
            <FolderGit2 size={11} /> Repos ({counts.repo})
          </button>
        {/if}
      </div>
    {/if}
    {#if allTags.length > 0}
      <div class="tag-filter">
        {#each allTags as t (t)}
          <button class="chip" class:on={activeTags.includes(t)} onclick={() => toggleTag(t)}>
            <Tag size={11} /> {t}
          </button>
        {/each}
        {#if query || activeTags.length > 0 || typeFilter !== "all"}
          <button class="chip clear" onclick={clearFilters}>Clear</button>
        {/if}
      </div>
    {/if}
  </div>

  {#if filtered.length === 0}
    <div class="empty small" in:fade>
      <p>No sources match your filters.</p>
      <button class="btn" onclick={clearFilters}>Clear filters</button>
    </div>
  {:else}
  <ul class="grid">
    {#each filtered as v, i (v.id)}
      <li in:fly={{ y: 14, duration: 240, delay: i * 40 }}>
        <a class="card" href={`/video/${v.id}`}>
          <div class="thumb" class:repo-thumb={isGitHub(v)}>
            {#if thumbUrls[v.id]}
              <img src={thumbUrls[v.id]} alt="" />
            {:else if isGitHub(v)}
              <span class="thumb-fallback repo-icon"><FolderGit2 size={32} /></span>
              {#if v.repoInfo}
                <span class="repo-facts">
                  {#if v.repoInfo.language}<span>{v.repoInfo.language}</span>{/if}
                  <span><Star size={11} /> {v.repoInfo.stars.toLocaleString()}</span>
                </span>
              {/if}
            {:else}
              <span class="thumb-fallback"><Film size={28} /></span>
            {/if}
            {#if formatDuration(v.durationSec)}
              <span class="duration">{formatDuration(v.durationSec)}</span>
            {/if}
          </div>
          <div class="body">
            <div class="title">{v.videoName}</div>
            <div class="meta">
              {isYouTube(v) ? "YouTube" : isGitHub(v) ? "GitHub repo" : fmtSize(v.sizeBytes)} · {relTime(v.addedAt)}
            </div>
            {#if summarySnippet(v)}
              {@const s = summarySnippet(v)!}
              <div class="snippet">{s.before}<mark>{s.hit}</mark>{s.after}</div>
            {/if}
            {#if v.tags && v.tags.length > 0}
              <div class="card-tags">
                {#each v.tags as t (t)}
                  <span class="tag-pill"><Tag size={10} /> {t}</span>
                {/each}
              </div>
            {/if}
            <div class="badges">
              {#if isGitHub(v)}
                {#if (v.repoDigests ?? []).length > 0}
                  <span class="badge ok"><Sparkles size={12} /> {(v.repoDigests ?? []).length} digest{(v.repoDigests ?? []).length === 1 ? "" : "s"}</span>
                {:else}
                  <span class="badge">No digests yet</span>
                {/if}
              {:else if v.summary}
                <span class="badge ok"><Sparkles size={12} /> Summarized</span>
              {:else}
                <span class="badge">Not summarized</span>
              {/if}
              {#if isGitHub(v)}
                <span class="badge repo">GitHub</span>
              {:else if isYouTube(v)}
                <span class="badge yt">YouTube</span>
              {:else if isLoom(v)}
                <span class="badge loom">Loom</span>
              {:else if v.geminiName}
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

  <ChatPanel
    title="Ask your library"
    messages={libraryChat}
    onAsk={handleLibraryAsk}
    onClear={handleClearLibraryChat}
    disabled={!apiKey || summarized.length === 0}
    emptyHint={summarized.length === 0
      ? "Summarize at least one source to ask questions across your library."
      : `Ask across all ${summarized.length} summarized source${summarized.length === 1 ? "" : "s"} — answers cite their sources.`}
    videoNames={chatVideoNames}
  />

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
  .repo-thumb {
    background: linear-gradient(135deg,
      color-mix(in srgb, #8957e5 14%, var(--hover)),
      var(--hover));
  }
  .repo-icon { color: #a371f7; }
  .repo-facts {
    position: absolute;
    bottom: 6px;
    left: 8px;
    display: flex;
    gap: 0.6rem;
    font-size: 0.72rem;
    color: var(--text-dim);
  }
  .repo-facts span { display: inline-flex; align-items: center; gap: 0.2rem; }
  .type-filter { display: flex; flex-wrap: wrap; gap: 0.4rem; }
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
  .snippet {
    margin-top: 0.4rem;
    font-size: 0.76rem;
    color: var(--text-dim);
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .snippet mark {
    background: color-mix(in srgb, var(--accent) 25%, transparent);
    color: var(--accent);
    border-radius: 3px;
    padding: 0 2px;
  }
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
  .badge.yt { background: color-mix(in srgb, #ff0033 14%, transparent); color: #e5254c; }
  .badge.loom { background: color-mix(in srgb, #625df5 16%, transparent); color: #7a76ff; }
  .badge.repo { background: color-mix(in srgb, #8957e5 16%, transparent); color: #a371f7; }

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
