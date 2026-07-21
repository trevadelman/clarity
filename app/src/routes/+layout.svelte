<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { getVersion } from "@tauri-apps/api/app";
  import {
    Library, Plus, Settings, Moon, Sun, Video, Download, X,
    PanelLeftClose, PanelLeftOpen, ChevronDown, Globe,
  } from "lucide-svelte";
  import { marked } from "marked";
  import { theme, toggleTheme, initTheme } from "$lib/theme";
  import { checkForUpdate, installUpdate, isVersionDismissed, dismissVersion, type UpdateInfo } from "$lib/updates";
  import { toast } from "$lib/toast";
  import Toaster from "$lib/Toaster.svelte";
  import LinkTree from "$lib/LinkTree.svelte";
  import { chatDocked } from "$lib/chatDock";

  let { children } = $props();

  const links = [
    { href: "/", label: "Library", icon: Library },
    { href: "/add", label: "Add source", icon: Plus },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  const COLLAPSE_KEY = "sidebarCollapsed";
  const MODE_KEY = "sidebarMode";

  let update = $state<UpdateInfo | null>(null);
  let collapsed = $state(
    typeof localStorage !== "undefined" && localStorage.getItem(COLLAPSE_KEY) !== "0"
  );
  let mode = $state<"library" | "browse">(
    typeof localStorage !== "undefined" && localStorage.getItem(MODE_KEY) === "browse"
      ? "browse"
      : "library"
  );
  let installing = $state(false);
  let progressPct = $state<number | null>(null);
  let version = $state("");
  let notesOpen = $state(false);
  const notesHtml = $derived(update?.notes ? marked.parse(update.notes) : "");

  function toggleCollapsed() {
    collapsed = !collapsed;
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }

  // When a chat panel docks, auto-collapse the sidebar so the content gets
  // the screen (the chat is focused on it). One-way convenience: the user
  // re-expands manually whenever they want.
  $effect(() => {
    if ($chatDocked && !collapsed) collapsed = true;
  });

  function setMode(m: "library" | "browse") {
    mode = m;
    localStorage.setItem(MODE_KEY, m);
    // Leaving Browse while on /browse: navigate home so the browse page
    // unmounts and hides its native webview (which floats above HTML).
    if (m === "library" && $page.url.pathname.startsWith("/browse")) goto("/");
  }

  function isActive(href: string, path: string): boolean {
    return href === "/" ? path === "/" : path.startsWith(href);
  }

  async function install() {
    if (!update || installing) return;
    installing = true;
    try {
      await installUpdate(update, (downloaded, total) => {
        progressPct = total ? Math.round((downloaded / total) * 100) : null;
      });
      // On success the app relaunches; this line is effectively unreachable.
    } catch (err) {
      installing = false;
      progressPct = null;
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function dismiss() {
    if (update) await dismissVersion(update.version);
    update = null;
  }

  onMount(async () => {
    initTheme();
    version = await getVersion();
    const info = await checkForUpdate();
    if (info && !(await isVersionDismissed(info.version))) update = info;
  });
</script>

<div class="titlebar" data-tauri-drag-region></div>

{#if update}
  <div class="update-bar">
    {#if installing}
      <span>
        Installing Clarity v{update.version}…{progressPct != null ? ` ${progressPct}%` : ""}
        The app will restart automatically.
      </span>
    {:else}
      <span>Clarity v{update.version} is available.</span>
      <button class="update-dl" onclick={install}>
        <Download size={14} /> Install &amp; Restart
      </button>
      {#if update.notes}
        <button class="update-notes-toggle" onclick={() => (notesOpen = !notesOpen)}>
          What's new
          <span class="update-chev" class:open={notesOpen}><ChevronDown size={13} /></span>
        </button>
      {/if}
      <button class="update-x" onclick={dismiss} aria-label="Dismiss"><X size={14} /></button>
    {/if}
    {#if notesOpen && !installing && notesHtml}
      <div class="update-notes markdown">{@html notesHtml}</div>
    {/if}
  </div>
{/if}


<!-- --sidebar-w lets fixed overlays (e.g. the research view) respect the nav rail. -->
<div class="app" style:--sidebar-w={collapsed ? "64px" : "220px"}>
  <nav class="sidebar" class:collapsed>
    <a class="brand" href="/" title="Clarity — Library">
      <span class="logo"><Video size={18} /></span>
      <span class="brand-text"><strong>Clarity</strong><br />Make It Make Sense</span>
    </a>

    <div class="mode-cards">
      <button
        class="mode-card"
        class:on={mode === "library"}
        onclick={() => setMode("library")}
        title="Library mode"
      >
        <Library size={15} /> <span class="mode-label">Library</span>
      </button>
      <button
        class="mode-card"
        class:on={mode === "browse"}
        onclick={() => setMode("browse")}
        title="Browse mode"
      >
        <Globe size={15} /> <span class="mode-label">Browse</span>
      </button>
    </div>

    {#if mode === "library"}
      <div class="links">
        {#each links as l (l.href)}
          {@const Icon = l.icon}
          <a
            href={l.href}
            class:active={isActive(l.href, $page.url.pathname)}
            title={l.label}
          >
            <Icon size={17} />
            <span class="link-label">{l.label}</span>
          </a>
        {/each}
      </div>
    {:else}
      <LinkTree {collapsed} />
    {/if}

    <div class="bottom-row">
      <button class="icon-btn" onclick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
        {#if $theme === "dark"}
          <Sun size={16} />
        {:else}
          <Moon size={16} />
        {/if}
      </button>
      <button
        class="icon-btn"
        onclick={toggleCollapsed}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {#if collapsed}
          <PanelLeftOpen size={16} />
        {:else}
          <PanelLeftClose size={16} />
        {/if}
      </button>
      {#if version && !collapsed}
        <a class="version-link" href="/settings" title="About & updates">v{version}</a>
      {/if}
    </div>
  </nav>

  <main class="content">
    {@render children()}
  </main>
</div>

<Toaster />

<style>
  :global(:root) {
    /* Defaults for the instant before initTheme() sets data-theme. */
    --accent: #6d5efc;
    --accent-hover: #5b4cf0;
    --radius: 12px;
    --radius-sm: 8px;
    --font: "Inter", -apple-system, system-ui, sans-serif;
    /* Sidebar rail defaults (dark) for the instant before initTheme(). */
    --sidebar-bg: #131318;
    --sidebar-text: #b3b3c0;
    --sidebar-text-dim: #b9b9c6;
    --sidebar-text-bright: #ffffff;
    --sidebar-hover: rgba(255, 255, 255, 0.06);
    --sidebar-active: rgba(255, 255, 255, 0.1);
    --sidebar-border: rgba(255, 255, 255, 0.08);
    --sidebar-edge: rgba(255, 255, 255, 0.05);
  }
  :global(html[data-theme="light"]) {
    --accent: #6d5efc;
    --accent-hover: #5b4cf0;
    --ok: #148549;
    --danger: #d93840;
    --warn: #a96400;
    --bg: #f4f4f7;
    --surface: #ffffff;
    --surface-2: #ffffff;
    --text: #1a1a1f;
    --text-dim: #62626e;
    --border: #e4e4ea;
    --hover: #f0f0f3;
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.07);
    --shadow-lg: 0 10px 30px rgba(0, 0, 0, 0.12);
    /* Light rail: slightly darker than --bg so it still reads as chrome. */
    --sidebar-bg: #eaeaef;
    --sidebar-text: #4a4a56;
    --sidebar-text-dim: #6a6a76;
    --sidebar-text-bright: #1a1a1f;
    --sidebar-hover: rgba(0, 0, 0, 0.05);
    --sidebar-active: rgba(0, 0, 0, 0.08);
    --sidebar-border: rgba(0, 0, 0, 0.1);
    --sidebar-edge: rgba(0, 0, 0, 0.07);
  }
  :global(html[data-theme="dark"]) {
    /* Lighter accent in dark mode: #6d5efc as text on dark surfaces falls
       under 4.5:1, so links/labels get a brighter tint while buttons keep
       enough weight against white label text. */
    --accent: #8a7dff;
    --accent-hover: #9c91ff;
    --ok: #34c374;
    --danger: #f2555a;
    --warn: #e8a33d;
    --bg: #0c0c10;
    --surface: #15151b;
    --surface-2: #1c1c24;
    --text: #ececf1;
    --text-dim: #a6a6b2;
    --border: #262630;
    --hover: #22222c;
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
    --shadow-lg: 0 12px 36px rgba(0, 0, 0, 0.55);
    --sidebar-bg: #131318;
    --sidebar-text: #b3b3c0;
    --sidebar-text-dim: #b9b9c6;
    --sidebar-text-bright: #ffffff;
    --sidebar-hover: rgba(255, 255, 255, 0.06);
    --sidebar-active: rgba(255, 255, 255, 0.1);
    --sidebar-border: rgba(255, 255, 255, 0.08);
    --sidebar-edge: rgba(255, 255, 255, 0.05);
  }
  :global(body) {
    margin: 0;
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    transition: background-color 0.2s ease, color 0.2s ease;
  }
  :global(*) { box-sizing: border-box; }
  /* Keyboard users get a consistent, visible focus ring everywhere. */
  :global(:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  :global(:root) { --titlebar-h: 38px; --panel-head-h: 52px; }
  /* Real (but minimal) window chrome: a draggable strip matching the
     sidebar rail. Everything below starts at --titlebar-h, so no surface
     needs its own "clear the titlebar" padding anymore. */
  .titlebar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: var(--titlebar-h);
    z-index: 900;
    background: var(--sidebar-bg);
    border-bottom: 1px solid var(--sidebar-edge);
    -webkit-app-region: drag;
    app-region: drag;
  }

  .update-bar {
    position: sticky;
    /* Sits below the titlebar chrome. */
    top: var(--titlebar-h);
    margin-top: var(--titlebar-h);
    z-index: 800;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    padding: 0.55rem 1rem 0.55rem 1.25rem;
    background: var(--accent);
    color: #fff;
    font-size: 0.85rem;
  }
  .update-dl {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    border: none;
    background: rgba(255, 255, 255, 0.18);
    color: #fff;
    padding: 0.3rem 0.6rem;
    border-radius: 6px;
    font-size: 0.82rem;
    font-family: inherit;
    cursor: pointer;
  }
  .update-dl:hover { background: rgba(255, 255, 255, 0.3); }
  .update-x {
    margin-left: auto;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: #fff;
    cursor: pointer;
    opacity: 0.8;
    padding: 0.2rem;
    border-radius: 5px;
  }
  .update-x:hover { opacity: 1; background: rgba(255, 255, 255, 0.18); }
  .update-notes-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    border: none;
    background: transparent;
    color: #fff;
    opacity: 0.85;
    padding: 0.3rem 0.4rem;
    border-radius: 6px;
    font-size: 0.82rem;
    font-family: inherit;
    cursor: pointer;
  }
  .update-notes-toggle:hover { opacity: 1; background: rgba(255, 255, 255, 0.14); }
  .update-chev { display: inline-flex; transition: transform 0.15s; }
  .update-chev.open { transform: rotate(180deg); }
  .update-notes {
    flex-basis: 100%;
    max-height: 220px;
    overflow-y: auto;
    background: rgba(0, 0, 0, 0.18);
    border-radius: var(--radius-sm);
    padding: 0.6rem 0.85rem;
    font-size: 0.82rem;
    line-height: 1.55;
  }
  .update-notes :global(h1),
  .update-notes :global(h2),
  .update-notes :global(h3) { margin: 0.4rem 0 0.2rem; font-size: 0.88rem; }
  .update-notes :global(p) { margin: 0.25rem 0; }
  .update-notes :global(ul) { margin: 0.25rem 0; padding-left: 1.2rem; }
  .update-notes :global(li) { margin: 0.15rem 0; }
  .update-notes :global(code) {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.74rem;
    background: rgba(0, 0, 0, 0.25);
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
  }

  .app {
    display: flex;
    align-items: flex-start;
    min-height: calc(100vh - var(--titlebar-h));
    margin-top: var(--titlebar-h);
  }
  .sidebar {
    width: 220px;
    flex-shrink: 0;
    background: var(--sidebar-bg);
    color: var(--sidebar-text);
    padding: 0.9rem 0.9rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    border-right: 1px solid var(--sidebar-edge);
    /* Pin the nav so it stays put while the page content scrolls. */
    position: sticky;
    top: var(--titlebar-h);
    height: calc(100vh - var(--titlebar-h));
    overflow: hidden;
    transition: width 0.2s ease, padding 0.2s ease;
  }
  .sidebar.collapsed {
    width: 64px;
    padding-left: 0.7rem;
    padding-right: 0.7rem;
  }
  .sidebar.collapsed .brand-text,
  .sidebar.collapsed .link-label { display: none; }
  .sidebar.collapsed .brand { justify-content: center; padding-left: 0; padding-right: 0; }
  .sidebar.collapsed .links a { justify-content: center; padding-left: 0; padding-right: 0; }
  .sidebar.collapsed .bottom-row { flex-direction: column; align-items: center; }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.2rem 0.4rem 1.1rem;
    color: inherit;
    text-decoration: none;
    text-align: left;
    width: 100%;
  }
  .brand:hover .logo { filter: brightness(1.1); }
  .logo {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: linear-gradient(135deg, var(--accent), #9b7bff);
    color: #fff;
    flex-shrink: 0;
  }
  .brand-text { font-size: 0.82rem; line-height: 1.2; color: var(--sidebar-text-dim); white-space: nowrap; }
  .brand-text strong { color: var(--sidebar-text-bright); font-size: 0.95rem; }

  .mode-cards {
    display: flex;
    gap: 0.35rem;
    padding-bottom: 0.6rem;
    margin-bottom: 0.55rem;
    border-bottom: 1px solid var(--sidebar-border);
  }
  /* Collapsed rail: same spot, vertical stack of icon-only mode buttons. */
  .sidebar.collapsed .mode-cards { flex-direction: column; align-items: center; }
  .sidebar.collapsed .mode-label { display: none; }
  .sidebar.collapsed .mode-card { flex: none; width: 34px; height: 34px; padding: 0; }
  .mode-card {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    border: 1px solid var(--sidebar-border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--sidebar-text);
    font-size: 0.8rem;
    font-family: inherit;
    cursor: pointer;
    padding: 0.42rem 0.3rem;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .mode-card:hover { background: var(--sidebar-hover); color: var(--sidebar-text-bright); }
  .mode-card.on {
    background: rgba(109, 94, 252, 0.16);
    border-color: color-mix(in srgb, var(--accent) 45%, var(--sidebar-border));
    color: var(--sidebar-text-bright);
  }

  .links { display: flex; flex-direction: column; gap: 0.2rem; }
  .links a {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    color: var(--sidebar-text);
    text-decoration: none;
    padding: 0.55rem 0.7rem;
    border-radius: var(--radius-sm);
    font-size: 0.92rem;
    position: relative;
    transition: background 0.15s, color 0.15s;
  }
  .links a:hover { background: var(--sidebar-hover); color: var(--sidebar-text-bright); }
  .links a.active { background: rgba(109, 94, 252, 0.16); color: var(--sidebar-text-bright); }
  .links a.active::before {
    content: "";
    position: absolute;
    left: -0.9rem;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 60%;
    border-radius: 0 3px 3px 0;
    background: var(--accent);
  }

  .bottom-row { margin-top: auto; display: flex; align-items: center; gap: 0.4rem; }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border: 1px solid var(--sidebar-border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--sidebar-text);
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s, color 0.15s;
  }
  .icon-btn:hover { background: var(--sidebar-hover); color: var(--sidebar-text-bright); }
  .version-link {
    margin-left: auto;
    color: var(--sidebar-text);
    text-decoration: none;
    font-size: 0.72rem;
    font-family: "JetBrains Mono", monospace;
    opacity: 0.7;
    padding: 0.2rem 0.3rem;
    border-radius: 5px;
  }
  .version-link:hover { opacity: 1; color: var(--sidebar-text-bright); }

  .content { flex: 1; min-width: 0; padding: 1.5rem 2.25rem 2rem; }
</style>
