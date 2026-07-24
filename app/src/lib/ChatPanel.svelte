<script lang="ts">
  import { fly, fade } from "svelte/transition";
  import { tick } from "svelte";
  import { marked } from "marked";
  import {
    MessageCircle, X, Send, Trash2, Film, Search, ChevronDown,
    FileText, Check,
  } from "lucide-svelte";
  import { onDestroy } from "svelte";
  import { chatDocked } from "$lib/chatDock";
  import type { ChatMessage } from "$lib/gemini";

  interface Props {
    /** Panel header title (e.g. the video name). */
    title: string;
    /** Persisted thread to display; parent owns the source of truth. */
    messages: ChatMessage[];
    /** Called with the question when the user submits one. */
    onAsk: (question: string) => Promise<void>;
    /** Called when the user clears the thread. */
    onClear: () => Promise<void>;
    /** Called when a [mm:ss] timestamp chip is clicked. */
    onSeek?: (sec: number) => void;
    /** Disable input (e.g. no API key). */
    disabled?: boolean;
    /** Hint shown when the thread is empty. */
    emptyHint?: string;
    /**
     * Library mode: map of video id → display name, used to render
     * [VIDEO:id] citations as links to `/video/<id>`.
     */
    videoNames?: Record<string, string> | null;
    /** Live research status line (e.g. "Reading src/lib/media.ts…"). */
    toolStatus?: string | null;
    /** Hide the dimming scrim (e.g. while the research view is open). */
    showScrim?: boolean;
    /** Called when a [FILE:path] or [COMMIT:sha] citation chip is clicked. */
    onCitation?: (kind: "file" | "commit", value: string) => void;
    /**
     * Project mode: handles repo-qualified citations ([FILE:repo:path],
     * [COMMIT:repo:sha]) and video-qualified timestamps ([TS:videoId:mm:ss]).
     */
    onProjectCite?: (
      kind: "file" | "commit" | "ts",
      scope: string,
      value: string
    ) => void;
    /** Project mode: video id → display name for timestamp chip labels. */
    projectVideoNames?: Record<string, string> | null;
    /**
     * Project mode: user approved a chat report proposal. Receives the
     * message index (so the parent can persist the outcome) and the
     * possibly-edited title/prompt.
     */
    onApproveReport?: (msgIndex: number, title: string, prompt: string) => Promise<void>;
    /** Project mode: user dismissed a chat report proposal. */
    onDismissReport?: (msgIndex: number) => void;
    /** Project mode: open a generated report (from a proposal card). */
    onOpenReport?: (reportId: string) => void;
    /** Whether the panel is expanded; bindable so parents can open it. */
    open?: boolean;
  }

  let {
    title, messages, onAsk, onClear, onSeek, disabled = false,
    emptyHint = "Ask anything about this video.",
    videoNames = null,
    toolStatus = null,
    showScrim = true,
    onCitation,
    onProjectCite,
    projectVideoNames = null,
    onApproveReport,
    onDismissReport,
    onOpenReport,
    open = $bindable(false),
  }: Props = $props();
  let question = $state("");
  let busy = $state(false);
  /** Inline edits to a pending proposal's prompt, keyed by message index. */
  let proposalDrafts = $state<Record<number, string>>({});
  /** Message index of a proposal currently generating. */
  let generatingProposal = $state<number | null>(null);

  async function approveProposal(i: number, title: string, prompt: string) {
    if (!onApproveReport || generatingProposal !== null) return;
    generatingProposal = i;
    try {
      await onApproveReport(i, title, proposalDrafts[i] ?? prompt);
    } finally {
      generatingProposal = null;
    }
  }
  let scrollEl = $state<HTMLElement | null>(null);
  let openTrails = $state<Set<number>>(new Set());

  function toggleTrail(i: number) {
    const next = new Set(openTrails);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    openTrails = next;
  }

  const totalCost = $derived(
    messages.reduce((sum, m) => sum + (m.costUsd ?? 0), 0)
  );

  async function scrollToBottom() {
    await tick();
    scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" });
  }

  // Whenever the panel opens (via the FAB or externally through bind:open),
  // jump straight to where the conversation left off.
  $effect(() => {
    if (open && scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  });

  // Let the layout know a chat is docked (it auto-collapses the sidebar).
  $effect(() => {
    chatDocked.set(open);
  });
  onDestroy(() => chatDocked.set(false));

  async function submit() {
    const q = question.trim();
    if (!q || busy || disabled) return;
    question = "";
    busy = true;
    try {
      await onAsk(q);
      await scrollToBottom();
    } finally {
      busy = false;
    }
  }

  function togglePanel() {
    open = !open;
  }

  const TS_RE = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g;
  const VIDEO_RE = /\[VIDEO:\s*([\w-]+)\s*(?:@\s*(\d{1,2}:\d{2}(?::\d{2})?))?\s*\]/g;
  // Greedy (\S+) so paths containing brackets — e.g. SvelteKit's
  // routes/video/[id]/+page.svelte — keep them; backtracking yields the
  // final ] to close the citation.
  const FILE_RE = /\[FILE:\s*(\S+)\s*\]/g;
  const COMMIT_RE = /\[COMMIT:\s*([0-9a-f]{6,40})\s*\]/gi;
  // Project-mode, scope-qualified forms. Repo names may contain owner/repo.
  const P_TS_RE = /\[TS:\s*([\w-]+)\s*:\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\]/g;
  const P_FILE_RE = /\[FILE:\s*([^:\]\s]+)\s*:\s*(\S+)\s*\]/g;
  const P_COMMIT_RE = /\[COMMIT:\s*([^:\]\s]+)\s*:\s*([0-9a-f]{6,40})\s*\]/gi;

  /** Convert citation + timestamp markers into clickable chips, then markdown. */
  function renderMessage(text: string): string {
    let out = text;
    if (onProjectCite) {
      out = out.replace(P_TS_RE, (_m, vid, ts) => {
        const name = projectVideoNames?.[vid];
        const label = name ? `${name} @ ${ts}` : ts;
        return `<button class="ts-chip" data-p-kind="ts" data-p-scope="${vid}" data-p-value="${ts}">${label}</button>`;
      });
      out = out.replace(P_FILE_RE, (_m, repo, path) =>
        `<button class="cite-chip" data-p-kind="file" data-p-scope="${repo}" data-p-value="${path}">${repo}: ${path}</button>`);
      out = out.replace(P_COMMIT_RE, (_m, repo, sha) =>
        `<button class="cite-chip" data-p-kind="commit" data-p-scope="${repo}" data-p-value="${sha}">${repo}: ${String(sha).slice(0, 7)}</button>`);
    }
    if (videoNames) {
      out = out.replace(VIDEO_RE, (_m, vid, ts) => {
        const name = videoNames?.[vid];
        if (!name) return "";
        const label = ts ? `${name} @ ${ts}` : name;
        return `<a class="vid-chip" href="/video/${vid}">${label}</a>`;
      });
    }
    if (onCitation) {
      out = out.replace(FILE_RE, (_m, path) =>
        `<button class="cite-chip" data-cite-kind="file" data-cite-value="${path}">${path}</button>`);
      out = out.replace(COMMIT_RE, (_m, sha) =>
        `<button class="cite-chip" data-cite-kind="commit" data-cite-value="${sha}">${String(sha).slice(0, 7)}</button>`);
    }
    const withChips = out.replace(TS_RE, (_m, a, b, c) => {
      const sec = c != null
        ? Number(a) * 3600 + Number(b) * 60 + Number(c)
        : Number(a) * 60 + Number(b);
      const label = c != null ? `${a}:${b}:${c}` : `${a}:${b}`;
      return `<button class="ts-chip" data-sec="${sec}">${label}</button>`;
    });
    return marked.parse(withChips) as string;
  }

  function handleBodyClick(e: MouseEvent) {
    const el = e.target as HTMLElement;
    const pcite = el.closest("[data-p-kind]");
    if (pcite) {
      const kind = pcite.getAttribute("data-p-kind") as "file" | "commit" | "ts";
      const scope = pcite.getAttribute("data-p-scope") ?? "";
      const value = pcite.getAttribute("data-p-value") ?? "";
      if (scope && value) onProjectCite?.(kind, scope, value);
      return;
    }
    const cite = el.closest(".cite-chip");
    if (cite) {
      const kind = cite.getAttribute("data-cite-kind") as "file" | "commit";
      const value = cite.getAttribute("data-cite-value") ?? "";
      if (value) onCitation?.(kind, value);
      return;
    }
    const target = el.closest(".ts-chip");
    if (!target) return;
    const sec = Number(target.getAttribute("data-sec"));
    if (!Number.isNaN(sec)) onSeek?.(sec);
  }

  function fmtCost(usd: number): string {
    return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  }
