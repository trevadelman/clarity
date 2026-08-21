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
    Clapperboard, Image as ImageIcon, Sparkles, ChevronDown,
  } from "lucide-svelte";
  import {
    getProject, updateProject, addMember, removeMember, saveProjectChat,
    removeReport, removeEdit, type Project, type Report, type Edit,
  } from "$lib/projects";
  import {
    generateAndSaveEdit, removeEditDir, exportEdit, editOutputAbsPath,
  } from "$lib/autoEdit";
  import { isMac } from "$lib/platform";
  import { autoEditEnabled } from "$lib/settings";
  import AutoEditModal, { type AutoEditSubmit } from "$lib/AutoEditModal.svelte";
  import {
    generateAndSaveReport, removeReportDir, resolveReportImages, exportReportHtml,
  } from "$lib/reports";
  import {
    listVideos, ensureActiveFile, isGitHub, isImage, parseYouTubeId,
    addGeneratedImage, addGeneratedVideo, setThumbnail,
    renameVideo, deleteVideo,
    type VideoRecord, type SourceType,
  } from "$lib/videoLibrary";
  import { confirm } from "@tauri-apps/plugin-dialog";
  import { formatDuration } from "$lib/thumbnail";
  import { probeVideo } from "$lib/thumbnail";
  import { readFile } from "@tauri-apps/plugin-fs";
  import {
    generateProjectChatReply, DEFAULT_REPORT_PROMPT,
    generateImage, IMAGE_COST_PER_IMAGE,
    generateVideoFromImage, videoModelInfo, DEFAULT_VIDEO_MODEL,
    type ChatMessage, type ProjectChatVideo,
  } from "$lib/gemini";
  import {
    fetchCommitsSince, fetchCommitDetail, fetchFileContent,
    fetchDirectory, searchCode, type RepoRef,
  } from "$lib/github";
  import {
    loadApiKey, loadGitHubToken, loadMaxToolTurns, loadVideoModel,
    DEFAULT_MAX_TOOL_TURNS,
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
    | { kind: "image"; videoId: string }
    | { kind: "repo"; url: string; label: string }
    | { kind: "report"; reportId: string }
    | { kind: "edit"; editId: string };
  let canvas = $state<Canvas>({ kind: "overview" });
  let playerEl = $state<HTMLVideoElement | null>(null);
  // Abandon any in-progress source rename when the canvas switches.
  $effect(() => {
    void canvas;
    editingSource = false;
  });

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

  // ── Auto-Edit ───────────────────────────────────────────────────────
  let editModalOpen = $state(false);
  let editBusy = $state(false);
  let editStatus = $state<string | null>(null);
  /** Render progress in [0, 1], or null while planning. */
  let editProgress = $state<number | null>(null);
  /** Resolved absolute path of the canvas edit's MP4. */
  let canvasEditSrc = $state("");

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
    members.filter((m): m is VideoRecord => m != null && !isGitHub(m) && !isImage(m))
  );

  // ── Member tree groups (folders by asset type) ─────────────────────
  const generatedMembers = $derived(
    members.filter(
      (m): m is VideoRecord =>
        m != null && (isImage(m) || (m.tags?.includes("generated") ?? false))
    )
  );
  const uploadMembers = $derived(
    videoMembers.filter((m) => !(m.tags?.includes("generated") ?? false))
  );
  const removedMemberIds = $derived(
    (project?.memberIds ?? []).filter((id, i) => members[i] == null)
  );
  const memberGroups = $derived(
    [
      { label: "Repos", items: repoMembers },
      { label: "Videos", items: uploadMembers },
      { label: "Generated", items: generatedMembers },
    ].filter((g) => g.items.length > 0)
  );
  let collapsedGroups = $state<Set<string>>(new Set());
  function toggleGroup(label: string) {
    const next = new Set(collapsedGroups);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    collapsedGroups = next;
  }
  function isActiveMember(m: VideoRecord): boolean {
    return (
      ((canvas.kind === "video" || canvas.kind === "image") && canvas.videoId === m.id) ||
      (canvas.kind === "repo" && m.repoInfo?.repo === canvas.label)
    );
  }
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

  const canvasEdit = $derived(
    canvas.kind === "edit"
      ? project?.edits.find((e) => e.id === (canvas as { editId: string }).editId) ?? null
      : null
  );
  $effect(() => {
    if (canvasEdit) {
      void editOutputAbsPath(canvasEdit).then((p) => (canvasEditSrc = convertFileSrc(p)));
    } else {
      canvasEditSrc = "";
    }
  });

  const canvasVideo = $derived(
    canvas.kind === "video"
      ? videoMembers.find((v) => v.id === (canvas as { videoId: string }).videoId) ?? null
      : null
  );
  const canvasImage = $derived(
    canvas.kind === "image"
      ? generatedMembers.find((v) => v.id === (canvas as { videoId: string }).videoId) ?? null
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
    videoModel = await loadVideoModel();
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
    else if (isImage(m)) canvas = { kind: "image", videoId: m.id };
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

  // ── Auto-Edit ───────────────────────────────────────────────────────

  async function runEditGeneration(opts: AutoEditSubmit) {
    if (!project) return;
    editModalOpen = false;
    editBusy = true;
    editStatus = "Preparing sources…";
    editProgress = null;
    try {
      // Attach the selected local videos as Gemini media with their real
      // durations (the plan's timestamps are validated against these).
      const videos = [];
      for (const v of videoMembers) {
        if (!opts.sourceIds.includes(v.id) || !v.localPath) continue;
        const file = await ensureActiveFile(apiKey, v, () => {});
        videos.push({
          id: v.id,
          name: v.videoName,
          durationSec: v.durationSec ?? 0,
          file,
          localPath: v.localPath,
        });
      }
      const edit = await generateAndSaveEdit({
        apiKey,
        projectId: project.id,
        prompt: opts.prompt,
        videos,
        audioPath: opts.audioPath,
        audioMode: opts.audioMode,
        width: opts.width,
        height: opts.height,
        onStatus: (label) => (editStatus = label),
        onProgress: (p) => (editProgress = p),
      });
      await refresh();
      canvas = { kind: "edit", editId: edit.id };
      toast.success("Edit rendered.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      editBusy = false;
      editStatus = null;
      editProgress = null;
    }
  }

  async function handleDeleteEdit(edit: Edit) {
    if (!project) return;
    await removeEdit(project.id, edit.id);
    await removeEditDir(edit.id);
    if (canvas.kind === "edit" && canvas.editId === edit.id) showOverview();
    await refresh();
  }

  async function handleExportEdit(edit: Edit) {
    try {
      const path = await exportEdit(edit);
      if (path) toast.success("Edit exported.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function fmtSec(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function editSourceName(videoId: string): string {
    return library.find((r) => r.id === videoId)?.videoName ?? "removed source";
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
    if ((canvas.kind === "video" || canvas.kind === "image") && canvas.videoId === libraryId) showOverview();
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
    image: ImageIcon,
    github: GitBranch,
    youtube: MonitorPlay,
    loom: Film,
    local: Video,
  };
  function iconFor(r: VideoRecord) {
    // AI-generated clips get a distinct icon from uploaded footage.
    if (r.sourceType === "local" && r.tags?.includes("generated")) return Sparkles;
    return sourceIcons[r.sourceType ?? "local"];
  }

  // ── Adaptive overview (Phase 3) ─────────────────────────────────────
  // The Reports section only matters for research-style projects: show it
  // when there's anything to show (repos to research, existing reports, or
  // a run in flight). Studio (edits + generation) groups under one
  // collapsible header, expanded by default and ordered first when the
  // project's focus is "studio".
  const showReports = $derived(
    (project?.reports.length ?? 0) > 0 || repoMembers.length > 0 || reportBusy
  );
  const studioFirst = $derived(project?.focus === "studio");
  let studioOpen = $state(true);

  // ── In-studio generation (image → member; image → clip → member) ───
  let genModalOpen = $state(false);
  let genPrompt = $state("");
  let genAspect = $state<"1:1" | "9:16" | "16:9">("16:9");
  let genBusy = $state(false);
  let animatePrompt = $state("");
  let animating = $state(false);
  let animateStatus = $state("");
  let videoModel = $state(DEFAULT_VIDEO_MODEL);
  const videoTier = $derived(videoModelInfo(videoModel));

  async function handleGenerateImage() {
    const prompt = genPrompt.trim();
    if (!prompt || genBusy || !project) return;
    genModalOpen = false;
    genBusy = true;
    try {
      const result = await generateImage(apiKey, prompt, genAspect);
      const name = prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
      const record = await addGeneratedImage(name, result.image, prompt, result.costUsd);
      await addMember(project.id, record.id);
      await refresh();
      canvas = { kind: "image", videoId: record.id };
      toast.success("Image generated and added to the project.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      genBusy = false;
    }
  }

  /** Read the stored image and base64-encode it (chunked to avoid stack limits). */
  async function imageAsBase64(path: string): Promise<string> {
    const bytes = await readFile(path);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  // ── Source editing (library-style: rename / delete / open) ─────────
  let editingSource = $state(false);
  let sourceNameDraft = $state("");

  function startSourceRename(m: VideoRecord) {
    sourceNameDraft = m.videoName;
    editingSource = true;
  }

  async function saveSourceRename(m: VideoRecord) {
    editingSource = false;
    const name = sourceNameDraft.trim();
    if (!name || name === m.videoName) return;
    await renameVideo(m, name);
    await refresh();
  }

  /** Delete the source from the entire library (and this project). */
  async function handleDeleteSource(m: VideoRecord) {
    const ok = await confirm(
      `Delete "${m.videoName}" from your library? This removes the local copy and any Gemini upload, everywhere. This cannot be undone.`,
      { title: "Delete source", kind: "warning" }
    );
    if (!ok) return;
    try {
      await deleteVideo(apiKey, m);
      await removeMember(project!.id, m.id);
      showOverview();
      await refresh();
      toast.success("Source deleted.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function sourceMeta(m: VideoRecord): string {
    const parts: string[] = [];
    if (m.sizeBytes > 0) parts.push(`${(m.sizeBytes / (1024 * 1024)).toFixed(1)} MB`);
    const dur = formatDuration(m.durationSec);
    if (dur) parts.push(dur);
    if (m.mimeType) parts.push(m.mimeType);
    return parts.join(" · ");
  }

  async function handleAnimate(image: VideoRecord) {
    if (animating || !animatePrompt.trim() || !project) return;
    if (!apiKey) {
      toast.error("Set your Gemini API key in Settings first.");
      return;
    }
    animating = true;
    try {
      const base64 = await imageAsBase64(image.localPath);
      const result = await generateVideoFromImage(
        apiKey, base64, image.mimeType, animatePrompt.trim(),
        (label) => (animateStatus = label),
        videoModel
      );
      const clip = await addGeneratedVideo(
        `${image.videoName} (animated)`, result.bytes, animatePrompt.trim(), result.costUsd
      );
      const probe = await probeVideo(clip.localPath);
      await setThumbnail(clip, probe.thumbnail, probe.durationSec);
      await addMember(project.id, clip.id);
      await refresh();
      animatePrompt = "";
      canvas = { kind: "video", videoId: clip.id, sec: null };
      toast.success("Video generated and added to the project.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      animating = false;
      animateStatus = "";
    }
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

  <div class="workspace">
  <!-- ── Member tree (sources grouped by asset type) ──────────────── -->
  <aside class="member-tree">
    <div class="tree-head">Sources</div>
    {#if memberGroups.length === 0 && removedMemberIds.length === 0}
      <p class="tree-empty">No sources yet.</p>
    {/if}
    {#each memberGroups as group (group.label)}
      <button
        class="tree-folder"
        onclick={() => toggleGroup(group.label)}
        aria-expanded={!collapsedGroups.has(group.label)}
      >
        <span class="chev" class:open={!collapsedGroups.has(group.label)}>
          <ChevronDown size={13} />
        </span>
        {group.label}
        <span class="tree-count">{group.items.length}</span>
      </button>
      {#if !collapsedGroups.has(group.label)}
        <ul class="tree-items">
          {#each group.items as m (m.id)}
            {@const Icon = iconFor(m)}
            <li class="tree-item" class:active={isActiveMember(m)}>
              <button class="tree-name" onclick={() => openMember(m)} title="Open in workspace">
                <Icon size={13} />
                <span>{m.videoName}</span>
              </button>
              <button
                class="tree-x"
                onclick={() => handleRemoveMember(m.id)}
                title="Remove from project"
                aria-label="Remove from project"
              >
                <X size={12} />
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/each}
    {#each removedMemberIds as rid (rid)}
      <div class="tree-item removed" title="This source was deleted from the library">
        <span class="tree-removed">removed source</span>
        <button class="tree-x" onclick={() => handleRemoveMember(rid)} aria-label="Remove">
          <X size={12} />
        </button>
      </div>
    {/each}

    <button class="tree-add" onclick={() => (pickerOpen = !pickerOpen)}>
      <Plus size={13} /> Add from library
    </button>

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
  </aside>

  <div class="workspace-main">
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
  {:else if canvas.kind === "edit" && canvasEdit}
    <section class="canvas">
      <div class="canvas-head">
        <button class="btn small" onclick={showOverview}>
          <ArrowLeft size={13} /> Overview
        </button>
        <span class="canvas-title">{canvasEdit.title}</span>
        <span class="canvas-meta mono">
          {fmtDate(canvasEdit.createdAt)} · {fmtSec(canvasEdit.durationSec)} · ~${canvasEdit.costUsd.toFixed(2)}
        </span>
        <button
          class="icon-btn"
          onclick={() => handleExportEdit(canvasEdit)}
          title="Export MP4"
          aria-label="Export edit"
        >
          <Download size={14} />
        </button>
        <button
          class="icon-btn danger"
          onclick={() => handleDeleteEdit(canvasEdit)}
          title="Delete edit"
          aria-label="Delete edit"
        >
          <Trash2 size={14} />
        </button>
      </div>
      {#if canvasEditSrc}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video class="player" src={canvasEditSrc} controls></video>
      {/if}
      <div class="edit-plan">
        <h4>Edit plan</h4>
        <ol>
          {#each canvasEdit.plan.clips as clip, i (i)}
            <li>
              <button
                class="clip-row"
                onclick={() => showVideo(clip.videoId, clip.startSec)}
                title="Open the source video at this moment"
              >
                <span class="clip-range mono">
                  {fmtSec(clip.startSec)}–{fmtSec(clip.endSec)}
                </span>
                <span class="clip-source">{editSourceName(clip.videoId)}</span>
                <span class="clip-reason">{clip.reason}</span>
              </button>
            </li>
          {/each}
        </ol>
      </div>
    </section>
  {:else if canvas.kind === "image" && canvasImage}
    <section class="canvas">
      <div class="canvas-head">
        <button class="btn small" onclick={showOverview}>
          <ArrowLeft size={13} /> Overview
        </button>
        {#if editingSource}
          <input
            class="source-name-input"
            bind:value={sourceNameDraft}
            onkeydown={(e) => {
              if (e.key === "Enter") saveSourceRename(canvasImage);
              if (e.key === "Escape") editingSource = false;
            }}
          />
          <button class="icon-btn" onclick={() => saveSourceRename(canvasImage)} title="Save name">
            <Check size={14} />
          </button>
        {:else}
          <span class="canvas-title">{canvasImage.videoName}</span>
          <button class="icon-btn" onclick={() => startSourceRename(canvasImage)} title="Rename">
            <Pencil size={13} />
          </button>
        {/if}
        <span class="canvas-meta mono">{sourceMeta(canvasImage)}</span>
        <a class="icon-btn" href={`/video/${canvasImage.id}`} title="Open in library">
          <FileText size={14} />
        </a>
        <button
          class="icon-btn danger"
          onclick={() => handleDeleteSource(canvasImage)}
          title="Delete from library"
          aria-label="Delete from library"
        >
          <Trash2 size={14} />
        </button>
      </div>
      {#if canvasImage.localPath}
        <img
          class="canvas-image"
          src={convertFileSrc(canvasImage.localPath)}
          alt={canvasImage.videoName}
        />
      {/if}
      <div class="animate-box">
        <div class="animate-head"><Film size={14} /> Animate this image</div>
        <textarea
          rows="2"
          placeholder="Describe the motion, e.g. “The flamingo slowly wades forward as ripples spread”…"
          bind:value={animatePrompt}
          disabled={animating}
        ></textarea>
        <div class="animate-actions">
          <button
            class="btn primary"
            onclick={() => handleAnimate(canvasImage)}
            disabled={animating || !animatePrompt.trim() || !apiKey}
          >
            {#if animating}
              <span class="spinner"></span> {animateStatus || "Working…"}
            {:else}
              <Sparkles size={15} /> Generate video
            {/if}
          </button>
          <span class="gen-hint mono">
            {videoTier.label} · ~8s clip · ~${videoTier.costPerClip.toFixed(2)} · 1-2 min
          </span>
        </div>
      </div>
    </section>
  {:else if canvas.kind === "video" && canvasVideo}
    <section class="canvas">
      <div class="canvas-head">
        <button class="btn small" onclick={showOverview}>
          <ArrowLeft size={13} /> Overview
        </button>
        {#if editingSource}
          <input
            class="source-name-input"
            bind:value={sourceNameDraft}
            onkeydown={(e) => {
              if (e.key === "Enter") saveSourceRename(canvasVideo);
              if (e.key === "Escape") editingSource = false;
            }}
          />
          <button class="icon-btn" onclick={() => saveSourceRename(canvasVideo)} title="Save name">
            <Check size={14} />
          </button>
        {:else}
          <span class="canvas-title">{canvasVideo.videoName}</span>
          <button class="icon-btn" onclick={() => startSourceRename(canvasVideo)} title="Rename">
            <Pencil size={13} />
          </button>
        {/if}
        <span class="canvas-meta mono">{sourceMeta(canvasVideo)}</span>
        <a class="icon-btn" href={`/video/${canvasVideo.id}`} title="Open in library">
          <FileText size={14} />
        </a>
        <button
          class="icon-btn danger"
          onclick={() => handleDeleteSource(canvasVideo)}
          title="Delete from library"
          aria-label="Delete from library"
        >
          <Trash2 size={14} />
        </button>
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
    {#snippet reportsSection()}
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
      {#if project!.reports.length === 0 && !reportBusy}
        <div class="placeholder">
          <FileText size={30} />
          <p>No reports yet.</p>
          <p class="hint">
            Generate a timestamped, screenshot-illustrated writeup that
            cross-references this project's videos against its repos — hit
            “New report”, or ask the chat to propose one.
          </p>
        </div>
      {:else if project!.reports.length > 0}
        <ul class="report-list">
          {#each project!.reports as r (r.id)}
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
    {/snippet}

    {#snippet studioSection()}
      {#if isMac && $autoEditEnabled}
        <div class="reports-head" class:edits-head={!studioFirst}>
          <button
            class="studio-toggle"
            onclick={() => (studioOpen = !studioOpen)}
            aria-expanded={studioOpen}
          >
            <h2><Clapperboard size={16} /> Studio</h2>
            <span class="chev" class:open={studioOpen}><ChevronDown size={15} /></span>
          </button>
          {#if studioOpen}
            <div class="studio-actions">
              <button
                class="btn"
                onclick={() => { genPrompt = ""; genModalOpen = true; }}
                disabled={genBusy || !apiKey}
              >
                <ImageIcon size={15} /> New image
              </button>
              <button
                class="btn primary"
                onclick={() => (editModalOpen = true)}
                disabled={editBusy || !apiKey}
              >
                <Plus size={15} /> New edit
              </button>
            </div>
          {/if}
        </div>
        {#if genBusy}
          <div class="report-progress">
            <span class="spinner"></span>
            <span class="mono">Generating image…</span>
          </div>
        {/if}
        {#if animating}
          <div class="report-progress">
            <span class="spinner"></span>
            <span class="mono">{animateStatus || "Generating video…"}</span>
          </div>
        {/if}
        {#if editBusy}
          <div class="report-progress">
            <span class="spinner"></span>
            <span class="mono">{editStatus ?? "Generating edit…"}</span>
            {#if editProgress != null}
              <progress value={editProgress} max="1"></progress>
              <span class="mono">{Math.round(editProgress * 100)}%</span>
            {/if}
          </div>
        {/if}
        {#if studioOpen}
          {#if project!.edits.length === 0 && !editBusy}
            <div class="placeholder">
              <Clapperboard size={30} />
              <p>No edits yet.</p>
              <p class="hint">
                Have Gemini watch this project's local videos, pick the best
                moments, and splice them into a finished MP4 — with your own
                music track if you like. Or start from nothing: “New image”
                generates an image you can animate into a clip, right here.
              </p>
            </div>
          {:else if project!.edits.length > 0}
            <ul class="report-list">
              {#each project!.edits as e (e.id)}
                <li>
                  <button class="report-card" onclick={() => (canvas = { kind: "edit", editId: e.id })}>
                    <Clapperboard size={16} />
                    <div class="report-info">
                      <span class="report-title">{e.title}</span>
                      <span class="report-meta mono">
                        {fmtDate(e.createdAt)} · {fmtSec(e.durationSec)} · ~${e.costUsd.toFixed(2)}
                      </span>
                    </div>
                  </button>
                  <button
                    class="icon-btn danger"
                    onclick={() => handleDeleteEdit(e)}
                    title="Delete edit"
                    aria-label="Delete edit"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      {/if}
    {/snippet}

    <section class="overview">
      {#if studioFirst}
        {@render studioSection()}
        {#if showReports}
          <div class="section-gap"></div>
          {@render reportsSection()}
        {/if}
      {:else}
        {#if showReports}
          {@render reportsSection()}
        {/if}
        {@render studioSection()}
        {#if !showReports && !(isMac && $autoEditEnabled)}
          <div class="placeholder">
            <FolderKanban size={30} />
            <p>Add sources to get started.</p>
          </div>
        {/if}
      {/if}
    </section>
  {/if}
  </div>
  </div>

  {#if genModalOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
    <div class="modal-scrim" onclick={() => (genModalOpen = false)}></div>
    <div class="modal" role="dialog" aria-label="Generate image">
      <h3><ImageIcon size={16} /> Generate an image</h3>
      <label class="field">
        <span>Prompt</span>
        <textarea
          rows="3"
          placeholder="e.g. A pink flamingo standing in still water at sunrise…"
          bind:value={genPrompt}
        ></textarea>
      </label>
      <div class="sources-field">
        <span class="sources-label">Aspect ratio</span>
        <div class="aspect-row">
          {#each ["1:1", "9:16", "16:9"] as const as a (a)}
            <button class="aspect-opt" class:on={genAspect === a} onclick={() => (genAspect = a)}>
              {a}
            </button>
          {/each}
        </div>
      </div>
      <p class="gen-hint mono">~${IMAGE_COST_PER_IMAGE.toFixed(2)} per image · lands directly in this project's sources</p>
      <div class="modal-actions">
        <button class="btn" onclick={() => (genModalOpen = false)}>Cancel</button>
        <button class="btn primary" onclick={handleGenerateImage} disabled={!genPrompt.trim()}>
          <Sparkles size={14} /> Generate
        </button>
      </div>
    </div>
  {/if}

  {#if editModalOpen}
    <AutoEditModal
      members={videoMembers}
      onGenerate={runEditGeneration}
      onClose={() => (editModalOpen = false)}
    />
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

  /* ── Workspace layout: member tree + canvas ── */
  .workspace {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
  }
  @media (max-width: 900px) {
    .workspace { grid-template-columns: 1fr; }
  }
  .workspace-main { min-width: 0; }

  .member-tree {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 0.65rem 0.55rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    position: sticky;
    top: 0.5rem;
  }
  .tree-head {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    padding: 0.1rem 0.45rem 0.35rem;
  }
  .tree-empty { margin: 0; padding: 0.2rem 0.45rem 0.4rem; font-size: 0.82rem; color: var(--text-dim); }
  .tree-folder {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: 100%;
    padding: 0.35rem 0.45rem;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font-size: 0.84rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
  }
  .tree-folder:hover { background: var(--hover); }
  .tree-folder .chev {
    display: inline-flex;
    color: var(--text-dim);
    transition: transform 0.15s;
    transform: rotate(-90deg);
  }
  .tree-folder .chev.open { transform: rotate(0deg); }
  .tree-count {
    margin-left: auto;
    font-size: 0.68rem;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
  }
  .tree-items { list-style: none; margin: 0 0 0.2rem; padding: 0; }
  .tree-item {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    border-radius: var(--radius-sm);
    padding-left: 1.15rem;
  }
  .tree-item:hover { background: var(--hover); }
  .tree-item.active { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .tree-item.active .tree-name { color: var(--accent); }
  .tree-name {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
    padding: 0.32rem 0.2rem;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 0.83rem;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
  }
  .tree-name :global(svg) { color: var(--accent); flex-shrink: 0; }
  .tree-name span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-x {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    padding: 0;
    margin-right: 0.25rem;
    opacity: 0;
    flex-shrink: 0;
    transition: opacity 0.12s;
  }
  .tree-item:hover .tree-x { opacity: 1; }
  .tree-x:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
  .tree-item.removed { padding: 0.3rem 0.2rem 0.3rem 1.15rem; }
  .tree-removed { flex: 1; font-size: 0.8rem; font-style: italic; color: var(--text-dim); }
  .tree-item.removed .tree-x { opacity: 1; }
  .tree-add {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.35rem;
    padding: 0.42rem 0.45rem;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-dim);
    font-size: 0.82rem;
    font-family: inherit;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .tree-add:hover { color: var(--accent); border-color: var(--accent); }

  .canvas-image {
    display: block;
    width: 100%;
    max-height: 60vh;
    object-fit: contain;
    background: #000;
  }

  .animate-box {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    padding: 0.9rem 1rem 1rem;
    border-top: 1px solid var(--border);
  }
  .animate-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.88rem;
    font-weight: 600;
  }
  .animate-head :global(svg) { color: var(--accent); }
  .animate-box textarea {
    width: 100%;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    font-family: inherit;
    font-size: 0.86rem;
    resize: vertical;
  }
  .animate-box textarea:focus { outline: none; border-color: var(--accent); }
  .animate-actions { display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap; }
  .gen-hint { font-size: 0.74rem; color: var(--text-dim); margin: 0; }

  .studio-actions { display: flex; gap: 0.5rem; }
  .aspect-row { display: flex; gap: 0.4rem; }
  .aspect-opt {
    padding: 0.4rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg);
    color: var(--text-dim);
    font-size: 0.84rem;
    font-family: "JetBrains Mono", monospace;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .aspect-opt:hover { color: var(--text); }
  .aspect-opt.on {
    border-color: var(--accent);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }

  .picker {
    margin-top: 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    padding: 0.55rem;
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
  .source-name-input {
    flex: 1;
    min-width: 0;
    font-size: 0.88rem;
    font-family: inherit;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
  }
  .source-name-input:focus { outline: none; }
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

  .edits-head { margin-top: 1.6rem; }
  .section-gap { height: 1.6rem; }
  .studio-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    border: none;
    background: transparent;
    padding: 0;
    cursor: pointer;
    color: inherit;
    font-family: inherit;
  }
  .studio-toggle .chev {
    display: inline-flex;
    color: var(--text-dim);
    transition: transform 0.15s;
  }
  .studio-toggle .chev.open { transform: rotate(180deg); }
  .report-progress progress {
    width: 160px;
    height: 8px;
    accent-color: var(--accent);
  }

  .edit-plan { padding: 0.9rem 1.2rem 1.2rem; }
  .edit-plan h4 { margin: 0 0 0.5rem; font-size: 0.9rem; }
  .edit-plan ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .clip-row {
    display: flex;
    align-items: baseline;
    gap: 0.7rem;
    width: 100%;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    text-align: left;
    transition: border-color 0.15s;
  }
  .clip-row:hover { border-color: var(--accent); }
  .clip-range { color: var(--accent); font-size: 0.78rem; flex-shrink: 0; }
  .clip-source {
    font-weight: 600;
    flex-shrink: 0;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .clip-reason { color: var(--text-dim); min-width: 0; }
</style>
