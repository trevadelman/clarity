<script lang="ts">
  import { onMount } from "svelte";
  import { fade, fly } from "svelte/transition";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { confirm, save } from "@tauri-apps/plugin-dialog";
  import { writeTextFile, writeFile, readFile } from "@tauri-apps/plugin-fs";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { marked } from "marked";
  import {
    ArrowLeft, Trash2, Sparkles, RefreshCw, Copy, Download,
    Cloud, CloudOff, CircleCheck, Tag, X, Plus, Image as ImageIcon,
    Film, Camera, Play,
  } from "lucide-svelte";

  import { loadApiKey, loadPrompt, loadDiagramPrompt, loadModel } from "$lib/settings";
  import {
    DEFAULT_MODEL, type ModelId, type Status, generateSummary, generateDiagram,
  } from "$lib/gemini";
  import {
    getVideo, ensureActiveFile, saveSummary, saveDiagram, saveHighlightMedia,
    deleteVideo, checkGeminiStatus, addTag, removeTag,
    type VideoRecord, type GeminiStatus, type Highlight,
  } from "$lib/videoLibrary";
  import { captureFrame, sampleFrames } from "$lib/frames";

  import { mediaSrc, mediaAbsPath } from "$lib/media";
  import { formatDuration } from "$lib/thumbnail";
  import { toast } from "$lib/toast";


  let record = $state<VideoRecord | null>(null);
  let loaded = $state(false);
  let apiKey = $state("");
  let prompt = $state("");
  let diagramPrompt = $state("");
  let model = $state<ModelId>(DEFAULT_MODEL);

  const DIAGRAM_FRAME_COUNT = 8;

  let status = $state<Status>("idle");
  let gemStatus = $state<GeminiStatus>("checking");

  let wantDiagram = $state(true);
  let wantHighlights = $state(true);
  let diagramRunning = $state(false);
  let renderingIds = $state<Set<string>>(new Set());

  let playerEl = $state<HTMLVideoElement | null>(null);

  // Resolved asset-protocol URLs for disk-backed media (paths are async).
  let diagramUrl = $state("");
  let highlightUrls = $state<Record<string, string>>({});
  let lightbox = $state<{ src: string; label: string } | null>(null);


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
    diagramPrompt = await loadDiagramPrompt();
    model = await loadModel();
    record = await getVideo(id);
    loaded = true;
    gemStatus = record && apiKey ? await checkGeminiStatus(apiKey, record) : "missing";
    // Auto-render any highlights still missing their local media (e.g. captured
    // on an older build or interrupted mid-run). This costs only compute.
    if (record?.highlights.some((h) => !h.mediaPath)) await renderAllHighlights();
    await resolveMediaUrls();
  });

  /** Resolve all disk-backed media paths into asset-protocol URLs for display. */
  async function resolveMediaUrls() {
    if (!record) return;
    diagramUrl = record.diagramPath ? await mediaSrc(record.diagramPath) : "";
    const urls: Record<string, string> = {};
    for (const h of record.highlights) {
      if (h.mediaPath) urls[h.id] = await mediaSrc(h.mediaPath);
    }
    highlightUrls = urls;
  }


  async function handleSummarize() {
    if (!record) return;
    if (!apiKey) {
      toast.error("Set your Gemini API key in Settings first.");
      return;
    }
    try {
      const file = await ensureActiveFile(apiKey, record, (s) => (status = s));
      const { text, highlights, usage } = await generateSummary(
        apiKey, file, prompt, model, (s) => (status = s), wantHighlights
      );
      await saveSummary(record, text, prompt, model, usage, wantHighlights ? highlights : undefined);

      if (wantDiagram) {
        diagramRunning = true;
        // Sample real frames locally so the image model can match demonstrated
        // UI aesthetics without re-ingesting (and re-billing) the whole video.
        const frames = await sampleFrames(record.localPath, DIAGRAM_FRAME_COUNT);
        const diagram = await generateDiagram(apiKey, file, diagramPrompt, frames);
        await saveDiagram(record, diagram.image, diagram.costUsd);
        diagramRunning = false;
      }

      record = await getVideo(id);
      gemStatus = "active";
      status = "idle";
      toast.success("Summary ready.");
      // Highlight images are captured locally (no API cost), so render them
      // automatically rather than making the user click each one.
      if (wantHighlights) await renderAllHighlights();
    } catch (err) {
      status = "error";
      diagramRunning = false;
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRegenerateDiagram() {
    if (!record || diagramRunning) return;
    if (!apiKey) {
      toast.error("Set your Gemini API key in Settings first.");
      return;
    }
    try {
      diagramRunning = true;
      const file = await ensureActiveFile(apiKey, record, (s) => (status = s));
      status = "idle";
      // Re-sample frames so the image model has fresh local reference material.
      const frames = await sampleFrames(record.localPath, DIAGRAM_FRAME_COUNT);
      const diagram = await generateDiagram(apiKey, file, diagramPrompt, frames);
      await saveDiagram(record, diagram.image, diagram.costUsd);
      record = await getVideo(id);
      gemStatus = "active";
      toast.success("Diagram regenerated.");
    } catch (err) {
      status = "idle";
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      diagramRunning = false;
    }
  }

  function seekPlayer(sec: number | null) {
    if (playerEl && sec != null) {
      playerEl.currentTime = sec;
      playerEl.play().catch(() => {});
      playerEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  async function renderHighlight(h: Highlight) {
    if (!record || renderingIds.has(h.id)) return;
    renderingIds = new Set(renderingIds).add(h.id);
    try {
      // Capture a still frame at the highlighted moment, stored on disk.
      const image = await captureFrame(record.localPath, h.atSec ?? 0);
      await saveHighlightMedia(record, h.id, image);
      record = await getVideo(id);

      await resolveMediaUrls();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      const next = new Set(renderingIds);
      next.delete(h.id);
      renderingIds = next;
    }
  }

  async function renderAllHighlights() {
    if (!record) return;
    for (const h of record.highlights) {
      if (!h.mediaPath) await renderHighlight(h);
    }
  }

  async function exportHighlight(h: Highlight) {
    if (!h.mediaPath || !record) return;
    const base = h.label.replace(/[^\w]+/g, "-").toLowerCase().slice(0, 40) || "highlight";
    const path = await save({
      defaultPath: `${base}.png`,
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    if (!path) return;
    await writeFile(path, await readFile(await mediaAbsPath(h.mediaPath)));
    toast.success("Exported.");
  }


  async function exportDiagram() {
    if (!record?.diagramPath) return;
    const base = record.videoName.replace(/\.[^.]+$/, "");
    const path = await save({
      defaultPath: `${base}-diagram.png`,
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    if (!path) return;
    await writeFile(path, await readFile(await mediaAbsPath(record.diagramPath)));
    toast.success("Diagram exported.");
  }

  function openLightbox(h: Highlight) {
    const src = highlightUrls[h.id];
    if (!src) return;
    lightbox = { src, label: h.label };
  }



  function fmtTime(sec: number | null): string {
    if (sec == null) return "";
    return formatDuration(sec) ?? "";
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
    <video bind:this={playerEl} src={videoSrc} controls preload="metadata"></video>
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
        <span class="badge gem-ok"><CircleCheck size={13} /> On Gemini</span>
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
              {#if stepIndex > i}<CircleCheck size={14} />{:else if stepIndex === i}<span class="pulse"></span>{:else}{i + 1}{/if}
            </span>
            <span class="step-label">{step.label}</span>
          </div>
          {#if i < steps.length - 1}<span class="bar" class:filled={stepIndex > i}></span>{/if}
        {/each}
      </div>
    {/if}

    <div class="gen-options">
      <label class="opt">
        <input type="checkbox" bind:checked={wantDiagram} disabled={running} />
        <ImageIcon size={14} /> Generate diagram
      </label>
      <label class="opt">
        <input type="checkbox" bind:checked={wantHighlights} disabled={running} />
        <Film size={14} /> Detect highlight moments
      </label>
    </div>

    <div class="actions">
      <button class="btn primary" onclick={handleSummarize} disabled={running || diagramRunning || !apiKey}>
        {#if running}
          <span class="mini-spin"></span> Working…
        {:else if diagramRunning}
          <span class="mini-spin"></span> Drawing diagram…
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

  {#if record.diagramPath}
    <section class="card" in:fly={{ y: 16, duration: 300 }}>
      <div class="summary-head">
        <h2><ImageIcon size={16} /> Diagram</h2>
        <div class="actions">
          <button class="btn" onclick={handleRegenerateDiagram} disabled={diagramRunning || running || !apiKey}>
            {#if diagramRunning}<span class="mini-spin dark"></span> Regenerating…{:else}<RefreshCw size={14} /> Regenerate{/if}
          </button>
          <button class="btn" onclick={exportDiagram}><Download size={14} /> Export</button>
        </div>
      </div>
      {#if record.diagramCostUsd != null}
        <div class="meta-row mono"><span>{`Gemini image · ~${fmtCost(record.diagramCostUsd)}`}</span></div>
      {/if}
      {#if diagramUrl}
        <img class="diagram" src={diagramUrl} alt="Generated diagram" />
      {/if}
    </section>
  {/if}


  {#if record.highlights.length > 0}
    <section class="card" in:fly={{ y: 16, duration: 300 }}>
      <div class="summary-head">
        <h2><Film size={16} /> Highlights</h2>
      </div>
      <div class="highlight-grid">
        {#each record.highlights as h (h.id)}
          <div class="highlight">
            <button
              type="button"
              class="hl-media"
              onclick={() => openLightbox(h)}
              disabled={!highlightUrls[h.id]}
            >
              {#if highlightUrls[h.id]}
                <img src={highlightUrls[h.id]} alt={h.label} />
              {:else}
                <div class="hl-placeholder"><Camera size={22} /></div>
              {/if}
              <span class="hl-kind"><Camera size={11} /> Frame</span>
            </button>
            <div class="hl-body">
              <div class="hl-label">{h.label}</div>
              <div class="hl-time">{fmtTime(h.atSec)}</div>
              <div class="hl-actions">
                <button class="btn small-btn" onclick={() => seekPlayer(h.atSec)}>

                  <Play size={12} /> Jump
                </button>
                {#if h.mediaPath}
                  <button class="btn small-btn" onclick={() => exportHighlight(h)}>
                    <Download size={12} /> Save
                  </button>
                {:else if renderingIds.has(h.id)}
                  <span class="hl-rendering"><span class="mini-spin dark"></span> Rendering…</span>
                {/if}
              </div>
            </div>
          </div>
        {/each}

      </div>
    </section>
  {/if}

  {#if lightbox}
    <div
      class="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={lightbox.label}
      tabindex="-1"
      transition:fade={{ duration: 150 }}
      onclick={() => (lightbox = null)}
      onkeydown={(e) => { if (e.key === "Escape") lightbox = null; }}
    >
      <button class="lightbox-close" onclick={() => (lightbox = null)} aria-label="Close">
        <X size={22} />
      </button>
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div class="lightbox-inner" role="presentation" onclick={(e) => e.stopPropagation()}>
        <img src={lightbox.src} alt={lightbox.label} />
        <p class="lightbox-label">{lightbox.label}</p>
      </div>

    </div>
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
  .mini-spin.dark { border-color: color-mix(in srgb, var(--accent) 30%, transparent); border-top-color: var(--accent); }
  @keyframes spin { to { transform: rotate(360deg); } }

  .gen-options { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: 0.4rem; }
  .opt {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.86rem;
    color: var(--text-dim);
    cursor: pointer;
    user-select: none;
  }
  .opt input { accent-color: var(--accent); width: 15px; height: 15px; cursor: pointer; }
  .opt :global(svg) { color: var(--accent); }

  .diagram {
    margin-top: 0.7rem;
    width: 100%;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: #fff;
  }

  .highlight-grid {
    margin-top: 0.7rem;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 0.8rem;
  }
  .highlight {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--bg);
    display: flex;
    flex-direction: column;
  }
  .hl-media {
    position: relative;
    aspect-ratio: 16 / 9;
    background: #000;
    border: none;
    padding: 0;
    width: 100%;
    cursor: pointer;
    display: block;
  }
  .hl-media:disabled { cursor: default; }
  .hl-media img { width: 100%; height: 100%; object-fit: cover; display: block; }


  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgba(0, 0, 0, 0.82);
    display: grid;
    place-items: center;
    padding: 2rem;
  }
  .lightbox-close {
    position: absolute;
    top: 1rem;
    right: 1rem;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border: none;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
    cursor: pointer;
  }
  .lightbox-close:hover { background: rgba(255, 255, 255, 0.24); }
  .lightbox-inner { max-width: 90vw; max-height: 85vh; text-align: center; }
  .lightbox-inner img {
    max-width: 90vw;
    max-height: 78vh;
    border-radius: var(--radius-sm);
    background: #000;
  }

  .lightbox-label { color: #fff; margin: 0.75rem 0 0; font-size: 0.9rem; }

  .hl-placeholder {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    color: var(--text-dim);
    background: var(--hover);
  }
  .hl-kind {
    position: absolute;
    top: 0.4rem;
    left: 0.4rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.68rem;
    padding: 0.12rem 0.4rem;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
  }
  .hl-body { padding: 0.55rem 0.65rem 0.65rem; display: flex; flex-direction: column; gap: 0.3rem; }
  .hl-label { font-size: 0.84rem; font-weight: 500; line-height: 1.3; }
  .hl-time { font-size: 0.72rem; color: var(--text-dim); font-family: "JetBrains Mono", monospace; }
  .hl-actions { display: flex; gap: 0.35rem; margin-top: 0.15rem; align-items: center; }
  .hl-rendering {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.74rem;
    color: var(--text-dim);
  }
  .small-btn { padding: 0.3rem 0.5rem; font-size: 0.76rem; }
</style>