</script>

<button class="fab" class:hidden={open} onclick={togglePanel} aria-label="Chat about this video">
  <MessageCircle size={22} />
</button>

{#if open}
  {#if showScrim}
    <div class="scrim" transition:fade={{ duration: 120 }} onclick={togglePanel} aria-hidden="true"></div>
  {/if}
  <aside class="panel" transition:fly={{ x: 420, duration: 200 }}>
    <header class="panel-head">
      <div class="head-text">
        <strong>Chat</strong>
        <span class="head-sub" title={title}>{title}</span>
      </div>
      {#if totalCost > 0}
        <span class="cost mono">~{fmtCost(totalCost)}</span>
      {/if}
      {#if messages.length > 0}
        <button class="icon-btn" onclick={onClear} title="Clear chat" aria-label="Clear chat">
          <Trash2 size={15} />
        </button>
      {/if}
      <button class="icon-btn" onclick={togglePanel} aria-label="Close chat"><X size={16} /></button>
    </header>

    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
    <div class="thread" bind:this={scrollEl} onclick={handleBodyClick} role="log">
      {#if messages.length === 0}
        <div class="empty">
          <Film size={26} />
          <p>{emptyHint}</p>
        </div>
      {/if}
      {#each messages as m, i (i)}
        <div class="msg {m.role}">
          {#if m.role === "user"}
            <div class="bubble user">{m.text}</div>
          {:else}
            <div class="model-wrap">
              {#if m.toolCalls?.length}
                <button class="trail-toggle" onclick={() => toggleTrail(i)} aria-expanded={openTrails.has(i)}>
                  <Search size={11} />
                  Researched · {m.toolCalls.length} step{m.toolCalls.length === 1 ? "" : "s"}
                  <span class="trail-chev" class:open={openTrails.has(i)}><ChevronDown size={11} /></span>
                </button>
                {#if openTrails.has(i)}
                  <ol class="trail" transition:fade={{ duration: 100 }}>
                    {#each m.toolCalls as step, j (j)}
                      <li>{step}</li>
                    {/each}
                  </ol>
                {/if}
              {/if}
              <div class="bubble model markdown">{@html renderMessage(m.text)}</div>
              {#if m.reportProposal}
                {@const p = m.reportProposal}
                <div class="proposal" class:settled={p.status !== "pending"}>
                  <div class="proposal-head">
                    <FileText size={14} />
                    <span class="proposal-title">{p.title}</span>
                  </div>
                  {#if p.status === "pending"}
                    <textarea
                      class="proposal-prompt"
                      rows="4"
                      value={proposalDrafts[i] ?? p.prompt}
                      oninput={(e) => (proposalDrafts[i] = (e.target as HTMLTextAreaElement).value)}
                      disabled={generatingProposal !== null}
                    ></textarea>
                    <div class="proposal-actions">
                      <button
                        class="proposal-btn primary"
                        onclick={() => approveProposal(i, p.title, p.prompt)}
                        disabled={generatingProposal !== null}
                      >
                        {#if generatingProposal === i}
                          Generating…
                        {:else}
                          <Check size={13} /> Generate report
                        {/if}
                      </button>
                      <button
                        class="proposal-btn"
                        onclick={() => onDismissReport?.(i)}
                        disabled={generatingProposal !== null}
                      >
                        Dismiss
                      </button>
                    </div>
                  {:else if p.status === "generated" && p.reportId}
                    <button class="proposal-btn primary" onclick={() => onOpenReport?.(p.reportId!)}>
                      <FileText size={13} /> Open report
                    </button>
                  {:else}
                    <span class="proposal-dismissed">Dismissed</span>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
      {#if busy}
        <div class="msg model"><div class="bubble model thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div></div>
        {#if toolStatus}
          <div class="tool-status" transition:fade={{ duration: 100 }}>{toolStatus}</div>
        {/if}
      {/if}
    </div>

    <form class="composer" onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <input
        type="text"
        placeholder={disabled ? "Set your API key in Settings first" : "Ask a question…"}
        bind:value={question}
        disabled={busy || disabled}
      />
      <button type="submit" class="send" disabled={!question.trim() || busy || disabled} aria-label="Send">
        <Send size={16} />
      </button>
    </form>
  </aside>
{/if}

<style>
  .fab {
    position: fixed;
    right: 1.5rem;
    bottom: 1.5rem;
    z-index: 600;
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border: none;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    box-shadow: var(--shadow-lg);
    transition: transform 0.15s, background 0.15s;
  }
  .fab:hover { background: var(--accent-hover); transform: translateY(-2px); }
  .fab.hidden { display: none; }

  .scrim {
    position: fixed;
    inset: 0;
    z-index: 640;
    background: rgba(0, 0, 0, 0.25);
  }

  .panel {
    position: fixed;
    top: var(--titlebar-h, 0px);
    right: 0;
    bottom: 0;
    z-index: 650;
    width: min(420px, 92vw);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-left: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
  }
  .panel-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    /* Fixed height shared with the browse chrome so the two headers align. */
    height: var(--panel-head-h, 52px);
    padding: 0 1rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .head-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.25;
  }
  .head-sub {
    font-size: 0.78rem;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cost { font-size: 0.72rem; color: var(--text-dim); }
  .mono { font-family: "JetBrains Mono", monospace; }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    flex-shrink: 0;
  }
  .icon-btn:hover { background: var(--hover); color: var(--text); }

  .thread {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .empty {
    margin: auto;
    text-align: center;
    color: var(--text-dim);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.88rem;
  }
  .empty :global(svg) { color: var(--accent); }
  .empty p { margin: 0; max-width: 240px; }

  .msg { display: flex; }
  .msg.user { justify-content: flex-end; }
  .bubble {
    max-width: 88%;
    padding: 0.55rem 0.8rem;
    border-radius: 14px;
    font-size: 0.88rem;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .bubble.user {
    background: var(--accent);
    color: #fff;
    border-bottom-right-radius: 4px;
  }
  .bubble.model {
    background: var(--hover);
    color: var(--text);
    border-bottom-left-radius: 4px;
    white-space: normal;
  }
  .bubble.thinking { display: inline-flex; gap: 0.3rem; padding: 0.7rem 0.9rem; }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-dim);
    animation: blink 1.2s infinite;
  }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }

  .model-wrap { display: flex; flex-direction: column; gap: 0.25rem; max-width: 88%; }
  .model-wrap .bubble { max-width: 100%; }
  .trail-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    align-self: flex-start;
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-size: 0.72rem;
    font-family: "JetBrains Mono", monospace;
    cursor: pointer;
    padding: 0.1rem 0.2rem;
  }
  .trail-toggle:hover { color: var(--text); }
  .trail-chev { display: inline-flex; transition: transform 0.15s; }
  .trail-chev.open { transform: rotate(180deg); }
  .trail {
    margin: 0 0 0.15rem;
    padding: 0.45rem 0.6rem 0.45rem 1.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    font-size: 0.72rem;
    font-family: "JetBrains Mono", monospace;
    color: var(--text-dim);
    line-height: 1.6;
  }

  .proposal {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    padding: 0.6rem 0.7rem;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--accent) 6%, var(--bg));
  }
  .proposal.settled { border-color: var(--border); background: var(--bg); }
  .proposal-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.82rem;
    font-weight: 600;
  }
  .proposal-head :global(svg) { color: var(--accent); flex-shrink: 0; }
  .proposal-title { overflow: hidden; text-overflow: ellipsis; }
  .proposal-prompt {
    width: 100%;
    resize: vertical;
    padding: 0.45rem 0.55rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-size: 0.78rem;
    font-family: inherit;
    line-height: 1.45;
  }
  .proposal-prompt:focus { outline: none; border-color: var(--accent); }
  .proposal-actions { display: flex; gap: 0.4rem; }
  .proposal-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-size: 0.78rem;
    font-family: inherit;
    cursor: pointer;
  }
  .proposal-btn:hover:not(:disabled) { background: var(--hover); }
  .proposal-btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .proposal-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    align-self: flex-start;
  }
  .proposal-btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
  .proposal-dismissed { font-size: 0.76rem; color: var(--text-dim); font-style: italic; }

  .tool-status {
    font-size: 0.76rem;
    color: var(--text-dim);
    font-family: "JetBrains Mono", monospace;
    padding-left: 0.4rem;
  }

  .markdown :global(p) { margin: 0.3rem 0; }
  .markdown :global(p:first-child) { margin-top: 0; }
  .markdown :global(p:last-child) { margin-bottom: 0; }
  .markdown :global(ul), .markdown :global(ol) { margin: 0.3rem 0; padding-left: 1.2rem; }
  .markdown :global(li) { margin: 0.15rem 0; }
  .markdown :global(code) {
    background: color-mix(in srgb, var(--text) 8%, transparent);
    padding: 0.08rem 0.3rem;
    border-radius: 4px;
    font-size: 0.82em;
    font-family: "JetBrains Mono", monospace;
  }
  .markdown :global(.ts-chip) {
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
  .markdown :global(.ts-chip:hover) {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .markdown :global(.vid-chip) {
    display: inline-block;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
    font-size: 0.8em;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    text-decoration: none;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
  }
  .markdown :global(.vid-chip:hover) {
    background: color-mix(in srgb, var(--accent) 24%, transparent);
  }
  .markdown :global(.cite-chip) {
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
  .markdown :global(.cite-chip:hover) {
    background: color-mix(in srgb, #a371f7 28%, transparent);
  }

  .composer {
    display: flex;
    gap: 0.5rem;
    padding: 0.75rem 1rem 1rem;
    border-top: 1px solid var(--border);
  }
  .composer input {
    flex: 1;
    padding: 0.55rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg);
    color: var(--text);
    font-size: 0.9rem;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s;
  }
  .composer input:focus { border-color: var(--accent); }
  .send {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border: none;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s, opacity 0.15s;
  }
  .send:hover:not(:disabled) { background: var(--accent-hover); }
  .send:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
