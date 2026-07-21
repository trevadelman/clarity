import { writable } from "svelte/store";

/**
 * Whether any chat panel is currently open. The layout watches this to
 * auto-collapse the sidebar while chatting (screen space matters more than
 * nav) and restore it afterwards.
 */
export const chatDocked = writable(false);
