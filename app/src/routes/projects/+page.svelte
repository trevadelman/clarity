<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { FolderKanban, Plus, Trash2, FileText, Layers } from "lucide-svelte";
  import {
    listProjects, createProject, deleteProject, type Project,
  } from "$lib/projects";
  import { toast } from "$lib/toast";

  let projects = $state<Project[]>([]);
  let creating = $state(false);
  let newName = $state("");
  let confirmDeleteId = $state<string | null>(null);
  let nameInput = $state<HTMLInputElement | null>(null);

  onMount(refresh);

  async function refresh() {
    projects = await listProjects();
  }

  function startCreate() {
    creating = true;
    newName = "";
    queueMicrotask(() => nameInput?.focus());
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const project = await createProject(name);
    creating = false;
    goto(`/projects/${project.id}`);
  }

  async function handleDelete(project: Project) {
    if (confirmDeleteId !== project.id) {
      confirmDeleteId = project.id;
      return;
    }
    confirmDeleteId = null;
    await deleteProject(project.id);
    await refresh();
    toast.success(`Deleted "${project.name}".`);
  }

  function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString();
  }
</script>

<header class="page-head">
  <div>
    <h1>Projects</h1>
    <p class="sub">Workspaces that scope AI chat and reports to selected library sources.</p>
  </div>
  <button class="btn primary" onclick={startCreate}><Plus size={15} /> New project</button>
</header>

{#if creating}
  <div class="create-row">
    <input
      bind:this={nameInput}
      placeholder="Project name"
      bind:value={newName}
      onkeydown={(e) => {
        if (e.key === "Enter") handleCreate();
        if (e.key === "Escape") creating = false;
      }}
    />
    <button class="btn primary" onclick={handleCreate} disabled={!newName.trim()}>Create</button>
    <button class="btn" onclick={() => (creating = false)}>Cancel</button>
  </div>
{/if}

{#if projects.length === 0 && !creating}
  <div class="empty">
    <FolderKanban size={40} />
    <p>No projects yet.</p>
    <p class="hint">
      Create a project, add repos and videos from your library, then chat
      across all of them and generate reports.
    </p>
  </div>
{:else}
  <div class="grid">
    {#each projects as p (p.id)}
      <a class="card" href={`/projects/${p.id}`}>
        <div class="card-top">
          <span class="proj-icon"><FolderKanban size={18} /></span>
          <h2>{p.name}</h2>
          <button
            class="del"
            class:confirm={confirmDeleteId === p.id}
            title={confirmDeleteId === p.id ? "Click again to delete" : "Delete project"}
            aria-label="Delete project"
            onclick={(e) => {
              e.preventDefault();
              handleDelete(p);
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
        {#if p.description}
          <p class="desc">{p.description}</p>
        {/if}
        <div class="meta">
          <span title="Sources"><Layers size={13} /> {p.memberIds.length}</span>
          <span title="Reports"><FileText size={13} /> {p.reports.length}</span>
          <span class="date">{fmtDate(p.createdAt)}</span>
        </div>
      </a>
    {/each}
  </div>
{/if}

<style>
  .page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }
  h1 { font-size: 1.5rem; margin: 0; letter-spacing: -0.01em; }
  .sub { color: var(--text-dim); font-size: 0.9rem; margin: 0.2rem 0 0; }

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
    transition: background 0.15s;
  }
  .btn:hover:not(:disabled) { background: var(--hover); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .btn.primary:hover:not(:disabled) { background: var(--accent-hover); }

  .create-row { display: flex; gap: 0.6rem; margin-bottom: 1.25rem; max-width: 480px; }
  .create-row input {
    flex: 1;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-size: 0.92rem;
    font-family: inherit;
  }
  .create-row input:focus { outline: none; border-color: var(--accent); }

  .empty {
    display: grid;
    place-items: center;
    gap: 0.4rem;
    padding: 4rem 1rem;
    color: var(--text-dim);
    text-align: center;
  }
  .empty p { margin: 0; }
  .empty .hint { font-size: 0.85rem; max-width: 380px; }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 1rem;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.1rem;
    box-shadow: var(--shadow);
    color: var(--text);
    text-decoration: none;
    transition: border-color 0.15s, transform 0.1s;
  }
  .card:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .card-top { display: flex; align-items: center; gap: 0.55rem; }
  .proj-icon {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 9px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    flex-shrink: 0;
  }
  h2 {
    font-size: 1rem;
    margin: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .del {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s, color 0.15s, background 0.15s;
  }
  .card:hover .del, .del.confirm { opacity: 1; }
  .del:hover, .del.confirm { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); }

  .desc {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-dim);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    margin-top: auto;
    font-size: 0.78rem;
    color: var(--text-dim);
  }
  .meta span { display: inline-flex; align-items: center; gap: 0.25rem; }
  .meta .date { margin-left: auto; }
</style>
