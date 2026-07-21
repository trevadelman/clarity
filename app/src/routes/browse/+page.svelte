<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    Globe, ExternalLink, X, ArrowLeft, ArrowRight, RotateCw, MessageCircle,
  } from "lucide-svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { selectedLink } from "$lib/browseState";
  import { faviconUrl, type BookmarkNode } from "$lib/bookmarks";
  import { openTab, setTabRect, closeTab, hideAllTabs, tabHistory } from "$lib/tabs";
  import type { Rect } from "$lib/researchView";
  import { toast } from "$lib/toast";
  import ChatPanel from "$lib/ChatPanel.svelte";
  import { generatePageChatReply, type ChatMessage } from "$lib/gemini";
  import { loadApiKey } from "$lib/settings";
  import {
    getPageMeta, getPageText, getPageHtml, getSelection, getPageLinks, navigateTo,
  } from "$lib/pageTools";

  // The native child webview renders above all HTML, so this page only
  // reserves screen space: the placeholder div's rect is reported to Rust,
  // which positions the active tab webview over it (same pattern as the
  // repo research view).
  let placeholderEl = $state<HTMLElement | null>(null);
  let active = $state<BookmarkNode | null>(null);

  // Page chat: one session-only thread per tab (keyed by bookmark id).
  let chatOpen = $state(false);
  let toolStatus = $state<string | null>(null);
  let threads = $state<Record<string, ChatMessage[]>>({});
  const messages = $derived(active ? (threads[active.id] ?? []) : []);

  /** Executes one page tool against the active tab. */
  async function runPageTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!active) throw new Error("No page is open.");
    const id = active.id;
    switch (name) {
      case "get_page_meta": return getPageMeta(id);
      case "get_page_text": return getPageText(id);
      case "get_page_html": return getPageHtml(id);
      case "get_selection": return getSelection(id);
      case "get_page_links": return getPageLinks(id);
      case "navigate_to": return navigateTo(id, String(args.url ?? ""));
      default: throw new Error(`Unknown page tool: ${name}`);
    }
  }

  async function askPage(question: string) {
    if (!active) return;
    const tabId = active.id;
    const apiKey = await loadApiKey();
    if (!apiKey) {
      toast.error("Set your Gemini API key in Settings first.");
      return;
    }
    const history = threads[tabId] ?? [];
    threads[tabId] = [...history, { role: "user", text: question, at: new Date().toISOString() }];
    toolStatus = null;
    try {
      const reply = await generatePageChatReply(
        apiKey, question, history, active.label, active.url ?? "",
        runPageTool,
        (label) => (toolStatus = label)
      );
      threads[tabId] = [
        ...threads[tabId],
        {
          role: "model", text: reply.text, at: new Date().toISOString(),
          costUsd: reply.usage.costUsd, toolCalls: reply.toolCalls,
        },
      ];
    } catch (err) {
      threads[tabId] = history; // roll back the optimistic user turn
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      toolStatus = null;
    }
  }

  async function clearPageChat() {
    if (active) threads[active.id] = [];
  }

  /** Current theme's surface color (#rrggbb) for the webview's pre-paint bg. */
  function themeBg(): string | undefined {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--surface")
      .trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined;
  }

  function currentRect(): Rect | null {
    if (!placeholderEl) return null;
    const r = placeholderEl.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  async function syncRect() {
    if (!active) return;
    const rect = currentRect();
    if (rect && rect.width > 0) {
      try {
        await setTabRect(rect);
      } catch {
        // Tab may have been evicted; ignore.
      }
    }
  }

  // React to tree selections: open (or re-show) that link's tab.
  $effect(() => {
    const link = $selectedLink;
    if (!link?.url) return;
    (async () => {
      const rect = currentRect();
      if (!rect || rect.width === 0) return;
      try {
        await openTab(link.id, link.url!, rect, themeBg());
        active = link;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    })();
  });

  async function closeActive() {
    if (!active) return;
    try {
      await closeTab(active.id);
    } catch {
      // Already gone; fine.
    }
    active = null;
    selectedLink.set(null);
  }

  async function history(action: "back" | "forward" | "reload") {
    if (!active) return;
    try {
      await tabHistory(active.id, action);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  let observer: ResizeObserver | null = null;

  onMount(() => {
    observer = new ResizeObserver(() => void syncRect());
    if (placeholderEl) observer.observe(placeholderEl);
    window.addEventListener("resize", syncRect);
  });

  onDestroy(() => {
    observer?.disconnect();
    window.removeEventListener("resize", syncRect);
    // Hide (don't destroy) so page state survives a round trip to Library.
    void hideAllTabs();
  });
</script>

<div class="surface" class:chat-docked={chatOpen}>
  <header class="chrome">
    <div class="nav-btns">
      <button class="icon-btn" onclick={() => history("back")} disabled={!active} title="Back" aria-label="Back">
        <ArrowLeft size={14} />
      </button>
      <button class="icon-btn" onclick={() => history("forward")} disabled={!active} title="Forward" aria-label="Forward">
        <ArrowRight size={14} />
      </button>
      <button class="icon-btn" onclick={() => history("reload")} disabled={!active} title="Reload" aria-label="Reload">
        <RotateCw size={13} />
      </button>
    </div>
    {#if active?.url}
      <img class="ico" src={faviconUrl(active.url)} alt="" />
      <div class="head-text">
        <strong>{active.label}</strong>
        <span class="crumb" title={active.url}>{active.url}</span>
      </div>
      <span class="head-spacer"></span>
      <button class="chat-btn" class:on={chatOpen} onclick={() => (chatOpen = !chatOpen)} title="Ask AI about this page">
        <MessageCircle size={14} /> Ask AI
      </button>
      <button class="icon-btn" onclick={() => openUrl(active!.url!)} title="Open in browser" aria-label="Open in browser">
        <ExternalLink size={14} />
      </button>
      <button class="icon-btn" onclick={closeActive} title="Close tab" aria-label="Close tab">
        <X size={15} />
      </button>
    {:else}
      <span class="glyph"><Globe size={15} /></span>
      <div class="head-text"><strong>Browse</strong></div>
    {/if}
  </header>

  <!-- Layout reservation only: the active tab webview renders over this. -->
  <div class="placeholder" bind:this={placeholderEl}>
    {#if !active}
      <div class="empty">
        <span class="empty-icon"><Globe size={40} /></span>
        <h2>Nothing open</h2>
        <p>Pick a link from the sidebar tree, or add one to get started.</p>
      </div>
    {:else}
      <!-- Sits under the native webview; visible only until first paint,
           so opening a tab shows themed bg + spinner, not a white flash. -->
      <div class="loading"><span class="spinner"></span></div>
    {/if}
  </div>
</div>

<!-- The native webview covers ChatPanel's floating FAB, so it's hidden;
     the chrome bar's "Ask AI" button opens the panel instead. -->
{#if active}
  <div class="chat-wrap">
    <ChatPanel
    bind:open={chatOpen}
    title={active.label}
    {messages}
    onAsk={askPage}
    onClear={clearPageChat}
    showScrim={false}
    {toolStatus}
      emptyHint="Ask about this page — the AI can read its live content."
    />
  </div>
{/if}

<style>
  .surface {
    /* Fill the content area edge-to-edge (the layout adds padding we undo). */
    margin: -1.5rem -2.25rem -2rem;
    height: calc(100vh - var(--titlebar-h, 0px));
    display: flex;
    flex-direction: column;
    transition: margin-right 0.2s ease;
  }
  /* The native webview renders above HTML, so shrink out of the docked
     chat's way (ResizeObserver re-syncs the tab rect). */
  .surface.chat-docked {
    margin-right: calc(min(420px, 92vw) - 2.25rem);
  }
  .chrome {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    /* Fixed height shared with ChatPanel's header so the two align. */
    height: var(--panel-head-h, 52px);
    padding: 0 0.8rem;
    background: var(--bg);
    flex-shrink: 0;
  }
  .nav-btns { display: inline-flex; gap: 0.25rem; }
  .chat-wrap :global(.fab) { display: none; }
  .chat-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    height: 30px;
    padding: 0 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-dim);
    font-size: 0.8rem;
    font-family: inherit;
    cursor: pointer;
    flex-shrink: 0;
  }
  .chat-btn:hover { background: var(--hover); color: var(--text); }
  .chat-btn.on {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
    color: var(--accent);
  }
  .icon-btn {
    /* Ghost buttons: no border at rest, subtle pill on hover (softer than
       the boxed look). */
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    flex-shrink: 0;
  }
  .icon-btn:hover:not(:disabled) { background: var(--hover); color: var(--text); }
  .icon-btn:disabled { opacity: 0.4; cursor: default; }
  .ico { width: 16px; height: 16px; border-radius: 4px; flex-shrink: 0; }
  .glyph { display: inline-flex; color: var(--accent); flex-shrink: 0; }
  .head-text {
    /* One compact line: label, then dimmed URL beside it. */
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.85rem;
    overflow: hidden;
  }
  .head-text strong { white-space: nowrap; }
  .head-spacer { flex: 1; }
  .crumb {
    min-width: 0;
    font-size: 0.74rem;
    font-family: "JetBrains Mono", monospace;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .placeholder {
    flex: 1;
    min-height: 0;
    background: var(--surface);
    display: grid;
    place-items: center;
  }
  .loading { display: grid; place-items: center; }
  .spinner {
    width: 26px;
    height: 26px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty { text-align: center; color: var(--text-dim); }
  .empty-icon { color: var(--accent); display: inline-flex; }
  .empty h2 { margin: 0.7rem 0 0.2rem; color: var(--text); font-size: 1.1rem; }
  .empty p { font-size: 0.88rem; margin: 0.3rem 0 0; }
</style>
