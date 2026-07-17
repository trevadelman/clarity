<script lang="ts">
  import { fly, fade } from "svelte/transition";
  import { tick } from "svelte";
  import { marked } from "marked";
  import { MessageCircle, X, Send, Trash2, Film, Search, ChevronDown } from "lucide-svelte";
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
  }

  let {
    title, messages, onAsk, onClear, onSeek, disabled = false,
    emptyHint = "Ask anything about this video.",
    videoNames = null,
    toolStatus = null,
  }: Props = $props();

  let open = $state(false);
  let question = $state("");
  let busy = $state(false);
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

  async function togglePanel() {
    open = !open;
    if (open) await scrollToBottom();
  }

  const TS_RE = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g;
  const VIDEO_RE = /\[VIDEO:\s*([\w-]+)\s*(?:@\s*(\d{1,2}:\d{2}(?::\d{2})?))?\s*\]/g;

  /** Convert citation + timestamp markers into clickable chips, then markdown. */
  function renderMessage(text: string): string {
    let out = text;
    if (videoNames) {
      out = out.replace(VIDEO_RE, (_m, vid, ts) => {
        const name = videoNames?.[vid];
        if (!name) return "";
        const label = ts ? `${name} @ ${ts}` : name;
        return `<a class="vid-chip" href="/video/${vid}">${label}</a>`;
      });
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
    const target = (e.target as HTMLElement).closest(".ts-chip");
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
  <div class="scrim" transition:fade={{ duration: 120 }} onclick={togglePanel} aria-hidden="true"></div>
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
    top: 0;
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
    padding: 2.6rem 1rem 0.8rem;
    border-bottom: 1px solid var(--border);
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
