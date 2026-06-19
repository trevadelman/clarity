<script lang="ts">
  import { onMount } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { KeyRound, MessageSquareText, ImageIcon, Save, RotateCcw, Cpu, RefreshCw } from "lucide-svelte";
  import {
    loadApiKey, saveApiKey, loadPrompt, savePrompt,
    loadDiagramPrompt, saveDiagramPrompt, loadModel, saveModel,
  } from "$lib/settings";
  import { DEFAULT_PROMPT, DEFAULT_DIAGRAM_PROMPT, DEFAULT_MODEL, MODELS, type ModelId } from "$lib/gemini";
  import { checkForUpdate } from "$lib/updates";
  import { toast } from "$lib/toast";

  let apiKey = $state("");
  let prompt = $state(DEFAULT_PROMPT);
  let diagramPrompt = $state(DEFAULT_DIAGRAM_PROMPT);
  let model = $state<ModelId>(DEFAULT_MODEL);
  let version = $state("");
  let checking = $state(false);

  const modelList = Object.values(MODELS);

  onMount(async () => {
    apiKey = await loadApiKey();
    prompt = await loadPrompt();
    diagramPrompt = await loadDiagramPrompt();
    model = await loadModel();
    version = await getVersion();
  });

  async function handleCheckUpdates() {
    checking = true;
    try {
      const info = await checkForUpdate();
      if (info) {
        toast.success(`Clarity v${info.version} is available.`);
        await openUrl(info.htmlUrl);
      } else {
        toast.info("You're on the latest version.");
      }
    } finally {
      checking = false;
    }
  }

  async function handleSaveModel(next: ModelId) {
    model = next;
    await saveModel(next);
    toast.success(`Model set to ${MODELS[next].label}.`);
  }

  async function handleSaveKey() {
    await saveApiKey(apiKey.trim());
    toast.success("API key saved.");
  }
  async function handleSavePrompt() {
    await savePrompt(prompt);
    toast.success("Prompt saved.");
  }
  function handleReset() {
    prompt = DEFAULT_PROMPT;
    toast.info("Prompt reset to default (not yet saved).");
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
    <p class="sub">Configure your Gemini connection and summary behavior.</p>
  </div>
</header>

<section class="card">
  <div class="card-head"><KeyRound size={17} /><h2>Gemini API Key</h2></div>
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
</section>

<section class="card">
  <div class="card-head"><Cpu size={17} /><h2>Model</h2></div>
  <div class="models">
    {#each modelList as m (m.id)}
      <button
        class="model"
        class:selected={model === m.id}
        onclick={() => handleSaveModel(m.id)}
      >
        <span class="model-name">{m.label}</span>
        <span class="model-price">${m.inputPerM}/M in · ${m.outputPerM}/M out</span>
      </button>
    {/each}
  </div>
  <p class="hint">Flash is fast and cheap; Pro is higher quality at higher cost. Cost is estimated per summary.</p>
</section>

<section class="card">
  <div class="card-head"><MessageSquareText size={17} /><h2>Default Summary Prompt</h2></div>
  <textarea rows="7" bind:value={prompt}></textarea>
  <div class="row end">
    <button class="btn" onclick={handleReset}><RotateCcw size={14} /> Reset</button>
    <button class="btn primary" onclick={handleSavePrompt}><Save size={15} /> Save prompt</button>
  </div>
</section>

<section class="card">
  <div class="card-head"><ImageIcon size={17} /><h2>Diagram Prompt</h2></div>
  <textarea rows="9" bind:value={diagramPrompt}></textarea>
  <div class="row end">
    <button class="btn" onclick={handleResetDiagramPrompt}><RotateCcw size={14} /> Reset</button>
    <button class="btn primary" onclick={handleSaveDiagramPrompt}><Save size={15} /> Save prompt</button>
  </div>
  <p class="hint">Controls the conceptual learning diagram. Designed to avoid recreating screenshots or OS chrome (docks, menu bars) — those belong in Highlights. The model may still reference the video to match a demonstrated UI component's aesthetic.</p>
</section>

<section class="card">
  <div class="card-head"><RefreshCw size={17} /><h2>About &amp; Updates</h2></div>
  <div class="row">
    <span class="version">Clarity{version ? ` v${version}` : ""}</span>
    <button class="btn" onclick={handleCheckUpdates} disabled={checking}>
      <RefreshCw size={14} /> {checking ? "Checking…" : "Check for updates"}
    </button>
  </div>
  <p class="hint">Checks GitHub for new releases. Updates are installed manually by downloading the latest build.</p>
</section>

<style>

  .page-head { margin-bottom: 1.25rem; }
  h1 { font-size: 1.5rem; margin: 0; letter-spacing: -0.01em; }
  h2 { font-size: 1rem; margin: 0; }
  .sub { color: var(--text-dim); font-size: 0.9rem; margin: 0.2rem 0 0; }

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

  .hint { font-size: 0.82rem; color: var(--text-dim); margin: 0.6rem 0 0; }
  .version { font-size: 0.92rem; font-weight: 500; flex: 1; }


  .models { display: flex; gap: 0.6rem; flex-wrap: wrap; }
  .model {
    flex: 1;
    min-width: 180px;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    align-items: flex-start;
    padding: 0.75rem 0.9rem;
    border: 1.5px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    cursor: pointer;
    font-family: inherit;
    text-align: left;
    transition: border-color 0.15s, background 0.15s;
  }
  .model:hover { background: var(--hover); }
  .model.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .model-name { font-size: 0.95rem; font-weight: 600; }
  .model-price { font-size: 0.78rem; color: var(--text-dim); font-family: "JetBrains Mono", monospace; }
</style>
