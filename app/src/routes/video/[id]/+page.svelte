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
    Film, Camera, Play, SlidersHorizontal, ChevronDown,
  } from "lucide-svelte";

  import {
    loadApiKey, loadPrompt, loadDiagramPrompt, loadGitHubToken,
    loadMaxToolTurns, DEFAULT_MAX_TOOL_TURNS,
  } from "$lib/settings";
  import {
    DEFAULT_MODEL, type Status, generateSummary, generateDiagram,
    generateChatReply, generateRepoChatReply, composePrompt,
    type ChatMessage, type GeminiFile,
  } from "$lib/gemini";
  import {
    fetchCommitsSince, fetchCommitDetail, fetchFileContent,
    fetchDirectory, searchCode, type RepoRef,
  } from "$lib/github";
  import {
    getVideo, ensureActiveFile, saveSummary, saveDiagram, saveHighlightMedia,
    deleteVideo, checkGeminiStatus, addTag, removeTag, saveCustomInstructions,
    saveChat, isYouTube, isLoom, isGitHub, parseYouTubeId,
    type VideoRecord, type GeminiStatus, type Highlight,
  } from "$lib/videoLibrary";
  import ChatPanel from "$lib/ChatPanel.svelte";
  import RepoActivity from "$lib/RepoActivity.svelte";
  import { captureFrame, sampleFrames } from "$lib/frames";

  import { mediaSrc, mediaAbsPath } from "$lib/media";
  import { formatDuration } from "$lib/thumbnail";
  import { toast } from "$lib/toast";


  let record = $state<VideoRecord | null>(null);
  let loaded = $state(false);
  let apiKey = $state("");
  let githubToken = $state("");
  let maxToolTurns = $state(DEFAULT_MAX_TOOL_TURNS);
  let prompt = $state("");
  let diagramPrompt = $state("");
  const model = DEFAULT_MODEL;

  const DIAGRAM_FRAME_COUNT = 8;

  let status = $state<Status>("idle");
  let gemStatus = $state<GeminiStatus>("checking");

  let wantDiagram = $state(true);
  let wantHighlights = $state(true);
  let instructionsOpen = $state(false);
  let customInstructions = $state("");
  let customDiagramInstructions = $state("");
  let diagramRunning = $state(false);
  let renderingIds = $state<Set<string>>(new Set());

  type DetailTab = "summary" | "diagram" | "highlights";
  let activeTab = $state<DetailTab>("summary");

  let playerEl = $state<HTMLVideoElement | null>(null);
  let chatMessages = $state<ChatMessage[]>([]);
  let chatToolStatus = $state<string | null>(null);

  // Resolved asset-protocol URLs for disk-backed media (paths are async).
  let diagramUrl = $state("");
  let highlightUrls = $state<Record<string, string>>({});
  let lightbox = $state<{ src: string; label: string } | null>(null);


  const id = $derived($page.params.id ?? "");
  const isYt = $derived(record ? isYouTube(record) : false);
  const isRepo = $derived(record ? isGitHub(record) : false);
  const ytId = $derived(record?.sourceUrl ? parseYouTubeId(record.sourceUrl) : null);
  // Reactive start offset so "Jump" can reload the embed at a timestamp.
  let ytStart = $state<number | null>(null);
  const ytEmbedSrc = $derived(
    ytId
      ? `https://www.youtube-nocookie.com/embed/${ytId}${ytStart != null ? `?start=${Math.floor(ytStart)}&autoplay=1` : ""}`
      : ""
  );

  const running = $derived(
    status === "uploading" || status === "processing" || status === "generating"
  );
  const summaryHtml = $derived(record?.summary ? marked.parse(record.summary) : "");
  const videoSrc = $derived(record?.localPath ? convertFileSrc(record.localPath) : "");


  const allSteps = [
    { key: "uploading", label: "Upload" },
    { key: "processing", label: "Process" },
    { key: "generating", label: "Generate" },
  ];
  // YouTube sources skip the upload/process phases entirely.
  const steps = $derived(isYt ? allSteps.slice(2) : allSteps);
  const stepIndex = $derived.by(() => {
    const offset = isYt ? 2 : 0;
    if (status === "uploading") return 0 - offset;
    if (status === "processing") return 1 - offset;
    if (status === "generating") return 2 - offset;
    if (status === "done") return steps.length;
    return -1;
  });

  onMount(async () => {
    apiKey = await loadApiKey();
    githubToken = await loadGitHubToken();
    maxToolTurns = await loadMaxToolTurns();
    prompt = await loadPrompt();
    diagramPrompt = await loadDiagramPrompt();
    record = await getVideo(id);
    customInstructions = record?.customInstructions ?? "";
    customDiagramInstructions = record?.customDiagramInstructions ?? "";
    chatMessages = record?.chat ?? [];
    // Default to the first tab that actually has content.
    if (record && !record.summary) {
      if (record.diagramPath) activeTab = "diagram";
      else if (record.highlights.length > 0) activeTab = "highlights";
    }
    loaded = true;
    gemStatus =
      record && apiKey && !isYouTube(record) && !isGitHub(record)
        ? await checkGeminiStatus(apiKey, record)
        : "missing";
    // Auto-render any highlights still missing their local media (e.g. captured
    // on an older build or interrupted mid-run). This costs only compute.
    // YouTube sources have no local file to capture frames from.
    if (record && !isYouTube(record) && !isGitHub(record) && record.highlights.some((h) => !h.mediaPath)) {
      await renderAllHighlights();
    }
    await resolveMediaUrls();
  });

  /** Resolve all disk-backed media paths into asset-protocol URLs for display. */
  async function resolveMediaUrls() {
    if (!record) return;
    // Cache-bust the diagram: the file is always saved under the same
    // filename, so without a changing query param the browser/webview would
    // keep showing the previously-cached image after a regenerate.
    diagramUrl = record.diagramPath
      ? `${await mediaSrc(record.diagramPath)}?t=${record.diagramGeneratedAt ?? ""}`
      : "";
    const urls: Record<string, string> = {};
    for (const h of record.highlights) {
      if (h.mediaPath) urls[h.id] = await mediaSrc(h.mediaPath);
    }
    highlightUrls = urls;
  }


  /** Persist the current custom-instruction inputs onto the record. */
  async function persistInstructions() {
    if (!record) return;
    await saveCustomInstructions(record, customInstructions, customDiagramInstructions);
  }

  const hasInstructions = $derived(
    customInstructions.trim() !== "" || customDiagramInstructions.trim() !== ""
  );

  async function handleSummarize() {
    if (!record) return;
    if (!apiKey) {
      toast.error("Set your Gemini API key in Settings first.");
      return;
    }
    try {
      await persistInstructions();
      const effectivePrompt = composePrompt(prompt, customInstructions);
      const file = await ensureActiveFile(apiKey, record, (s) => (status = s));
      const { text, highlights, usage } = await generateSummary(
        apiKey, file, effectivePrompt, model, (s) => (status = s), wantHighlights
      );
      await saveSummary(record, text, effectivePrompt, model, usage, wantHighlights ? highlights : undefined);

      if (wantDiagram) {
        diagramRunning = true;
        // Sample real frames locally so the image model can match demonstrated
        // UI aesthetics without re-ingesting (and re-billing) the whole video.
        // YouTube sources have no local file — the summary alone grounds it.
        const frames = isYt ? [] : await sampleFrames(record.localPath, DIAGRAM_FRAME_COUNT);
        const diagram = await generateDiagram(
          apiKey, text, composePrompt(diagramPrompt, customDiagramInstructions), frames
        );
        await saveDiagram(record, diagram.image, diagram.costUsd);
        diagramRunning = false;
      }

      record = await getVideo(id);
      gemStatus = "active";
      status = "idle";
      toast.success("Summary ready.");
      // Highlight images are captured locally (no API cost), so render them
      // automatically rather than making the user click each one.
      if (wantHighlights && !isYt) await renderAllHighlights();
      await resolveMediaUrls();
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
    if (!record.summary) {
      toast.error("Summarize the video first — the diagram is generated from the summary.");
      return;
    }
    try {
      diagramRunning = true;
      await persistInstructions();
      status = "idle";
      // Re-sample frames so the image model has fresh local reference material.
      const frames = isYt ? [] : await sampleFrames(record.localPath, DIAGRAM_FRAME_COUNT);
      const diagram = await generateDiagram(
        apiKey, record.summary, composePrompt(diagramPrompt, customDiagramInstructions), frames
      );
      await saveDiagram(record, diagram.image, diagram.costUsd);
      record = await getVideo(id);
      gemStatus = "active";
      await resolveMediaUrls();
      toast.success("Diagram regenerated.");
    } catch (err) {
      status = "idle";
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      diagramRunning = false;
    }
  }

  function seekPlayer(sec: number | null) {
    if (sec == null) return;
    if (isYt) {
      // Reload the embed at the timestamp; the iframe API isn't wired up.
      ytStart = sec;
      return;
    }
    if (playerEl) {
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

  /** Execute one GitHub research tool call on behalf of the repo chat. */
  async function runRepoTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const info = record?.repoInfo;
    if (!info) throw new Error("Repo metadata missing.");
    const ref: RepoRef = { owner: info.owner, repo: info.repo };
    switch (name) {
      case "list_commits": {
        const days = Math.max(1, Math.min(365, Number(args.since_days) || 7));
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        return fetchCommitsSince(ref, since, githubToken);
      }
      case "get_commit_diff":
        return fetchCommitDetail(ref, String(args.sha), githubToken);
      case "read_file":
        return fetchFileContent(ref, String(args.path), githubToken);
      case "list_directory":
        return fetchDirectory(ref, String(args.path ?? ""), githubToken);
      case "search_code":
        return searchCode(ref, String(args.query), githubToken);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /** Agentic repo Q&A: Gemini researches the repo with live GitHub tools. */
  async function askRepo(
    question: string
  ): Promise<{ text: string; costUsd: number; toolCalls?: string[] }> {
    const info = record!.repoInfo!;
    const repoContext =
      `GitHub repository: ${info.owner}/${info.repo}\n` +
      (info.description ? `Description: ${info.description}\n` : "") +
      (info.language ? `Primary language: ${info.language}\n` : "") +
      `Default branch: ${info.defaultBranch}\n` +
      (info.pushedAt ? `Last push: ${info.pushedAt}\n` : "");
    try {
      const reply = await generateRepoChatReply(
        apiKey, question, chatMessages.slice(0, -1),
        repoContext, record!.repoDigests ?? [],
        runRepoTool, (label) => (chatToolStatus = label), maxToolTurns
      );
      return { text: reply.text, costUsd: reply.usage.costUsd, toolCalls: reply.toolCalls };
    } finally {
      chatToolStatus = null;
    }
  }

  /** Video Q&A grounded in the summary (attaching the video when active). */
  async function askVideo(
    question: string
  ): Promise<{ text: string; costUsd: number; toolCalls?: string[] }> {
    let file: GeminiFile | null = null;
    if (isYt || gemStatus === "active") {
      file = await ensureActiveFile(apiKey, record!, () => {});
    }
    const reply = await generateChatReply(
      apiKey, question, chatMessages.slice(0, -1),
      record!.summary ?? "", record!.videoName, file
    );
    return { text: reply.text, costUsd: reply.usage.costUsd };
  }

  async function handleAsk(question: string) {
    if (!record) return;
    const userMsg: ChatMessage = { role: "user", text: question, at: new Date().toISOString() };
    chatMessages = [...chatMessages, userMsg];
    try {
      const reply = isRepo && record.repoInfo
        ? await askRepo(question)
        : await askVideo(question);
      const modelMsg: ChatMessage = {
        role: "model",
        text: reply.text,
        at: new Date().toISOString(),
        costUsd: reply.costUsd,
      };
      if (reply.toolCalls?.length) modelMsg.toolCalls = reply.toolCalls;
      chatMessages = [...chatMessages, modelMsg];
      await saveChat(record, chatMessages);
    } catch (err) {
      chatMessages = chatMessages.slice(0, -1);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleClearChat() {
    if (!record) return;
    chatMessages = [];
    await saveChat(record, []);
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

  {#if isRepo}
    <RepoActivity {record} {apiKey} {githubToken} />
  {:else}
  <div class="player card">
    {#if isYt}
      <iframe
        class="yt-embed"
        src={ytEmbedSrc}
        title={record.videoName}
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen
      ></iframe>
    {:else}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={playerEl} src={videoSrc} controls preload="metadata"></video>
    {/if}
  </div>

  <section class="card">
    <div class="info-row">
      <div class="meta-row">
        {#if isYt}
          <a class="yt-link" href={record.sourceUrl} target="_blank" rel="noreferrer">
            {record.sourceUrl}
          </a>
        {:else}
          <span>{fmtSize(record.sizeBytes)}</span>
          {#if formatDuration(record.durationSec)}<span>· {formatDuration(record.durationSec)}</span>{/if}
          <span>· {record.mimeType}</span>
          {#if isLoom(record) && record.sourceUrl}
            <span>·</span>
            <a class="yt-link" href={record.sourceUrl} target="_blank" rel="noreferrer">Loom source</a>
          {/if}
        {/if}
      </div>
      {#if isYt}
        <span class="badge gem-ok"><CircleCheck size={13} /> YouTube source</span>
      {:else if gemStatus === "checking"}
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

    <div class="instructions">
      <button
        type="button"
        class="instructions-toggle"
        onclick={() => (instructionsOpen = !instructionsOpen)}
        aria-expanded={instructionsOpen}
      >
        <SlidersHorizontal size={14} />
        Custom instructions
        {#if hasInstructions && !instructionsOpen}
          <span class="instr-badge">active</span>
        {/if}
        <span class="chev" class:open={instructionsOpen}><ChevronDown size={14} /></span>
      </button>
      {#if instructionsOpen}
        <div class="instructions-body" transition:fade={{ duration: 120 }}>
          <label class="instr-field">
            <span class="instr-label"><Sparkles size={12} /> Summary instructions</span>
            <textarea
              rows="3"
              placeholder="Optional extra guidance for this video, e.g. “Focus on the architecture discussion” or “The presenter is Sarah”…"
              bind:value={customInstructions}
              onblur={persistInstructions}
              disabled={running}
            ></textarea>
          </label>
          <label class="instr-field">
            <span class="instr-label"><ImageIcon size={12} /> Diagram instructions</span>
            <textarea
              rows="3"
              placeholder="Optional extra guidance for the diagram, e.g. “Show the data flow between the three services”…"
              bind:value={customDiagramInstructions}
              onblur={persistInstructions}
              disabled={running || diagramRunning}
            ></textarea>
          </label>
          <p class="instr-hint">
            Appended to your default prompts (Settings) for this video only. Saved automatically.
          </p>
        </div>
      {/if}
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
  {/if}

  {#if !isRepo && (record.summary || record.diagramPath || record.highlights.length > 0)}
    <nav class="tabs" in:fade={{ duration: 150 }}>
      <button
        class="tab"
        class:on={activeTab === "summary"}
        onclick={() => (activeTab = "summary")}
        disabled={!record.summary}
      >
        <Sparkles size={14} /> Summary
      </button>
      <button
        class="tab"
        class:on={activeTab === "diagram"}
        onclick={() => (activeTab = "diagram")}
        disabled={!record.diagramPath}
      >
        <ImageIcon size={14} /> Diagram
      </button>
      <button
        class="tab"
        class:on={activeTab === "highlights"}
        onclick={() => (activeTab = "highlights")}
        disabled={record.highlights.length === 0}
      >
        <Film size={14} /> Highlights
        {#if record.highlights.length > 0}
          <span class="tab-count">{record.highlights.length}</span>
        {/if}
      </button>
    </nav>
  {/if}

  {#if record.summary && activeTab === "summary"}
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

  {#if record.diagramPath && activeTab === "diagram"}
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


  {#if record.highlights.length > 0 && activeTab === "highlights"}
    <section class="card" in:fly={{ y: 16, duration: 300 }}>
      <div class="summary-head">
        <h2><Film size={16} /> Highlights</h2>
      </div>
      {#if isYt}
        <p class="hl-note">Screenshots aren't available for YouTube videos — use Jump to view each moment in the player.</p>
      {/if}
      <div class="highlight-grid">
        {#each record.highlights as h (h.id)}
          <div class="highlight">
            {#if !isYt}
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
            {/if}
            <div class="hl-body">
              <div class="hl-label">{h.label}</div>
              <div class="hl-time">{fmtTime(h.atSec)}</div>
              <div class="hl-actions">
                <button class="btn small-btn" onclick={() => seekPlayer(h.atSec)}>

                  <Play size={12} /> Jump
                </button>
                {#if h.mediaPath && !isYt}
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

  <ChatPanel
    title={record.videoName}
    messages={chatMessages}
    onAsk={handleAsk}
    onClear={handleClearChat}
    onSeek={(sec) => seekPlayer(sec)}
    disabled={!apiKey}
    toolStatus={chatToolStatus}
    emptyHint={isRepo
      ? "Ask about this repo — I can read files, commits, and diffs on demand."
      : record.summary
        ? "Ask anything about this video — answers include clickable timestamps."
        : "Summarize the video first for the best answers, or ask away."}
  />

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
  .yt-embed { width: 100%; aspect-ratio: 16 / 9; display: block; background: #000; border: none; }

  .yt-link { color: var(--accent); text-decoration: none; word-break: break-all; }
  .yt-link:hover { text-decoration: underline; }

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

  .tabs {
    display: flex;
    gap: 0.35rem;
    margin-top: 1rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0;
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
  .tab.on {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .tab:disabled { opacity: 0.4; cursor: not-allowed; }
  .tab-count {
    font-size: 0.7rem;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
  }

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

  .instructions { margin-top: 0.6rem; }
  .instructions-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-size: 0.86rem;
    font-family: inherit;
    cursor: pointer;
    padding: 0.2rem 0;
  }
  .instructions-toggle:hover { color: var(--text); }
  .instructions-toggle :global(svg) { color: var(--accent); }
  .chev { display: inline-flex; transition: transform 0.15s; }
  .chev.open { transform: rotate(180deg); }
  .instr-badge {
    font-size: 0.68rem;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent);
  }
  .instructions-body {
    margin-top: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .instr-field { display: flex; flex-direction: column; gap: 0.3rem; }
  .instr-label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.78rem;
    color: var(--text-dim);
  }
  .instr-label :global(svg) { color: var(--accent); }
  .instr-field textarea {
    width: 100%;
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    font-size: 0.88rem;
    font-family: inherit;
    line-height: 1.5;
    resize: vertical;
    transition: border-color 0.15s;
  }
  .instr-field textarea:focus { outline: none; border-color: var(--accent); }
  .instr-field textarea:disabled { opacity: 0.6; }
  .instr-hint { font-size: 0.76rem; color: var(--text-dim); margin: 0; }

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
  .hl-note { margin: 0.5rem 0 0; font-size: 0.8rem; color: var(--text-dim); }
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
