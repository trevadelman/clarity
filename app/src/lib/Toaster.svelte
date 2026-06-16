<script lang="ts">
  import { fly, fade } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { CheckCircle2, AlertCircle, Info, X } from "lucide-svelte";
  import { toasts, dismissToast, type ToastKind } from "./toast";

  const icons = { success: CheckCircle2, error: AlertCircle, info: Info };

  function iconFor(kind: ToastKind) {
    return icons[kind];
  }
</script>

<div class="toaster">
  {#each $toasts as t (t.id)}
    {@const Icon = iconFor(t.kind)}
    <div
      class="toast {t.kind}"
      in:fly={{ y: 12, duration: 220 }}
      out:fade={{ duration: 160 }}
      animate:flip={{ duration: 200 }}
    >
      <Icon size={18} />
      <span class="msg">{t.message}</span>
      <button class="close" aria-label="Dismiss" onclick={() => dismissToast(t.id)}>
        <X size={15} />
      </button>
    </div>
  {/each}
</div>

<style>
  .toaster {
    position: fixed;
    bottom: 1.25rem;
    right: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    z-index: 1000;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 0.55rem;
    min-width: 240px;
    max-width: 380px;
    padding: 0.7rem 0.85rem;
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    font-size: 0.9rem;
  }
  .toast.success { border-left: 3px solid var(--ok); }
  .toast.success :global(svg) { color: var(--ok); }
  .toast.error { border-left: 3px solid var(--danger); }
  .toast.error :global(svg) { color: var(--danger); }
  .toast.info { border-left: 3px solid var(--accent); }
  .toast.info :global(svg) { color: var(--accent); }
  .msg { flex: 1; }
  .close {
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    padding: 0.1rem;
    display: flex;
    border-radius: 6px;
  }
  .close:hover { color: var(--text); background: var(--hover); }
</style>
