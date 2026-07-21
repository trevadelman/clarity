import { writable } from "svelte/store";
import type { BookmarkNode } from "./bookmarks";

/**
 * The currently-selected Browse-mode link. Set by the LinkTree sidebar,
 * consumed by the /browse route (which owns the webview surface in
 * Phase 2). Lives outside the router so the tree stays a launcher.
 */
export const selectedLink = writable<BookmarkNode | null>(null);
