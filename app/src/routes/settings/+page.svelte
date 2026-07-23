<script lang="ts">
  import { onMount } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import {
    KeyRound, MessageSquareText, ImageIcon, Save, RotateCcw, RefreshCw,
    GitBranch, DollarSign, Trash2, Wrench, Globe, Settings2,
    Sparkles, Link2, ChevronDown,
  } from "lucide-svelte";
  import { invoke } from "@tauri-apps/api/core";
  import {
    loadApiKey, saveApiKey, loadPrompt, savePrompt,
    loadDiagramPrompt, saveDiagramPrompt,
    loadGitHubToken, saveGitHubToken,
    loadMaxToolTurns, saveMaxToolTurns, DEFAULT_MAX_TOOL_TURNS,
    browseEnabled, saveBrowseEnabled,
  } from "$lib/settings";
  import { DEFAULT_PROMPT, DEFAULT_DIAGRAM_PROMPT } from "$lib/gemini";
  import { loadSpend, resetSpend, type SpendInfo } from "$lib/spend";
  import { checkForUpdate, installUpdate } from "$lib/updates";
  import { toast } from "$lib/toast";

  type Tab = "general" | "ai" | "connections" | "browser";
  const tabs: { id: Tab; label: string; icon: typeof Settings2 }[] = [
    { id: "general", label: "General", icon: Settings2 },
    { id: "ai", label: "AI", icon: Sparkles },
    { id: "connections", label: "Connections", icon: Link2 },
    { id: "browser", label: "Browser", icon: Globe },
  ];
  let activeTab = $state<Tab>("general");

  let apiKey = $state("");
  let githubToken = $state("");
  let prompt = $state(DEFAULT_PROMPT);
  let diagramPrompt = $state(DEFAULT_DIAGRAM_PROMPT);
  let version = $state("");
  let checking = $state(false);
  let spend = $state<SpendInfo>({ totalUsd: 0, since: null });
  let maxToolTurns = $state(DEFAULT_MAX_TOOL_TURNS);
  let confirmClear = $state(false);
  let clearing = $state(false);
  let summaryPromptOpen = $state(true);
  let diagramPromptOpen = $state(true);

  onMount(async () => {
    apiKey = await loadApiKey();
    githubToken = await loadGitHubToken();
    prompt = await loadPrompt();
    diagramPrompt = await loadDiagramPrompt();
    version = await getVersion();
    spend = await loadSpend();
    maxToolTurns = await loadMaxToolTurns();
  });

  async function handleSaveMaxToolTurns() {
    maxToolTurns = Math.max(1, Math.min(25, Math.round(maxToolTurns) || DEFAULT_MAX_TOOL_TURNS));
    await saveMaxToolTurns(maxToolTurns);
    toast.success("Tool call limit saved.");
  }

  async function handleResetSpend() {
    await resetSpend();
    spend = await loadSpend();
    toast.success("Spend tracker reset.");
  }

  function fmtSpend(usd: number): string {
    return usd < 0.01 && usd > 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  }

  async function handleCheckUpdates() {
    checking = true;
    try {
      const info = await checkForUpdate();
      if (info) {
        toast.success(`Clarity v${info.version} found — installing…`);
        await installUpdate(info);
        // On success the app downloads, installs, and relaunches itself.
      } else {
        toast.info("You're on the latest version.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      checking = false;
    }
  }

  async function handleSaveKey() {
    await saveApiKey(apiKey.trim());
    toast.success("API key saved.");
  }
  async function handleSaveGitHubToken() {
    await saveGitHubToken(githubToken.trim());
    toast.success("GitHub token saved.");
  }
  async function handleSavePrompt() {
    await savePrompt(prompt);
    toast.success("Prompt saved.");
  }
  function handleReset() {
    prompt = DEFAULT_PROMPT;
    toast.info("Prompt reset to default (not yet saved).");
  }
  async function handleToggleBrowse() {
    const enabled = !$browseEnabled;
    await saveBrowseEnabled(enabled);
    toast.success(enabled ? "Browse mode enabled." : "Browse mode disabled.");
  }
  async function handleClearBrowsingData() {
    if (!confirmClear) {
      confirmClear = true;
      return;
    }
    confirmClear = false;
    clearing = true;
    try {
      await invoke("clear_browsing_data");
      toast.success("Browsing data cleared — you've been signed out of all sites.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      clearing = false;
    }
  }
  async function handleSaveDiagramPrompt() {
    await saveDiagramPrompt(diagramPrompt);
    toast.success("Diagram prompt saved.");
  }
  function handleResetDiagramPrompt() {
    diagramPrompt = DEFAULT_DIAGRAM_PROMPT;
    toast.info("Diagram prompt reset to default (not yet saved).");
  }
</script>

<header class="page-head">
  <div>
    <h1>Settings</h1>
  </div>
</header>

<div class="tab-bar" role="tablist">
  {#each tabs as t (t.id)}
    {@const Icon = t.icon}
    <button
      class="tab"
      class:on={activeTab === t.id}
      role="tab"
      aria-selected={activeTab === t.id}
      onclick={() => (activeTab = t.id)}
    >
      <Icon size={15} /> {t.label}
    </button>
  {/each}
</div>

{#if activeTab === "general"}
  <section class="card">
    <div class="card-head"><RefreshCw size={17} /><h2>About &amp; Updates</h2></div>
    <div class="row">
      <span class="version">Clarity{version ? ` v${version}` : ""}</span>
      <button class="btn" onclick={handleCheckUpdates} disabled={checking}>
        <RefreshCw size={14} /> {checking ? "Checking…" : "Check for updates"}
      </button>
    </div>
    <p class="hint">Checks GitHub for new signed releases. If one is found, it's downloaded, verified, installed, and the app restarts automatically.</p>
  </section>
{/if}

{#if activeTab === "ai"}
  <section class="card">
    <div class="card-head">
      <KeyRound size={17} /><h2>Gemini API Key</h2>
      <span class="spend-inline mono" title={spend.since ? `Since ${new Date(spend.since).toLocaleDateString()}` : ""}>
        <DollarSign size={13} /> {fmtSpend(spend.totalUsd)} spent
      </span>
      <button
        class="spend-reset"
        onclick={handleResetSpend}
        disabled={spend.totalUsd === 0}
        title="Reset spend tracker"
        aria-label="Reset spend tracker"
      >
        <Trash2 size={13} />
      </button>
    </div>
    <div class="row">
      <input
        type="password"
        placeholder="Paste your Gemini API key"
        bind:value={apiKey}
      />
      <button class="btn primary" onclick={handleSaveKey} disabled={!apiKey.trim()}>
        <Save size={15} /> Save
      </button>
    </div>
    <p class="hint">Stored locally via plugin-store. Never bundled or committed.</p>
    <div class="row sub-row">
      <span class="sub-label"><Wrench size={14} /> Repo chat tool limit</span>
      <input class="num" type="number" min="1" max="25" bind:value={maxToolTurns} />
      <button class="btn" onclick={handleSaveMaxToolTurns}><Save size={14} /> Save</button>
    </div>
    <p class="hint">
      Max research rounds (file reads, diffs, searches) per repo-chat question.
      Higher digs deeper but costs more. Default {DEFAULT_MAX_TOOL_TURNS}. The
      spend total above tracks all estimated Gemini costs — even for replaced or
      deleted work.
    </p>
  </section>

  <section class="card">
    <button class="collapse-head" onclick={() => (summaryPromptOpen = !summaryPromptOpen)} aria-expanded={summaryPromptOpen}>
      <MessageSquareText size={17} /><h2>Default Summary Prompt</h2>
      <span class="chev" class:open={summaryPromptOpen}><ChevronDown size={16} /></span>
    </button>
    {#if summaryPromptOpen}
      <textarea rows="7" bind:value={prompt}></textarea>
      <div class="row end">
        <button class="btn" onclick={handleReset}><RotateCcw size={14} /> Reset</button>
        <button class="btn primary" onclick={handleSavePrompt}><Save size={15} /> Save prompt</button>
      </div>
    {/if}
  </section>

  <section class="card">
    <button class="collapse-head" onclick={() => (diagramPromptOpen = !diagramPromptOpen)} aria-expanded={diagramPromptOpen}>
      <ImageIcon size={17} /><h2>Diagram Prompt</h2>
      <span class="chev" class:open={diagramPromptOpen}><ChevronDown size={16} /></span>
    </button>
    {#if diagramPromptOpen}
      <textarea rows="9" bind:value={diagramPrompt}></textarea>
      <div class="row end">
        <button class="btn" onclick={handleResetDiagramPrompt}><RotateCcw size={14} /> Reset</button>
        <button class="btn primary" onclick={handleSaveDiagramPrompt}><Save size={15} /> Save prompt</button>
      </div>
      <p class="hint">Controls the conceptual learning diagram. Designed to avoid recreating screenshots or OS chrome (docks, menu bars) — those belong in Highlights. The model may still reference the video to match a demonstrated UI component's aesthetic.</p>
    {/if}
  </section>
{/if}

{#if activeTab === "connections"}
  <section class="card">
    <div class="card-head">
      <GitBranch size={17} /><h2>GitHub Token</h2>
    </div>
    <div class="row">
      <input
        type="password"
        placeholder="Personal access token (optional)"
        bind:value={githubToken}
      />
      <button class="btn primary" onclick={handleSaveGitHubToken}>
        <Save size={15} /> Save
      </button>
    </div>
    <p class="hint">
      Optional for public repos; required for private repos and higher rate
      limits. A fine-grained token with read-only Contents access is enough.
    </p>
    <div class="info-pop token-help">
      <p><strong>Two ways to get a token:</strong></p>
      <p>
        <strong>1. GitHub CLI (fastest).</strong> If you use <code>gh</code>, run
        <code>gh auth token</code> in a terminal and paste the result here. It reuses
        your existing login (dies if you <code>gh auth logout</code>).
      </p>
      <p>
        <strong>2. Fine-grained PAT (web).</strong> Go to
        <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
          github.com/settings/personal-access-tokens/new</a>, pick the repos to track, and
        grant read-only <em>Contents</em> and <em>Metadata</em> permissions.
      </p>
    </div>
  </section>
{/if}

{#if activeTab === "browser"}
  <section class="card">
    <div class="card-head"><Globe size={17} /><h2>Browse Mode</h2></div>
    <div class="row">
      <span class="version">Browse mode (beta)</span>
      <button class="btn" class:primary={!$browseEnabled} onclick={handleToggleBrowse}>
        {$browseEnabled ? "Disable" : "Enable"}
      </button>
    </div>
    <p class="hint">
      Adds a Browse mode to the sidebar: a curated link tree with persistent,
      signed-in browser tabs and an AI that can read the page you're on.
      Opt-in while in beta — disabling it hides the feature without deleting
      your links or sessions.
    </p>
  </section>

  <section class="card">
    <div class="card-head"><Trash2 size={17} /><h2>Sessions &amp; Site Data</h2></div>
    <div class="row">
      <span class="version">Browse-mode sessions &amp; site data</span>
      <button class="btn" onclick={() => invoke("open_devtools")} title="Open the developer console for debugging">
        <Wrench size={14} /> Open console
      </button>
      {#if confirmClear}
        <button class="btn" onclick={() => (confirmClear = false)}>Cancel</button>
      {/if}
      <button class="btn danger" onclick={handleClearBrowsingData} disabled={clearing}>
        <Trash2 size={14} />
        {clearing ? "Clearing…" : confirmClear ? "Confirm clear" : "Clear browsing data"}
      </button>
    </div>
    <p class="hint">
      Signs you out of every site by deleting cookies, site storage, and caches
      used by browse tabs and the research view. Open tabs reload from scratch.
      App settings, your library, and API keys are not affected.
    </p>
  </section>
{/if}

<style>

  .page-head { margin-bottom: 1rem; }
  h1 { font-size: 1.5rem; margin: 0; letter-spacing: -0.01em; }
  h2 { font-size: 1rem; margin: 0; }

  .tab-bar {
    display: flex;
    gap: 0.35rem;
    margin-bottom: 1.1rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-size: 0.9rem;
    font-family: inherit;
    cursor: pointer;
    padding: 0.55rem 0.85rem;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: color 0.15s, border-color 0.15s;
  }
  .tab:hover { color: var(--text); }
  .tab.on { color: var(--accent); border-bottom-color: var(--accent); }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.1rem 1.25rem;
    margin-bottom: 1rem;
    box-shadow: var(--shadow);
  }
  .card-head { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.8rem; }
  .card-head :global(svg) { color: var(--accent); }

  .collapse-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    border: none;
    background: transparent;
    color: var(--text);
    font-family: inherit;
    cursor: pointer;
    padding: 0;
    text-align: left;
  }
  .collapse-head :global(svg) { color: var(--accent); }
  .collapse-head + textarea { margin-top: 0.8rem; }
  .chev { margin-left: auto; display: inline-flex; transition: transform 0.15s; }
  .chev.open { transform: rotate(180deg); }
  .chev :global(svg) { color: var(--text-dim); }

  .row { display: flex; align-items: center; gap: 0.6rem; }
  .row.end { justify-content: flex-end; margin-top: 0.8rem; }

  input, textarea {
    flex: 1;
    width: 100%;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    font-size: 0.92rem;
    font-family: inherit;
    transition: border-color 0.15s;
  }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  textarea { resize: vertical; line-height: 1.55; }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.55rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    font-size: 0.9rem;
    font-family: inherit;
    white-space: nowrap;
    transition: background 0.15s, transform 0.1s;
  }
  .btn:hover:not(:disabled) { background: var(--hover); }
  .btn:active:not(:disabled) { transform: translateY(1px); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn.danger { color: #e5484d; border-color: color-mix(in srgb, #e5484d 40%, var(--border)); }
  .btn.danger:hover:not(:disabled) { background: color-mix(in srgb, #e5484d 10%, var(--surface)); }

  .hint { font-size: 0.82rem; color: var(--text-dim); margin: 0.6rem 0 0; }

  .info-pop {
    border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
    background: color-mix(in srgb, var(--accent) 5%, var(--bg));
    border-radius: var(--radius-sm);
    padding: 0.7rem 0.85rem;
    margin-bottom: 0.8rem;
    font-size: 0.82rem;
    line-height: 1.55;
    color: var(--text-dim);
  }
  .info-pop p { margin: 0 0 0.5rem; }
  .info-pop p:last-child { margin-bottom: 0; }
  .info-pop strong { color: var(--text); }
  .info-pop code {
    background: var(--hover);
    padding: 0.08rem 0.3rem;
    border-radius: 4px;
    font-size: 0.9em;
    font-family: "JetBrains Mono", monospace;
  }
  .info-pop a { color: var(--accent); }
  .token-help { margin-top: 0.8rem; margin-bottom: 0; }
  .version { font-size: 0.92rem; font-weight: 500; flex: 1; }

  input.num { flex: 0 0 80px; width: 80px; }
  .mono { font-family: "JetBrains Mono", monospace; }

  .spend-inline {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.8rem;
    color: var(--text-dim);
    padding: 0.18rem 0.55rem;
    border-radius: 999px;
    background: var(--hover);
  }
  .spend-inline :global(svg) { color: var(--text-dim); }
  .spend-reset {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
  }
  .spend-reset:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
  }
  .spend-reset:disabled { opacity: 0.35; cursor: not-allowed; }

  .sub-row {
    margin-top: 0.9rem;
    padding-top: 0.9rem;
    border-top: 1px solid var(--border);
  }
  .sub-label {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.86rem;
    color: var(--text-dim);
    flex: 1;
  }
  .sub-label :global(svg) { color: var(--accent); }
</style>
