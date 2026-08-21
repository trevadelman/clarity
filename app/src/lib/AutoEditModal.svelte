<script module lang="ts">
  /** What the modal hands back when the user hits Generate. */
  export interface AutoEditSubmit {
    prompt: string;
    sourceIds: string[];
    audioPath: string | null;
    audioMode: "replace" | "mix";
    width: number;
    height: number;
  }
</script>

<script lang="ts">
  import { Check, Clapperboard, Music, X, Video, Film } from "lucide-svelte";
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { basename } from "@tauri-apps/api/path";
  import { DEFAULT_EDIT_PROMPT } from "./gemini";
  import type { VideoRecord } from "./videoLibrary";

  let {
    members,
    onGenerate,
    onClose,
  }: {
    /** All project members; only local-file videos are selectable. */
    members: VideoRecord[];
    onGenerate: (opts: AutoEditSubmit) => void;
    onClose: () => void;
  } = $props();

  const localMembers = $derived(members.filter((m) => !!m.localPath));
  const nonLocalMembers = $derived(members.filter((m) => !m.localPath));

  let prompt = $state(DEFAULT_EDIT_PROMPT);
  let selected = $state<Set<string>>(new Set());
  let audioPath = $state<string | null>(null);
  let audioName = $state("");
  let audioMode = $state<"replace" | "mix">("replace");

  const SIZES = [
    { label: "Landscape · 1920×1080", width: 1920, height: 1080 },
    { label: "Portrait · 1080×1920", width: 1080, height: 1920 },
    { label: "Square · 1080×1080", width: 1080, height: 1080 },
  ];
  let sizeIndex = $state(0);

  // Preselect every eligible source.
  $effect(() => {
    if (selected.size === 0 && localMembers.length > 0) {
      selected = new Set(localMembers.map((m) => m.id));
    }
  });

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  async function pickAudio() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "Audio", extensions: ["mp3", "m4a", "aac", "wav", "aiff"] }],
    });
    if (typeof path === "string") {
      audioPath = path;
      audioName = await basename(path);
    }
  }

  function clearAudio() {
    audioPath = null;
    audioName = "";
  }

  function submit() {
    onGenerate({
      prompt: prompt.trim(),
      sourceIds: [...selected],
      audioPath,
      audioMode,
      width: SIZES[sizeIndex].width,
      height: SIZES[sizeIndex].height,
    });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
<div class="modal-scrim" onclick={onClose}></div>
<div class="modal" role="dialog" aria-label="New auto-edit">
  <h3><Clapperboard size={16} /> New auto-edit</h3>

  <label class="field">
    <span>Instructions</span>
    <textarea rows="5" bind:value={prompt}></textarea>
  </label>

  <div class="sources-field">
    <span class="sources-label">Source videos</span>
    <div class="source-checks">
      {#each localMembers as m (m.id)}
        <label class="source-check">
          <input type="checkbox" checked={selected.has(m.id)} onchange={() => toggle(m.id)} />
          <Video size={14} />
          <span class="source-name">{m.videoName}</span>
        </label>
      {/each}
      {#each nonLocalMembers as m (m.id)}
        <label class="source-check disabled" title="Auto-Edit needs a local video file">
          <input type="checkbox" disabled />
          <Film size={14} />
          <span class="source-name">{m.videoName}</span>
          <span class="note">needs a local file</span>
        </label>
      {/each}
    </div>
    {#if localMembers.length === 0}
      <p class="hint">No local videos in this project — add local or Loom videos first.</p>
    {/if}
  </div>

  <div class="field">
    <span class="sources-label">Music (optional)</span>
    <div class="audio-row">
      {#if audioPath}
        <span class="audio-name mono" title={audioPath}><Music size={13} /> {audioName}</span>
        <button class="icon-btn" onclick={clearAudio} title="Remove audio" aria-label="Remove audio">
          <X size={13} />
        </button>
        <select bind:value={audioMode}>
          <option value="replace">Replace original audio</option>
          <option value="mix">Mix under original audio</option>
        </select>
      {:else}
        <button class="btn" onclick={pickAudio}><Music size={14} /> Choose a track…</button>
      {/if}
    </div>
  </div>

  <label class="field">
    <span>Output size</span>
    <select bind:value={sizeIndex}>
      {#each SIZES as s, i (s.label)}
        <option value={i}>{s.label}</option>
      {/each}
    </select>
  </label>

  <div class="modal-actions">
    <button class="btn" onclick={onClose}>Cancel</button>
    <button
      class="btn primary"
      onclick={submit}
      disabled={!prompt.trim() || selected.size === 0}
    >
      <Check size={14} /> Generate
    </button>
  </div>
</div>

<style>
  .modal-scrim {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, black 45%, transparent);
    z-index: 60;
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(560px, 92vw);
    max-height: 85vh;
    overflow-y: auto;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.2rem 1.3rem;
    z-index: 61;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin: 0;
    font-size: 1.05rem;
  }
  h3 :global(svg) { color: var(--accent); }
  .field { display: flex; flex-direction: column; gap: 0.35rem; }
  .field > span, .sources-label {
    font-size: 0.82rem;
    color: var(--text-dim);
    font-weight: 500;
  }
  textarea, select, .btn {
    font-family: inherit;
    font-size: 0.88rem;
  }
  textarea {
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    resize: vertical;
  }
  select {
    padding: 0.45rem 0.55rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
  }
  .sources-field { display: flex; flex-direction: column; gap: 0.4rem; }
  .source-checks { display: flex; flex-direction: column; gap: 0.25rem; }
  .source-check {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.85rem;
    padding: 0.25rem 0.2rem;
  }
  .source-check :global(svg) { color: var(--accent); flex-shrink: 0; }
  .source-check.disabled { color: var(--text-dim); }
  .source-check.disabled :global(svg) { color: var(--text-dim); }
  .source-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note { font-size: 0.72rem; color: var(--text-dim); font-style: italic; }
  .hint { font-size: 0.8rem; color: var(--text-dim); margin: 0; }
  .audio-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .audio-name {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
  }
  .icon-btn:hover { background: var(--hover); color: var(--text); }
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
  }
  .btn:hover { background: var(--hover); }
  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }
  .btn.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
</style>
