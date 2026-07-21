import { invoke } from "@tauri-apps/api/core";
import type { Rect } from "./researchView";

/**
 * Browse-mode tabs: each bookmark link gets its own persistent native
 * child webview (labeled `tab-{id}` on the Rust side). Switching tabs
 * shows an already-loaded webview — instant and stateful, like Arc —
 * instead of navigating a shared one. Rust enforces an LRU cap.
 */

/**
 * Open a tab (create-or-show) at the given CSS-pixel rect. `bg` is a
 * `#rrggbb` theme color painted before the page's first render (avoids
 * the white flash in dark mode).
 */
export async function openTab(
  id: string,
  url: string,
  rect: Rect,
  bg?: string
): Promise<void> {
  await invoke("open_tab", { id, url, ...rect, bg });
}

/** Reposition/resize all tab webviews (CSS pixels). */
export async function setTabRect(rect: Rect): Promise<void> {
  await invoke("set_tab_rect", { ...rect });
}

/** Close one tab's webview. */
export async function closeTab(id: string): Promise<void> {
  await invoke("close_tab", { id });
}

/** Hide all tabs without destroying them (leaving /browse). */
export async function hideAllTabs(): Promise<void> {
  await invoke("hide_all_tabs");
}

/** Destroy all tab webviews. */
export async function closeAllTabs(): Promise<void> {
  await invoke("close_all_tabs");
}

/** History navigation in a tab. */
export async function tabHistory(
  id: string,
  action: "back" | "forward" | "reload"
): Promise<void> {
  await invoke("tab_history", { id, action });
}
