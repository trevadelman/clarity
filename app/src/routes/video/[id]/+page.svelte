<script lang="ts">
  import { onMount } from "svelte";
  import { fade, fly } from "svelte/transition";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { confirm, save } from "@tauri-apps/plugin-dialog";
  import { writeTextFile } from "@tauri-apps/plugin-fs";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { marked } from "marked";
  import {
    ArrowLeft, Trash2, Sparkles, RefreshCw, Copy, Download,
    Cloud, CloudOff, CheckCircle2, Tag, X, Plus,
  } from "lucide-svelte";
  import { loadApiKey, loadPrompt, loadModel } from "$lib/settings";
  import { DEFAULT_MODEL, type ModelId, type Status, generateSummary } from "$lib/gemini";
  import {
    getVideo, ensureActiveFile, saveSummary, deleteVideo, checkGeminiStatus,
    addTag, removeTag, type VideoRecord, type GeminiStatus,
  } from "$lib/videoLibrary";
  import { formatDuration } from "$lib/thumbnail";
  import { toast } from "$lib/toast";

  let record = $state<VideoRecord | null>(null);
  let loaded = $state(false);
  let apiKey = $state("");
  let prompt = $state("");
  let model = $state<ModelId>(DEFAULT_MODEL);

  let status = $state<Status>("idle");
  let gemStatus = $state<GeminiStatus>("checking");

  const id = $derived($page.params.id ?? "");
  const running = $derived(
    status === "uploading" || status === "processing" || status === "generating"
  );
  const summaryHtml = $derived(record?.summary ? marked.parse(record.summary) : "");
  const videoSrc = $derived(record ? convertFileSrc(record.localPath) : "");

  const steps = [
    { key: "uploading", label: "Upload" },
    { key: "processing", label: "Process" },
    { key: "generating", label: "Generate" },
  ];
  const stepIndex = $derived.by(() => {
    if (status === "uploading") return 0;
    if (status === "processing") return 1;
    if (status === "generating") return 2;
    if (status === "done") return 3;
    return -1;
  });

  onMount(async () => {
    apiKey = await loadApiKey();
    prompt = await loadPrompt();
    model = await loadModel();
    record = await getVideo(id);
    loaded = true;
    gemStatus = record && apiKey ? await checkGeminiStatus(apiKey, record) : "missing";
  });

  async function handleSummarize() {
    if (!record) return;
    if (!apiKey) {
      toast.error("Set your Gemini API key in Settings first.");
      return;
    }
    try {
      const file = await ensureActiveFile(apiKey, record, (s) => (status = s));
      const { text, usage } = await generateSummary(apiKey, file, prompt, model, (s) => (status = s));
      await saveSummary(record, text, prompt, model, usage);
      record = await getVideo(id);
      gemStatus = "active";
      status = "idle";
      toast.success("Summary ready.");
    } catch (err) {
      status = "error";
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCopy() {
    if (!record?.summary) return;
    await navigator.clipboard.writeText(record.summary);
    toast.success("Summary copied.");
  }

  async function handleExport() {
    if (!record?.summary) return;
    const base = record.videoName.replace(/\.[^.]+$/, "");
    const path = await save({
      defaultPath: `${base}-summary.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (path) {
      await writeTextFile(path, record.summary);
      toast.success("Exported Markdown file.");
    }
  }

  async function handleDelete() {
    if (!record) return;
    const ok = await confirm(
      `Delete "${record.videoName}"? This removes the local copy, its summary, and the Gemini upload. This cannot be undone.`,
      { title: "Delete video", kind: "warning" }
    );
    if (!ok) return;
    try {
      await deleteVideo(apiKey, record);
      toast.success("Video deleted.");
      await goto("/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  let tagInput = $state("");

  async function handleAddTag() {
    if (!record || !tagInput.trim()) return;
    await addTag(record, tagInput);
    record = await getVideo(id);
    tagInput = "";
  }

  async function handleRemoveTag(tag: string) {
    if (!record) return;
    await removeTag(record, tag);
    record = await getVideo(id);
  }

  function fmtSize(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
  }

  function fmtCost(usd: number): string {
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
  }
</script>

<a class="back" href="/"><ArrowLeft size={16} /> Library</a>

{#if !loaded}
  <p class="dim">Loading…</p>
{:else if !record}
  <p class="dim">Video not found.</p>
{:else}
  <header class="page-head">
    <h1>{record.videoName}</h1>
    <button class="btn danger" onclick={handleDelete}><Trash2 size={15} /> Delete</button>
  </header>

  <div class="player card">
    <!-- svelte-ignore a11y_media_has_caption -->
    <video src={videoSrc} controls preload="metadata"></video>
  </div>

  <section class="card">
    <div class="info-row">
      <div class="meta-row">
        <span>{fmtSize(record.sizeBytes)}</span>
        {#if formatDuration(record.durationSec)}<span>· {formatDuration(record.durationSec)}</span>{/if}
        <span>· {record.mimeType}</span>
      </div>
      {#if gemStatus === "checking"}
        <span class="badge"><Cloud size={13} /> Checking Gemini…</span>
      {:else if gemStatus === "active"}
        <span class="badge gem-ok"><CheckCircle2 size={13} /> On Gemini</span>
      {:else if record.geminiName}
        <span class="badge warn"><RefreshCw size={13} /> Expired — will re-upload</span>
      {:else}
        <span class="badge"><CloudOff size={13} /> Local only — will upload</span>
      {/if}
    </div>

    <div class="tags">
      {#each record.tags ?? [] as t (t)}
        <span class="tag-pill">
          <Tag size={11} /> {t}
          <button class="tag-x" onclick={() => handleRemoveTag(t)} aria-label={`Remove ${t}`}>
            <X size={11} />
          </button>
        </span>
      {/each}
      <form class="tag-add" onsubmit={(e) => { e.preventDefault(); handleAddTag(); }}>
        <input
          type="text"
          placeholder="Add tag…"
          bind:value={tagInput}
          maxlength="24"
        />
        <button type="submit" class="tag-add-btn" disabled={!tagInput.trim()} aria-label="Add tag">
          <Plus size={13} />
        </button>
      </form>
    </div>

    {#if running}
      <div class="stepper" in:fade>
        {#each steps as step, i}
          <div class="step" class:active={stepIndex === i} class:done={stepIndex > i}>
            <span class="dot">
              {#if stepIndex > i}<CheckCircle2 size={14} />{:else if stepIndex === i}<span class="pulse"></span>{:else}{i + 1}{/if}
            </span>
            <span class="step-label">{step.label}</span>
          </div>
          {#if i < steps.length - 1}<span class="bar" class:filled={stepIndex > i}></span>{/if}
        {/each}
      </div>
    {/if}

    <div class="actions">
      <button class="btn primary" onclick={handleSummarize} disabled={running || !apiKey}>
        {#if running}
          <span class="mini-spin"></span> Working…
        {:else if record.summary}
          <RefreshCw size={15} /> Re-summarize
        {:else}
          <Sparkles size={15} /> Summarize
        {/if}
      </button>
      {#if !apiKey}
        <span class="dim small">Set your API key in Settings to summarize.</span>
      {/if}
    </div>
  </section>

  {#if record.summary}
    <section class="card" in:fly={{ y: 16, duration: 300 }}>
      <div class="summary-head">
        <h2><Sparkles size={16} /> Summary</h2>
        <div class="actions">
          <button class="btn" onclick={handleCopy}><Copy size={14} /> Copy</button>
          <button class="btn" onclick={handleExport}><Download size={14} /> Export</button>
        </div>
      </div>
      {#if record.summarizedAt}
        <div class="meta-row mono">
          <span>{record.summaryModel}</span>
          {#if record.summaryInputTokens != null}
            <span>· {record.summaryInputTokens.toLocaleString()} in / {(record.summaryOutputTokens ?? 0).toLocaleString()} out</span>
          {/if}
          {#if record.summaryCostUsd != null}
            <span class="cost">· ~{fmtCost(record.summaryCostUsd)}</span>
          {/if}
          <span>· {new Date(record.summarizedAt).toLocaleString()}</span>
        </div>
      {/if}
      <div class="summary markdown">{@html summaryHtml}</div>
    </section>
  {/if}
{/if}

<style>
  .back {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    margin-bottom: 1rem;
    color: var(--accent);
    text-decoration: none;
    font-size: 0.9rem;
  }
  .back:hover { text-decoration: underline; }
  .dim { color: var(--text-dim); }
  .small { font-size: 0.85rem; }

  .page-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  h1 { font-size: 1.3rem; margin: 0; word-break: break-word; letter-spacing: -0.01em; }
  h2 { font-size: 1.05rem; margin: 0; display: flex; align-items: center; gap: 0.4rem; }
  h2 :global(svg) { color: var(--accent); }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.1rem 1.25rem;
    margin-top: 1rem;
    box-shadow: var(--shadow);
  }
  .player { padding: 0; overflow: hidden; }
  .player video { width: 100%; display: block; max-height: 420px; background: #000; }

  .meta-row { font-size: 0.82rem; color: var(--text-dim); display: flex; gap: 0.35rem; flex-wrap: wrap; }
  .meta-row.mono { font-family: "JetBrains Mono", monospace; margin-top: 0.4rem; }

  .info-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    padding-bottom: 0.85rem;
    margin-bottom: 0.85rem;
    border-bottom: 1px solid var(--border);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.78rem;
    padding: 0.22rem 0.55rem;
    border-radius: 999px;
    background: var(--hover);
    color: var(--text-dim);
  }
  .badge.gem-ok { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
  .badge.warn { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }

  .tags { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin-bottom: 0.7rem; }
  .tag-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.78rem;
    padding: 0.22rem 0.3rem 0.22rem 0.55rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
  }
  .tag-x {
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    padding: 0.05rem;
    border-radius: 999px;
    opacity: 0.7;
  }
  .tag-x:hover { opacity: 1; background: color-mix(in srgb, var(--accent) 20%, transparent); }
  .tag-add { display: inline-flex; align-items: center; gap: 0.2rem; }
  .tag-add input {
    width: 100px;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg);
    color: var(--text);
    font-size: 0.78rem;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s, width 0.15s;
  }
  .tag-add input:focus { border-color: var(--accent); width: 130px; }
  .tag-add-btn {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-dim);
    cursor: pointer;
  }
  .tag-add-btn:hover:not(:disabled) { background: var(--accent); color: #fff; border-color: var(--accent); }
  .tag-add-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .stepper { display: flex; align-items: center; margin: 0.5rem 0 1rem; }
  .step { display: flex; align-items: center; gap: 0.45rem; color: var(--text-dim); }
  .step .dot {
    width: 24px; height: 24px;
    border-radius: 50%;
    border: 1.5px solid var(--border);
    display: grid; place-items: center;
    font-size: 0.75rem;
  }
  .step.active .dot { border-color: var(--accent); color: var(--accent); }
  .step.active .step-label { color: var(--text); }
  .step.done .dot { background: var(--ok); border-color: var(--ok); color: #fff; }
  .step.done :global(svg) { color: #fff; }
  .step-label { font-size: 0.82rem; }
  .pulse {
    width: 9px; height: 9px; border-radius: 50%;
    background: var(--accent);
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.7); } }
  .bar { flex: 1; height: 2px; background: var(--border); margin: 0 0.5rem; border-radius: 2px; }
  .bar.filled { background: var(--ok); }

  .actions { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.5rem; }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0.85rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    font-size: 0.9rem;
    font-family: inherit;
    transition: background 0.15s, border-color 0.15s, transform 0.1s;
  }
  .btn:hover:not(:disabled) { background: var(--hover); }
  .btn:active:not(:disabled) { transform: translateY(1px); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
  .btn.danger:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); }

  .summary-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.3rem; gap: 1rem; }
  .summary { margin-top: 0.7rem; line-height: 1.6; }
  .markdown :global(h1), .markdown :global(h2), .markdown :global(h3) { margin: 1.1rem 0 0.4rem; line-height: 1.3; }
  .markdown :global(ul), .markdown :global(ol) { padding-left: 1.4rem; }
  .markdown :global(li) { margin: 0.2rem 0; }
  .markdown :global(p) { margin: 0.5rem 0; }
  .markdown :global(code) {
    background: var(--hover);
    padding: 0.1rem 0.35rem;
    border-radius: 5px;
    font-size: 0.88em;
    font-family: "JetBrains Mono", monospace;
  }
  .markdown :global(pre) { background: var(--hover); padding: 0.8rem; border-radius: var(--radius-sm); overflow-x: auto; }
  .markdown :global(strong) { color: var(--text); }

  .mini-spin, .pulse { display: inline-block; }
  .mini-spin {
    width: 14px; height: 14px;
    border: 2px solid rgba(255,255,255,0.4);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
