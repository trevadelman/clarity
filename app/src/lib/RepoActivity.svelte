<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { marked } from "marked";
  import {
    Star, GitCommitHorizontal, ExternalLink, Sparkles, Trash2, RefreshCw,
  } from "lucide-svelte";
  import {
    fetchCommitsSince, fetchCommitDetail, type CommitInfo,
  } from "$lib/github";
  import {
    addRepoDigest, removeRepoDigest, refreshRepoInfo,
    type VideoRecord, type RepoDigest,
  } from "$lib/videoLibrary";
  import { generateChangeDigest } from "$lib/gemini";
  import { toast } from "$lib/toast";

  interface Props {
    record: VideoRecord;
    apiKey: string;
    githubToken: string;
  }
  let { record, apiKey, githubToken }: Props = $props();

  const INTERVALS = [
    { label: "24h", days: 1 },
    { label: "7d", days: 7 },
    { label: "30d", days: 30 },
    { label: "90d", days: 90 },
  ];

  type RepoTab = "commits" | "digests";
  let activeTab = $state<RepoTab>("commits");

  let days = $state(7);
  let commits = $state<CommitInfo[]>([]);
  let loading = $state(false);
  let selected = $state<Set<string>>(new Set());
  let digesting = $state(false);
  let refreshing = $state(false);

  const info = $derived(record.repoInfo!);
  const digests = $derived(record.repoDigests ?? []);
  const allSelected = $derived(commits.length > 0 && selected.size === commits.length);

  async function loadCommits() {
    loading = true;
    selected = new Set();
    try {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      commits = await fetchCommitsSince(
        { owner: info.owner, repo: info.repo },
        since,
        githubToken
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      commits = [];
    } finally {
      loading = false;
    }
  }

  onMount(loadCommits);

  function setDays(d: number) {
    days = d;
    loadCommits();
  }

  function toggle(sha: string) {
    const next = new Set(selected);
    if (next.has(sha)) next.delete(sha);
    else next.add(sha);
    selected = next;
  }

  function toggleAll() {
    selected = allSelected ? new Set() : new Set(commits.map((c) => c.sha));
  }

  async function handleRefresh() {
    refreshing = true;
    try {
      await refreshRepoInfo(record, githubToken);
      await loadCommits();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      refreshing = false;
    }
  }

  async function handleDigest() {
    if (selected.size === 0 || digesting) return;
    if (!apiKey) {
      toast.error("Set your Gemini API key in Settings first.");
      return;
    }
    digesting = true;
    try {
      const picked = commits.filter((c) => selected.has(c.sha));
      const details = [];
      for (const c of picked) {
        details.push(
          await fetchCommitDetail({ owner: info.owner, repo: info.repo }, c.sha, githubToken)
        );
      }
      const reply = await generateChangeDigest(
        apiKey,
        `${info.owner}/${info.repo}`,
        details
      );
      const digest: RepoDigest = {
        id: crypto.randomUUID(),
        text: reply.text,
        label: `${picked.length} commit${picked.length === 1 ? "" : "s"} · last ${days}d`,
        shas: picked.map((c) => c.sha.slice(0, 7)),
        generatedAt: new Date().toISOString(),
        costUsd: reply.usage.costUsd,
      };
      await addRepoDigest(record, digest);
      selected = new Set();
      toast.success("Change digest generated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      digesting = false;
    }
  }

  async function handleRemoveDigest(id: string) {
    await removeRepoDigest(record, id);
  }

  /** Commits-per-day counts for the activity strip (oldest → newest). */
  const activity = $derived.by(() => {
    const buckets = new Array(Math.min(days, 30)).fill(0);
    const bucketMs = (days * 86_400_000) / buckets.length;
    const start = Date.now() - days * 86_400_000;
    for (const c of commits) {
      const t = new Date(c.date).getTime();
      const i = Math.min(buckets.length - 1, Math.floor((t - start) / bucketMs));
      if (i >= 0) buckets[i]++;
    }
    return buckets;
  });
  const maxActivity = $derived(Math.max(1, ...activity));

  function relTime(iso: string): string {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 60) return `${Math.max(1, mins)}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  function firstLine(msg: string): string {
    return msg.split("\n")[0];
  }

  function fmtCost(usd: number): string {
    return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  }
</script>

<section class="repo-head">
  <div class="repo-title">
    <h2>{info.owner}/{info.repo}</h2>
    <a class="ext" href={info.htmlUrl} target="_blank" rel="noreferrer">
      <ExternalLink size={14} /> GitHub
    </a>
  </div>
  {#if info.description}<p class="desc">{info.description}</p>{/if}
  <div class="facts">
    {#if info.language}<span class="fact">{info.language}</span>{/if}
    <span class="fact"><Star size={12} /> {info.stars.toLocaleString()}</span>
    <span class="fact">{info.defaultBranch}</span>
    {#if info.pushedAt}<span class="fact">pushed {relTime(info.pushedAt)}</span>{/if}
    <button class="fact btn-fact" onclick={handleRefresh} disabled={refreshing}>
      <RefreshCw size={12} /> {refreshing ? "Refreshing…" : "Refresh"}
    </button>
  </div>
</section>

<nav class="tabs">
  <button class="tab" class:on={activeTab === "commits"} onclick={() => (activeTab = "commits")}>
    <GitCommitHorizontal size={14} /> Commits
  </button>
  <button
    class="tab"
    class:on={activeTab === "digests"}
    onclick={() => (activeTab = "digests")}
    disabled={digests.length === 0}
  >
    <Sparkles size={14} /> Digests
    {#if digests.length > 0}<span class="tab-count">{digests.length}</span>{/if}
  </button>
</nav>

{#if activeTab === "commits"}
<section class="commits">
  <div class="commits-head">
    <h3><GitCommitHorizontal size={16} /> Recent commits</h3>
    <div class="intervals">
      {#each INTERVALS as iv (iv.days)}
        <button class="chip" class:on={days === iv.days} onclick={() => setDays(iv.days)}>
          {iv.label}
        </button>
      {/each}
    </div>
  </div>

  {#if commits.length > 0}
    <div class="activity" title="Commits over the selected interval">
      {#each activity as n, i (i)}
        <div class="bar" style={`height:${Math.round((n / maxActivity) * 100)}%`}></div>
      {/each}
    </div>
  {/if}

  {#if loading}
    <p class="dim">Loading commits…</p>
  {:else if commits.length === 0}
    <p class="dim">No commits in the last {days} day{days === 1 ? "" : "s"}.</p>
  {:else}
    <div class="list-tools">
      <label class="select-all">
        <input type="checkbox" checked={allSelected} onchange={toggleAll} />
        Select all ({commits.length})
      </label>
      <button
        class="btn primary"
        onclick={handleDigest}
        disabled={selected.size === 0 || digesting}
      >
        <Sparkles size={14} />
        {digesting
          ? "Summarizing…"
          : `Summarize ${selected.size || ""} change${selected.size === 1 ? "" : "s"}`}
      </button>
    </div>

    <ul class="commit-list">
      {#each commits as c (c.sha)}
        <li class="commit" class:sel={selected.has(c.sha)}>
          <input
            type="checkbox"
            checked={selected.has(c.sha)}
            onchange={() => toggle(c.sha)}
          />
          <div class="c-body">
            <span class="c-msg" title={c.message}>{firstLine(c.message)}</span>
            <span class="c-meta">
              <a class="sha" href={c.htmlUrl} target="_blank" rel="noreferrer">{c.sha.slice(0, 7)}</a>
              · {c.author} · {relTime(c.date)}
            </span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
{/if}

{#if activeTab === "digests" && digests.length > 0}
  <section class="digests">
    <h3><Sparkles size={16} /> Change digests</h3>
    {#each digests as d (d.id)}
      <article class="digest" in:fade>
        <header>
          <span class="d-label">{d.label}</span>
          <span class="d-meta mono">
            {new Date(d.generatedAt).toLocaleString()} · ~{fmtCost(d.costUsd)}
          </span>
          <button class="icon-btn" onclick={() => handleRemoveDigest(d.id)} aria-label="Delete digest">
            <Trash2 size={14} />
          </button>
        </header>
        <div class="markdown">{@html marked.parse(d.text)}</div>
      </article>
    {/each}
  </section>
{/if}

<style>
  .repo-head {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.1rem 1.25rem;
    margin-bottom: 1rem;
  }
  .repo-title { display: flex; align-items: center; gap: 0.7rem; }
  .repo-title h2 { margin: 0; font-size: 1.15rem; }
  .ext {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.8rem;
    color: var(--accent);
    text-decoration: none;
  }
  .desc { margin: 0.4rem 0 0; color: var(--text-dim); font-size: 0.9rem; }
  .facts { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.7rem; }
  .fact {
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
    font-size: 0.76rem;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    background: var(--hover);
    color: var(--text-dim);
  }
  .btn-fact {
    border: none;
    cursor: pointer;
    font-family: inherit;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .btn-fact:disabled { opacity: 0.6; cursor: progress; }

  .tabs {
    display: flex;
    gap: 0.35rem;
    margin-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.55rem 0.9rem;
    border: none;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--text-dim);
    font-size: 0.88rem;
    font-family: inherit;
    cursor: pointer;
    margin-bottom: -1px;
    transition: color 0.15s, border-color 0.15s;
  }
  .tab :global(svg) { color: currentColor; }
  .tab:hover:not(:disabled) { color: var(--text); }
  .tab.on { color: var(--accent); border-bottom-color: var(--accent); }
  .tab:disabled { opacity: 0.4; cursor: not-allowed; }
  .tab-count {
    font-size: 0.7rem;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
  }

  .commits, .digests {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.1rem 1.25rem;
    margin-bottom: 1rem;
  }
  .commits-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin: 0;
    font-size: 1rem;
  }
  h3 :global(svg) { color: var(--accent); }

  .intervals { display: flex; gap: 0.35rem; }
  .chip {
    font-size: 0.78rem;
    padding: 0.26rem 0.6rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-dim);
    cursor: pointer;
    font-family: inherit;
  }
  .chip.on {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  }

  .activity {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 36px;
    margin-top: 0.9rem;
  }
  .bar {
    flex: 1;
    min-height: 2px;
    border-radius: 2px 2px 0 0;
    background: color-mix(in srgb, var(--accent) 45%, transparent);
  }

  .dim { color: var(--text-dim); font-size: 0.88rem; margin: 0.9rem 0 0; }

  .list-tools {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-top: 0.9rem;
  }
  .select-all {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.84rem;
    color: var(--text-dim);
    cursor: pointer;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.45rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-size: 0.86rem;
    font-family: inherit;
    cursor: pointer;
  }
  .btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .commit-list { list-style: none; margin: 0.7rem 0 0; padding: 0; }
  .commit {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.55rem 0.5rem;
    border-radius: var(--radius-sm);
    transition: background 0.12s;
  }
  .commit:hover { background: var(--hover); }
  .commit.sel { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .commit input { margin-top: 3px; }
  .c-body { display: flex; flex-direction: column; min-width: 0; }
  .c-msg {
    font-size: 0.88rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .c-meta { font-size: 0.76rem; color: var(--text-dim); margin-top: 0.15rem; }
  .sha {
    font-family: "JetBrains Mono", monospace;
    color: var(--accent);
    text-decoration: none;
  }

  .digest {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.85rem 1rem;
    margin-top: 0.8rem;
  }
  .digest header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.5rem;
  }
  .d-label { font-size: 0.84rem; font-weight: 600; flex: 1; }
  .d-meta { font-size: 0.72rem; color: var(--text-dim); }
  .mono { font-family: "JetBrains Mono", monospace; }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
  }
  .icon-btn:hover { background: var(--hover); color: var(--danger); }

  .markdown { font-size: 0.88rem; line-height: 1.6; }
  .markdown :global(h1), .markdown :global(h2), .markdown :global(h3) {
    font-size: 0.95rem;
    margin: 0.8rem 0 0.3rem;
  }
  .markdown :global(p) { margin: 0.35rem 0; }
  .markdown :global(ul), .markdown :global(ol) { margin: 0.35rem 0; padding-left: 1.2rem; }
  .markdown :global(code) {
    background: color-mix(in srgb, var(--text) 8%, transparent);
    padding: 0.08rem 0.3rem;
    border-radius: 4px;
    font-size: 0.82em;
    font-family: "JetBrains Mono", monospace;
  }
</style>
