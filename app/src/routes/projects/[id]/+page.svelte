<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { marked } from "marked";
  import { appDataDir } from "@tauri-apps/api/path";
  import {
    ArrowLeft, FolderKanban, Plus, X, Pencil, Check, Download,
    FileText, GitBranch, Video, MonitorPlay, Film, Trash2, RefreshCw,
  } from "lucide-svelte";
  import {
    getProject, updateProject, addMember, removeMember, saveProjectChat,
    removeReport, type Project, type Report,
  } from "$lib/projects";
  import {
    generateAndSaveReport, removeReportDir, resolveReportImages, exportReportHtml,
  } from "$lib/reports";
  import {
    listVideos, ensureActiveFile, isGitHub, parseYouTubeId,
    type VideoRecord, type SourceType,
  } from "$lib/videoLibrary";
  import {
    generateProjectChatReply, DEFAULT_REPORT_PROMPT,
    type ChatMessage, type ProjectChatVideo,
  } from "$lib/gemini";
  import {
    fetchCommitsSince, fetchCommitDetail, fetchFileContent,
    fetchDirectory, searchCode, type RepoRef,
  } from "$lib/github";
  import {
    loadApiKey, loadGitHubToken, loadMaxToolTurns, DEFAULT_MAX_TOOL_TURNS,
  } from "$lib/settings";
  import ChatPanel from "$lib/ChatPanel.svelte";
  import ResearchPanel from "$lib/ResearchPanel.svelte";
  import CanvasResearchView from "./CanvasResearchView.svelte";
  import { urlForToolCall, fileUrl, commitUrl, repoHomeUrl } from "$lib/researchView";
  import { toast } from "$lib/toast";

  let project = $state<Project | null>(null);
  let library = $state<VideoRecord[]>([]);
  let notFound = $state(false);
  let apiKey = $state("");
  let githubToken = $state("");
  let maxToolTurns = $state(DEFAULT_MAX_TOOL_TURNS);

  // ── Workspace canvas ────────────────────────────────────────────────
  // The main window is contextual: overview (members + reports) by
  // default; chat citations and member chips swap in a video player or
  // an embedded GitHub research view.
  type Canvas =
    | { kind: "overview" }
    | { kind: "video"; videoId: string; sec: number | null }
    | { kind: "repo"; url: string; label: string }
    | { kind: "report"; reportId: string };
  let canvas = $state<Canvas>({ kind: "overview" });
  let playerEl = $state<HTMLVideoElement | null>(null);

  // Chat-driven overlays: citation chips and live research render full-page
  // over the workspace (like the repo page), keeping the chat alongside.
  let researchUrl = $state<string | null>(null);
  let overlayVideo = $state<{ videoId: string; sec: number | null } | null>(null);
  let overlayPlayerEl = $state<HTMLVideoElement | null>(null);

  let chatMessages = $state<ChatMessage[]>([]);
  let chatToolStatus = $state<string | null>(null);
  let chatOpen = $state(false);

  // ── Report generation ───────────────────────────────────────────────
  let reportModalOpen = $state(false);
  let reportTitleDraft = $state("");
  let reportPromptDraft = $state(DEFAULT_REPORT_PROMPT);
  let reportBusy = $state(false);
  let reportStatus = $state<string | null>(null);
  /** Library ids selected as sources in the New-report modal. */
  let reportSourceIds = $state<Set<string>>(new Set());
  let appData = $state("");

  let pickerOpen = $state(false);
  let pickerFilter = $state("");
  let editingName = $state(false);
  let nameDraft = $state("");

  const projectId = $derived($page.params.id ?? "");

  const members = $derived(
    (project?.memberIds ?? []).map((id) => library.find((r) => r.id === id) ?? null)
  );
  const repoMembers = $derived(
    members.filter((m): m is VideoRecord => m != null && isGitHub(m) && m.repoInfo != null)
  );
  const videoMembers = $derived(
    members.filter((m): m is VideoRecord => m != null && !isGitHub(m))
  );
  /** Tool `repo` value → RepoRef info. Keyed by short repo name. */
  const repoByName = $derived(
    new Map(repoMembers.map((m) => [m.repoInfo!.repo, m.repoInfo!]))
  );
  const projectVideoNames = $derived(
    Object.fromEntries(videoMembers.map((v) => [v.id, v.videoName]))
  );

  const overlayVideoRecord = $derived(
    overlayVideo
      ? videoMembers.find((v) => v.id === overlayVideo!.videoId) ?? null
      : null
  );
  const overlayYtSrc = $derived.by(() => {
    if (!overlayVideoRecord || overlayVideoRecord.sourceType !== "youtube" || !overlayVideoRecord.sourceUrl) return "";
    const ytId = parseYouTubeId(overlayVideoRecord.sourceUrl);
    if (!ytId) return "";
    const start = overlayVideo?.sec != null ? `?start=${Math.floor(overlayVideo.sec)}&autoplay=1` : "";
    return `https://www.youtube-nocookie.com/embed/${ytId}${start}`;
  });

  const canvasReport = $derived(
    canvas.kind === "report"
      ? project?.reports.find((r) => r.id === (canvas as { reportId: string }).reportId) ?? null
      : null
  );

  const canvasVideo = $derived(
    canvas.kind === "video"
      ? videoMembers.find((v) => v.id === (canvas as { videoId: string }).videoId) ?? null
      : null
  );
  const canvasIsYt = $derived(canvasVideo?.sourceType === "youtube");
  const canvasYtSrc = $derived.by(() => {
    if (!canvasVideo || !canvasIsYt || !canvasVideo.sourceUrl) return "";
    const ytId = parseYouTubeId(canvasVideo.sourceUrl);
    if (!ytId) return "";
    const sec = canvas.kind === "video" ? canvas.sec : null;
    const start = sec != null ? `?start=${Math.floor(sec)}&autoplay=1` : "";
    return `https://www.youtube-nocookie.com/embed/${ytId}${start}`;
  });

  const pickerCandidates = $derived(
    library.filter((r) => {
      if (project?.memberIds.includes(r.id)) return false;
      const q = pickerFilter.trim().toLowerCase();
      return !q || r.videoName.toLowerCase().includes(q);
    })
  );

  onMount(async () => {
    apiKey = await loadApiKey();
    githubToken = await loadGitHubToken();
    maxToolTurns = await loadMaxToolTurns();
    appData = await appDataDir();
    await refresh();
  });

  async function refresh() {
    library = await listVideos();
    project = await getProject(projectId);
    notFound = project === null;
    chatMessages = project?.chat ?? [];
  }

  // ── Canvas control ──────────────────────────────────────────────────

  function showOverview() {
    canvas = { kind: "overview" };
  }

  function showVideo(videoId: string, sec: number | null = null) {
    canvas = { kind: "video", videoId, sec };
    if (sec != null && playerEl) {
      playerEl.currentTime = sec;
      void playerEl.play();
    }
  }

  function showResearch(url: string, label: string) {
    // Re-assign even when already showing a repo so the webview navigates.
    canvas = { kind: "repo", url, label };
  }

  function showRepo(record: VideoRecord) {
    const info = record.repoInfo;
    if (!info) return;
    showResearch(
      repoHomeUrl({ owner: info.owner, repo: info.repo }, info.defaultBranch),
      info.repo
    );
  }

  function openMember(m: VideoRecord) {
    if (isGitHub(m)) showRepo(m);
    else showVideo(m.id);
  }

  function parseTs(ts: string): number {
    const parts = ts.split(":").map(Number);
    return parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1];
  }

  /** Chat citation chips open full-page overlays next to the chat. */
  function handleProjectCite(kind: "file" | "commit" | "ts", scope: string, value: string) {
    if (kind === "ts") {
      researchUrl = null;
      const sec = parseTs(value);
      overlayVideo = { videoId: scope, sec };
      if (overlayPlayerEl) {
        overlayPlayerEl.currentTime = sec;
        void overlayPlayerEl.play();
      }
      return;
    }
    const info = repoByName.get(scope);
    if (!info) return;
    overlayVideo = null;
    // Only one native research webview exists; don't fight with an
    // inline canvas view while the overlay is up.
    if (canvas.kind === "repo") canvas = { kind: "overview" };
    const ref: RepoRef = { owner: info.owner, repo: info.repo };
    researchUrl = kind === "file"
      ? fileUrl(ref, info.defaultBranch, value)
      : commitUrl(ref, value);
  }

  // ── Project chat ────────────────────────────────────────────────────

  /** Route a `repo`-qualified tool call to the right member repository. */
  async function runProjectTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const info = repoByName.get(String(args.repo));
    if (!info) throw new Error(`Unknown repo: ${args.repo}`);
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

  function projectContext(): string {
    const repos = repoMembers
      .map((m) => {
        const i = m.repoInfo!;
        return (
          `- ${i.repo} (${i.owner}/${i.repo})` +
          (i.description ? ` — ${i.description}` : "") +
          (i.language ? ` [${i.language}]` : "") +
          `, default branch: ${i.defaultBranch}`
        );
      })
      .join("\n");
    return (
      `Project: ${project!.name}\n` +
      (project!.description ? `Description: ${project!.description}\n` : "") +
      `\nMember repositories (use these names for the repo tool parameter):\n` +
      (repos || "(none)")
    );
  }

  async function handleAsk(question: string) {
    if (!project) return;
    const userMsg: ChatMessage = { role: "user", text: question, at: new Date().toISOString() };
    chatMessages = [...chatMessages, userMsg];
    try {
      // Attach every playable member video as media (timestamp-grounded
      // answers). YouTube members ride along by URL; local/loom re-upload
      // transparently if their Gemini file expired.
      chatToolStatus = "Preparing project sources…";
      const videos: ProjectChatVideo[] = [];
      for (const v of videoMembers) {
        const file = await ensureActiveFile(apiKey, v, () => {});
        videos.push({ id: v.id, name: v.videoName, file, summary: v.summary });
      }
      const reply = await generateProjectChatReply(
        apiKey, question, chatMessages.slice(0, -1),
        projectContext(), [...repoByName.keys()], videos,
        runProjectTool,
        (label, name, args) => {
          chatToolStatus = label;
          const info = repoByName.get(String(args.repo));
          if (info) {
            const url = urlForToolCall(
              name, args,
              { owner: info.owner, repo: info.repo },
              info.defaultBranch
            );
            if (url) {
              overlayVideo = null;
              if (canvas.kind === "repo") canvas = { kind: "overview" };
              researchUrl = url;
            }
          }
        },
        maxToolTurns
      );
      const modelMsg: ChatMessage = {
        role: "model",
        text: reply.text,
        at: new Date().toISOString(),
        costUsd: reply.usage.costUsd,
      };
      if (reply.toolCalls?.length) modelMsg.toolCalls = reply.toolCalls;
      if (reply.reportProposal) modelMsg.reportProposal = reply.reportProposal;
      chatMessages = [...chatMessages, modelMsg];
      await saveProjectChat(project.id, chatMessages);
    } catch (err) {
      chatMessages = chatMessages.slice(0, -1);
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      chatToolStatus = null;
    }
  }

  async function handleClearChat() {
    if (!project) return;
    chatMessages = [];
    await saveProjectChat(project.id, []);
  }

  // ── Reports ─────────────────────────────────────────────────────────

  /** Gather the selected member videos as attached media + capture paths. */
  async function prepareReportVideos(sourceIds: string[]): Promise<{
    videos: ProjectChatVideo[];
    localPathById: Map<string, string>;
  }> {
    const videos: ProjectChatVideo[] = [];
    const localPathById = new Map<string, string>();
    for (const v of videoMembers) {
      if (!sourceIds.includes(v.id)) continue;
      const file = await ensureActiveFile(apiKey, v, () => {});
      videos.push({ id: v.id, name: v.videoName, file, summary: v.summary });
      if (v.localPath) localPathById.set(v.id, v.localPath);
    }
    return { videos, localPathById };
  }

  /**
   * One shared generation path for the modal and chat approvals.
   * `sourceIds` scopes which project members the report may use.
   */
  async function runReportGeneration(title: string, prompt: string, sourceIds: string[]) {
    if (!project) throw new Error("Project not loaded.");
    reportBusy = true;
    reportStatus = "Preparing project sources…";
    try {
      const { videos, localPathById } = await prepareReportVideos(sourceIds);
      const repoNames = repoMembers
        .filter((m) => sourceIds.includes(m.id))
        .map((m) => m.repoInfo!.repo);
      const report = await generateAndSaveReport({
        apiKey,
        projectId: project.id,
        prompt,
        title,
        projectContext: projectContext(),
        repoNames,
        videos,
        localPathById,
        sourceIds,
        execute: runProjectTool,
        onToolCall: (label) => (reportStatus = label),
        onStatus: (label) => (reportStatus = label),
      });
      await refresh();
      return report;
    } finally {
      reportBusy = false;
      reportStatus = null;
    }
  }

  function openReportModal() {
    reportTitleDraft = "";
    reportPromptDraft = DEFAULT_REPORT_PROMPT;
    reportSourceIds = new Set(members.filter((m) => m != null).map((m) => m!.id));
    reportModalOpen = true;
  }

  function toggleReportSource(id: string) {
    const next = new Set(reportSourceIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    reportSourceIds = next;
  }

  async function handleModalGenerate() {
    reportModalOpen = false;
    try {
      const report = await runReportGeneration(
        reportTitleDraft, reportPromptDraft, [...reportSourceIds]
      );
      canvas = { kind: "report", reportId: report.id };
      toast.success("Report generated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  /** Chat proposal approved: generate, then persist the outcome on the message. */
  async function handleApproveReport(msgIndex: number, title: string, prompt: string) {
    if (!project) return;
    try {
      const report = await runReportGeneration(title, prompt, project.memberIds);
      updateProposal(msgIndex, { status: "generated", reportId: report.id });
      canvas = { kind: "report", reportId: report.id };
      toast.success("Report generated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function handleDismissReport(msgIndex: number) {
    updateProposal(msgIndex, { status: "dismissed" });
  }

  function updateProposal(msgIndex: number, patch: Partial<NonNullable<ChatMessage["reportProposal"]>>) {
    const msg = chatMessages[msgIndex];
    if (!msg?.reportProposal || !project) return;
    msg.reportProposal = { ...msg.reportProposal, ...patch };
    chatMessages = [...chatMessages];
    void saveProjectChat(project.id, chatMessages);
  }

  async function handleDeleteReport(report: Report) {
    if (!project) return;
    await removeReport(project.id, report.id);
    await removeReportDir(report.id);
    if (canvas.kind === "report" && canvas.reportId === report.id) showOverview();
    await refresh();
  }

  async function handleExportReport(report: Report) {
    try {
      const path = await exportReportHtml(report, projectVideoNames);
      if (path) toast.success("Report exported.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRegenerateReport(report: Report) {
    try {
      const next = await runReportGeneration(report.title, report.prompt, report.sourceIds);
      canvas = { kind: "report", reportId: next.id };
      toast.success("Report regenerated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  /** Report markdown → HTML with citation chips + resolved image paths. */
  function renderReport(r: Report): string {
    let md = appData ? resolveReportImages(r.markdown, appData) : r.markdown;
    md = md.replace(
      /\[TS:\s*([\w-]+)\s*:\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\]/g,
      (_m, vid, ts) => {
        const name = projectVideoNames[vid];
        const label = name ? `${name} @ ${ts}` : ts;
        return `<button class="ts-chip" data-p-kind="ts" data-p-scope="${vid}" data-p-value="${ts}">${label}</button>`;
      }
    );
    md = md.replace(
      /\[FILE:\s*([^:\]\s]+)\s*:\s*(\S+)\s*\]/g,
      (_m, repo, path) =>
        `<button class="cite-chip" data-p-kind="file" data-p-scope="${repo}" data-p-value="${path}">${repo}: ${path}</button>`
    );
    md = md.replace(
      /\[COMMIT:\s*([^:\]\s]+)\s*:\s*([0-9a-f]{6,40})\s*\]/gi,
      (_m, repo, sha) =>
        `<button class="cite-chip" data-p-kind="commit" data-p-scope="${repo}" data-p-value="${sha}">${repo}: ${String(sha).slice(0, 7)}</button>`
    );
    return marked.parse(md) as string;
  }

  /** Clicks inside the rendered report body route to the same overlays. */
  function handleReportClick(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest("[data-p-kind]");
    if (!el) return;
    const kind = el.getAttribute("data-p-kind") as "file" | "commit" | "ts";
    const scope = el.getAttribute("data-p-scope") ?? "";
    const value = el.getAttribute("data-p-value") ?? "";
    if (scope && value) handleProjectCite(kind, scope, value);
  }

  function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric",
    });
  }

  // ── Members / rename ────────────────────────────────────────────────

  async function handleAddMember(libraryId: string) {
    if (!project) return;
    await addMember(project.id, libraryId);
    await refresh();
  }

  async function handleRemoveMember(libraryId: string) {
    if (!project) return;
    await removeMember(project.id, libraryId);
    if (canvas.kind === "video" && canvas.videoId === libraryId) showOverview();
    await refresh();
  }

  function startRename() {
    if (!project) return;
    nameDraft = project.name;
    editingName = true;
  }

  async function saveRename() {
    if (!project || !nameDraft.trim()) {
      editingName = false;
      return;
    }
    await updateProject(project.id, { name: nameDraft });
    editingName = false;
    await refresh();
  }

  const sourceIcons: Record<SourceType, typeof Video> = {
    github: GitBranch,
    youtube: MonitorPlay,
    loom: Film,
    local: Video,
  };
  function iconFor(r: VideoRecord) {
    return sourceIcons[r.sourceType ?? "local"];
  }
</script>

{#if notFound}
  <div class="empty-state">
    <p>Project not found.</p>
    <button class="btn" onclick={() => goto("/projects")}>
      <ArrowLeft size={14} /> Back to projects
    </button>
  </div>
{:else if project}
  <header class="page-head">
    <a class="back" href="/projects" title="Back to projects"><ArrowLeft size={17} /></a>
    <span class="proj-icon"><FolderKanban size={18} /></span>
    {#if editingName}
      <input
        class="name-input"
        bind:value={nameDraft}
        onkeydown={(e) => {
          if (e.key === "Enter") saveRename();
          if (e.key === "Escape") editingName = false;
        }}
      />
      <button class="icon-btn" onclick={saveRename} title="Save name"><Check size={15} /></button>
    {:else}
      <h1>{project.name}</h1>
      <button class="icon-btn" onclick={startRename} title="Rename project"><Pencil size={14} /></button>
    {/if}
  </header>

  <section class="members">
    <div class="members-row">
      {#each members as m, i (project.memberIds[i])}
        {#if m}
          {@const Icon = iconFor(m)}
          <span
            class="chip"
            class:active={canvas.kind === "video" && canvas.videoId === m.id}
          >
            <Icon size={13} />
            <button class="chip-name" onclick={() => openMember(m)} title="Open in workspace">
              {m.videoName}
            </button>
            <button
              class="chip-x"
              onclick={() => handleRemoveMember(m.id)}
              title="Remove from project"
              aria-label="Remove from project"
            >
              <X size={12} />
            </button>
          </span>
        {:else}
          <span class="chip removed" title="This source was deleted from the library">
            removed source
            <button
              class="chip-x"
              onclick={() => handleRemoveMember(project!.memberIds[i])}
              aria-label="Remove"
            >
              <X size={12} />
            </button>
          </span>
        {/if}
      {/each}
      <button class="chip add" onclick={() => (pickerOpen = !pickerOpen)}>
        <Plus size={13} /> Add from library
      </button>
    </div>

    {#if pickerOpen}
      <div class="picker">
        <input placeholder="Filter sources…" bind:value={pickerFilter} />
        {#if pickerCandidates.length === 0}
          <p class="picker-empty">
            {library.length === 0
              ? "Your library is empty — add sources first."
              : "No matching sources (or everything is already in the project)."}
          </p>
        {:else}
          <ul>
            {#each pickerCandidates as r (r.id)}
              {@const Icon = iconFor(r)}
              <li>
                <button class="pick" onclick={() => handleAddMember(r.id)}>
                  <Icon size={14} />
                  <span class="pick-name">{r.videoName}</span>
                  <Plus size={14} />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </section>

  <!-- ── Workspace canvas ─────────────────────────────────────────── -->
  {#if canvas.kind === "repo"}
    <section class="canvas">
      <div class="canvas-head">
        <button class="btn small" onclick={showOverview}>
          <ArrowLeft size={13} /> Overview
        </button>
        <span class="canvas-title">{canvas.label}</span>
      </div>
      <CanvasResearchView url={canvas.url} />
    </section>
  {:else if canvas.kind === "report" && canvasReport}
    <section class="canvas">
      <div class="canvas-head">
        <button class="btn small" onclick={showOverview}>
          <ArrowLeft size={13} /> Overview
        </button>
        <span class="canvas-title">{canvasReport.title}</span>
        <span class="canvas-meta mono">
          {fmtDate(canvasReport.createdAt)} · ~${canvasReport.costUsd.toFixed(2)}
        </span>
        <button
          class="icon-btn"
          onclick={() => handleExportReport(canvasReport)}
          title="Export as HTML"
          aria-label="Export report"
        >
          <Download size={14} />
        </button>
        <button
          class="icon-btn"
          onclick={() => handleRegenerateReport(canvasReport)}
          disabled={reportBusy}
          title="Regenerate with the same prompt"
          aria-label="Regenerate report"
        >
          <RefreshCw size={14} />
        </button>
        <button
          class="icon-btn danger"
          onclick={() => handleDeleteReport(canvasReport)}
          title="Delete report"
          aria-label="Delete report"
        >
          <Trash2 size={14} />
        </button>
      </div>
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
      <article class="report-body markdown" onclick={handleReportClick}>
        {@html renderReport(canvasReport)}
      </article>
    </section>
  {:else if canvas.kind === "video" && canvasVideo}
    <section class="canvas">
      <div class="canvas-head">
        <button class="btn small" onclick={showOverview}>
          <ArrowLeft size={13} /> Overview
        </button>
        <span class="canvas-title">{canvasVideo.videoName}</span>
      </div>
      {#if canvasIsYt}
        {#if canvasYtSrc}
          <iframe
            class="player yt"
            src={canvasYtSrc}
            title={canvasVideo.videoName}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowfullscreen
          ></iframe>
        {/if}
      {:else if canvasVideo.localPath}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          class="player"
          bind:this={playerEl}
          src={convertFileSrc(canvasVideo.localPath)}
          controls
          autoplay={canvas.sec != null}
          onloadedmetadata={() => {
            if (canvas.kind === "video" && canvas.sec != null && playerEl) {
              playerEl.currentTime = canvas.sec;
            }
          }}
        ></video>
      {/if}
    </section>
  {:else}
    <section class="overview">
      <div class="reports-head">
        <h2><FileText size={16} /> Reports</h2>
        <button class="btn primary" onclick={openReportModal} disabled={reportBusy || !apiKey}>
          <Plus size={15} /> New report
        </button>
      </div>
      {#if reportBusy}
        <div class="report-progress">
          <span class="spinner"></span>
          <span class="mono">{reportStatus ?? "Generating report…"}</span>
        </div>
      {/if}
      {#if project.reports.length === 0 && !reportBusy}
        <div class="placeholder">
          <FileText size={30} />
          <p>No reports yet.</p>
          <p class="hint">
            Generate a timestamped, screenshot-illustrated writeup that
            cross-references this project's videos against its repos — hit
            “New report”, or ask the chat to propose one.
          </p>
        </div>
      {:else if project.reports.length > 0}
        <ul class="report-list">
          {#each project.reports as r (r.id)}
            <li>
              <button class="report-card" onclick={() => (canvas = { kind: "report", reportId: r.id })}>
                <FileText size={16} />
                <div class="report-info">
                  <span class="report-title">{r.title}</span>
                  <span class="report-meta mono">
                    {fmtDate(r.createdAt)} · ~${r.costUsd.toFixed(2)}
                  </span>
                </div>
              </button>
              <button
                class="icon-btn danger"
                onclick={() => handleDeleteReport(r)}
                title="Delete report"
                aria-label="Delete report"
              >
                <Trash2 size={14} />
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if reportModalOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
    <div class="modal-scrim" onclick={() => (reportModalOpen = false)}></div>
    <div class="modal" role="dialog" aria-label="New report">
      <h3><FileText size={16} /> New report</h3>
      <label class="field">
        <span>Title <em>(optional — the report titles itself if blank)</em></span>
        <input placeholder="e.g. Loom walkthrough vs. current code" bind:value={reportTitleDraft} />
      </label>
      <label class="field">
        <span>Instructions</span>
        <textarea rows="7" bind:value={reportPromptDraft}></textarea>
      </label>
      <div class="sources-field">
        <span class="sources-label">Sources</span>
        <div class="source-checks">
          {#each members.filter((m) => m != null) as m (m.id)}
            {@const Icon = iconFor(m)}
            <label class="source-check">
              <input
                type="checkbox"
                checked={reportSourceIds.has(m.id)}
                onchange={() => toggleReportSource(m.id)}
              />
              <Icon size={14} />
              <span class="source-name">{m.videoName}</span>
            </label>
          {/each}
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn" onclick={() => (reportModalOpen = false)}>Cancel</button>
        <button
          class="btn primary"
          onclick={handleModalGenerate}
          disabled={!reportPromptDraft.trim() || reportSourceIds.size === 0}
        >
          <Check size={14} /> Generate
        </button>
      </div>
    </div>
  {/if}

  {#if researchUrl}
    <ResearchPanel
      url={researchUrl}
      onClose={() => (researchUrl = null)}
      rightOffset={chatOpen ? "min(420px, 92vw)" : "0px"}
    />
  {/if}

  {#if overlayVideoRecord}
    <aside
      class="video-overlay"
      style:right={chatOpen ? "min(420px, 92vw)" : "0px"}
    >
      <header class="overlay-head">
        <span class="overlay-title">{overlayVideoRecord.videoName}</span>
        <button
          class="icon-btn"
          onclick={() => (overlayVideo = null)}
          title="Close video"
          aria-label="Close video"
        >
          <X size={15} />
        </button>
      </header>
      <div class="overlay-body">
        {#if overlayVideoRecord.sourceType === "youtube"}
          {#if overlayYtSrc}
            <iframe
              class="overlay-player yt"
              src={overlayYtSrc}
              title={overlayVideoRecord.videoName}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowfullscreen
            ></iframe>
          {/if}
        {:else if overlayVideoRecord.localPath}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            class="overlay-player"
            bind:this={overlayPlayerEl}
            src={convertFileSrc(overlayVideoRecord.localPath)}
            controls
            autoplay={overlayVideo?.sec != null}
            onloadedmetadata={() => {
              if (overlayVideo?.sec != null && overlayPlayerEl) {
                overlayPlayerEl.currentTime = overlayVideo.sec;
              }
            }}
          ></video>
        {/if}
      </div>
    </aside>
  {/if}

  <ChatPanel
    title={project.name}
    messages={chatMessages}
    onAsk={handleAsk}
    onClear={handleClearChat}
    disabled={!apiKey}
    toolStatus={chatToolStatus}
    showScrim={canvas.kind !== "repo" && !researchUrl && !overlayVideoRecord}
    onProjectCite={handleProjectCite}
    onApproveReport={handleApproveReport}
    onDismissReport={handleDismissReport}
    onOpenReport={(id) => (canvas = { kind: "report", reportId: id })}
    {projectVideoNames}
    bind:open={chatOpen}
    emptyHint={members.length === 0
      ? "Add sources to this project first, then ask across all of them."
      : "Ask across this project — I can watch its videos and read its repos."}
  />
{/if}

<style>
  .page-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 1rem;
  }
  .back {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    transition: background 0.15s, color 0.15s;
  }
  .back:hover { background: var(--hover); color: var(--text); }
  .proj-icon {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    flex-shrink: 0;
  }
  h1 { font-size: 1.35rem; margin: 0; letter-spacing: -0.01em; }
  .name-input {
    font-size: 1.2rem;
    font-family: inherit;
    padding: 0.35rem 0.55rem;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    min-width: 260px;
  }
  .name-input:focus { outline: none; }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .icon-btn:hover { background: var(--hover); color: var(--text); }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    gap: 0.4rem;
    padding: 0.55rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    font-size: 0.9rem;
    font-family: inherit;
  }
  .btn:hover { background: var(--hover); }
  .btn.small { padding: 0.35rem 0.65rem; font-size: 0.8rem; }

  .members { margin-bottom: 1.1rem; }
  .members-row { display: flex; flex-wrap: wrap; gap: 0.45rem; align-items: center; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.32rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    font-size: 0.82rem;
    color: var(--text);
  }
  .chip.active { border-color: var(--accent); }
  .chip :global(svg) { color: var(--accent); flex-shrink: 0; }
  .chip-name {
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 0;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip-name:hover { text-decoration: underline; }
  .chip.removed { color: var(--text-dim); font-style: italic; }
  .chip-x {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    padding: 0;
  }
  .chip-x:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
  .chip.add {
    border-style: dashed;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    font-family: inherit;
    transition: color 0.15s, border-color 0.15s;
  }
  .chip.add:hover { color: var(--accent); border-color: var(--accent); }
  .chip.add :global(svg) { color: inherit; }

  .picker {
    margin-top: 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
    padding: 0.7rem;
    max-width: 480px;
  }
  .picker input {
    width: 100%;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    font-size: 0.88rem;
    font-family: inherit;
    margin-bottom: 0.5rem;
  }
  .picker input:focus { outline: none; border-color: var(--accent); }
  .picker ul { list-style: none; margin: 0; padding: 0; max-height: 260px; overflow-y: auto; }
  .picker-empty { margin: 0.3rem 0.2rem; font-size: 0.85rem; color: var(--text-dim); }
  .pick {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.45rem 0.55rem;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font-size: 0.88rem;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
  }
  .pick:hover { background: var(--hover); }
  .pick :global(svg:first-child) { color: var(--accent); flex-shrink: 0; }
  .pick :global(svg:last-child) { color: var(--text-dim); margin-left: auto; flex-shrink: 0; }
  .pick-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .canvas {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .canvas-head {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    padding: 0.6rem 0.8rem;
    border-bottom: 1px solid var(--border);
  }
  .canvas-title {
    font-size: 0.88rem;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .player {
    display: block;
    width: 100%;
    max-height: 68vh;
    background: #000;
  }
  .player.yt { aspect-ratio: 16 / 9; border: none; }

  .video-overlay {
    position: fixed;
    top: var(--titlebar-h, 0px);
    left: var(--sidebar-w, 0px);
    right: 0;
    bottom: 0;
    border-left: 1px solid var(--border);
    z-index: 500;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    transition: right 0.2s ease, left 0.2s ease;
  }
  .overlay-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: var(--panel-head-h, 52px);
    padding: 0 1rem;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
  }
  .overlay-title {
    flex: 1;
    min-width: 0;
    font-size: 0.9rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .overlay-body {
    flex: 1;
    display: grid;
    place-items: center;
    background: var(--bg);
    padding: 1rem;
    min-height: 0;
  }
  .overlay-player {
    max-width: 100%;
    max-height: 100%;
    background: #000;
    border-radius: var(--radius-sm);
  }
  .overlay-player.yt {
    width: min(100%, 1100px);
    aspect-ratio: 16 / 9;
    border: none;
  }

  .canvas-meta { font-size: 0.72rem; color: var(--text-dim); margin-left: auto; }
  .mono { font-family: "JetBrains Mono", monospace; }
  .icon-btn.danger:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }

  .report-body {
    padding: 1.4rem 1.8rem 2rem;
    overflow-y: auto;
    max-height: 72vh;
    font-size: 0.92rem;
    line-height: 1.65;
  }
  .report-body :global(h1) { font-size: 1.4rem; margin: 0.2rem 0 0.8rem; }
  .report-body :global(h2) { font-size: 1.12rem; margin: 1.2rem 0 0.5rem; }
  .report-body :global(h3) { font-size: 0.98rem; margin: 1rem 0 0.4rem; }
  .report-body :global(img) {
    max-width: 100%;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    margin: 0.5rem 0 0.2rem;
  }
  .report-body :global(code) {
    background: color-mix(in srgb, var(--text) 8%, transparent);
    padding: 0.08rem 0.3rem;
    border-radius: 4px;
    font-size: 0.84em;
    font-family: "JetBrains Mono", monospace;
  }
  .report-body :global(.ts-chip) {
    display: inline-block;
    border: none;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent);
    font-family: "JetBrains Mono", monospace;
    font-size: 0.78em;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    cursor: pointer;
    vertical-align: baseline;
  }
  .report-body :global(.ts-chip:hover) {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .report-body :global(.cite-chip) {
    display: inline-block;
    border: none;
    background: color-mix(in srgb, #a371f7 16%, transparent);
    color: #a371f7;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.76em;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    cursor: pointer;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
  }
  .report-body :global(.cite-chip:hover) {
    background: color-mix(in srgb, #a371f7 28%, transparent);
  }

  .report-progress {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.8rem 1rem;
    margin-bottom: 0.8rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    font-size: 0.8rem;
    color: var(--text-dim);
  }
  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .report-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .report-list li { display: flex; align-items: center; gap: 0.4rem; }
  .report-card {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.7rem;
    padding: 0.7rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font-family: inherit;
    cursor: pointer;
    text-align: left;
    transition: border-color 0.15s, background 0.15s;
    min-width: 0;
  }
  .report-card:hover { border-color: var(--accent); background: var(--hover); }
  .report-card :global(svg) { color: var(--accent); flex-shrink: 0; }
  .report-info { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
  .report-title {
    font-size: 0.9rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .report-meta { font-size: 0.7rem; color: var(--text-dim); }

  .modal-scrim {
    position: fixed;
    inset: 0;
    z-index: 700;
    background: rgba(0, 0, 0, 0.35);
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 710;
    width: min(560px, 92vw);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-lg);
    padding: 1.2rem 1.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }
  .modal h3 {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    margin: 0;
    font-size: 1.02rem;
  }
  .modal h3 :global(svg) { color: var(--accent); }
  .field { display: flex; flex-direction: column; gap: 0.35rem; }
  .field span { font-size: 0.8rem; color: var(--text-dim); }
  .field em { font-style: normal; opacity: 0.75; }
  .field input, .field textarea {
    width: 100%;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    font-size: 0.88rem;
    font-family: inherit;
    line-height: 1.5;
    resize: vertical;
  }
  .field input:focus, .field textarea:focus { outline: none; border-color: var(--accent); }
  /* Sources live outside .field so its `span` label styling can't
     swallow the row text. */
  .sources-field { display: flex; flex-direction: column; gap: 0.35rem; }
  .sources-label { font-size: 0.8rem; color: var(--text-dim); }
  .source-checks {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-height: 180px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.6rem;
    background: var(--bg);
  }
  .source-check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }
  .source-check input { accent-color: var(--accent); margin: 0; }
  .source-check :global(svg) { color: var(--accent); flex-shrink: 0; }
  .source-name {
    font-size: 0.88rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }

  .overview { margin-top: 0.4rem; }
  .reports-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.7rem;
    margin-bottom: 0.6rem;
  }
  .reports-head h2 {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 1.05rem;
    margin: 0;
  }
  .reports-head h2 :global(svg) { color: var(--accent); }

  .placeholder, .empty-state {
    display: grid;
    place-items: center;
    gap: 0.4rem;
    padding: 3rem 1rem;
    color: var(--text-dim);
    text-align: center;
  }
  .placeholder p, .empty-state p { margin: 0; }
  .placeholder .hint { font-size: 0.85rem; max-width: 440px; }
</style>
