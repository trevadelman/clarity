<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { Library, Plus, Settings, Moon, Sun, Video, Download, X } from "lucide-svelte";
  import { theme, toggleTheme, initTheme } from "$lib/theme";
  import { checkForUpdate, isVersionDismissed, dismissVersion, type UpdateInfo } from "$lib/updates";
  import Toaster from "$lib/Toaster.svelte";

  let { children } = $props();

  const links = [
    { href: "/", label: "Library", icon: Library },
    { href: "/add", label: "Add video", icon: Plus },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  let update = $state<UpdateInfo | null>(null);
  let collapsed = $state(true);

  function isActive(href: string, path: string): boolean {
    return href === "/" ? path === "/" : path.startsWith(href);
  }

  async function dismiss() {
    if (update) await dismissVersion(update.version);
    update = null;
  }

  onMount(async () => {
    initTheme();
    const info = await checkForUpdate();
    if (info && !(await isVersionDismissed(info.version))) update = info;
  });
</script>

<div class="titlebar" data-tauri-drag-region></div>

{#if update}
  <div class="update-bar">
    <span>Clarity v{update.version} is available.</span>
    <button class="update-dl" onclick={() => openUrl(update!.htmlUrl)}>
      <Download size={14} /> Download
    </button>
    <code>xattr -dr com.apple.quarantine /Applications/Clarity.app</code>
    <button class="update-x" onclick={dismiss} aria-label="Dismiss"><X size={14} /></button>
  </div>
{/if}


<div class="app">
  <nav class="sidebar" class:collapsed>
    <button class="brand" onclick={() => (collapsed = !collapsed)} title="Toggle sidebar">
      <span class="logo"><Video size={18} /></span>
      <span class="brand-text"><strong>Clarity</strong><br />Video summaries</span>
    </button>

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

    <div class="bottom-row">
      <button class="icon-btn" onclick={toggleTheme} aria-label="Toggle theme">
        {#if $theme === "dark"}
          <Sun size={16} />
        {:else}
          <Moon size={16} />
        {/if}
      </button>
    </div>
  </nav>

  <main class="content">
    {@render children()}
  </main>
</div>

<Toaster />

<style>
  :global(:root) {
    --accent: #6d5efc;
    --accent-hover: #5b4cf0;
    --ok: #18a957;
    --danger: #e5484d;
    --warn: #d98818;
    --radius: 12px;
    --radius-sm: 8px;
    --font: "Inter", -apple-system, system-ui, sans-serif;
  }
  :global(html[data-theme="light"]) {
    --bg: #f4f4f7;
    --surface: #ffffff;
    --surface-2: #ffffff;
    --text: #1a1a1f;
    --text-dim: #6b6b76;
    --border: #e4e4ea;
    --hover: #f0f0f3;
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.07);
    --shadow-lg: 0 10px 30px rgba(0, 0, 0, 0.12);
    --sidebar-bg: #16161c;
  }
  :global(html[data-theme="dark"]) {
    --bg: #0c0c10;
    --surface: #15151b;
    --surface-2: #1c1c24;
    --text: #ececf1;
    --text-dim: #9b9ba6;
    --border: #262630;
    --hover: #22222c;
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
    --shadow-lg: 0 12px 36px rgba(0, 0, 0, 0.55);
    --sidebar-bg: #101015;
  }
  :global(body) {
    margin: 0;
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
  }
  :global(*) { box-sizing: border-box; }

  /* Transparent draggable strip overlaying the top so content can bleed
     beneath the (hidden) titlebar while the window stays movable. */
  .titlebar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 32px;
    z-index: 900;
    -webkit-app-region: drag;
    app-region: drag;
  }

  .update-bar {
    position: sticky;
    top: 0;
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
  .update-bar code {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.72rem;
    background: rgba(0, 0, 0, 0.22);
    padding: 0.15rem 0.4rem;
    border-radius: 5px;
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

  .app { display: flex; align-items: flex-start; min-height: 100vh; }
  .sidebar {
    width: 210px;
    flex-shrink: 0;
    background: var(--sidebar-bg);
    color: #e6e6ee;
    padding: 2.5rem 0.9rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    border-right: 1px solid rgba(255, 255, 255, 0.05);
    /* Pin the nav so it stays put while the page content scrolls. */
    position: sticky;
    top: 0;
    height: 100vh;
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
  .sidebar.collapsed a { justify-content: center; padding-left: 0; padding-right: 0; }
  .sidebar.collapsed .bottom-row { flex-direction: column; }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.2rem 0.4rem 1.1rem;
    border: none;
    background: transparent;
    color: inherit;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
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
  .brand-text { font-size: 0.82rem; line-height: 1.2; color: #b9b9c6; }
  .brand-text strong { color: #fff; font-size: 0.95rem; }

  .links { display: flex; flex-direction: column; gap: 0.2rem; }
  .sidebar a {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    color: #b3b3c0;
    text-decoration: none;
    padding: 0.55rem 0.7rem;
    border-radius: var(--radius-sm);
    font-size: 0.92rem;
    position: relative;
    transition: background 0.15s, color 0.15s;
  }
  .sidebar a:hover { background: rgba(255, 255, 255, 0.06); color: #fff; }
  .sidebar a.active { background: rgba(109, 94, 252, 0.16); color: #fff; }
  .sidebar a.active::before {
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

  .bottom-row { margin-top: auto; display: flex; gap: 0.4rem; }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: var(--radius-sm);
    background: transparent;
    color: #b3b3c0;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s, color 0.15s;
  }
  .icon-btn:hover { background: rgba(255, 255, 255, 0.06); color: #fff; }

  .content { flex: 1; min-width: 0; padding: 2.75rem 2.25rem 2rem; }
</style>
