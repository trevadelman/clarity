import { load, type Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "bookmarks.json";
const KEY_NODES = "nodes";

/** A node in the Browse-mode link tree: either a folder or a link. */
export interface BookmarkNode {
  id: string;
  /** Parent folder id, or null for top level. */
  parentId: string | null;
  kind: "folder" | "link";
  label: string;
  /** Only present for `kind === "link"`. */
  url?: string;
  /** Pinned into the favorites row at the top of the tree. */
  favorite?: boolean;
  /** Sibling sort key (order-by-added in v1). */
  order: number;
  addedAt: string;
}

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE);
  return storePromise;
}

async function readAll(): Promise<BookmarkNode[]> {
  const store = await getStore();
  return (await store.get<BookmarkNode[]>(KEY_NODES)) ?? [];
}

async function writeAll(nodes: BookmarkNode[]): Promise<void> {
  const store = await getStore();
  await store.set(KEY_NODES, nodes);
  await store.save();
}

/** All nodes, sorted by (parent, order). Callers build the tree shape. */
export async function listBookmarks(): Promise<BookmarkNode[]> {
  const nodes = await readAll();
  return nodes.sort((a, b) => a.order - b.order);
}

/** Next sibling order value under the given parent. */
function nextOrder(nodes: BookmarkNode[], parentId: string | null): number {
  const siblings = nodes.filter((n) => n.parentId === parentId);
  return siblings.length === 0
    ? 0
    : Math.max(...siblings.map((n) => n.order)) + 1;
}

/** Add a link node. Returns the created node. */
export async function addLink(
  label: string,
  url: string,
  parentId: string | null = null
): Promise<BookmarkNode> {
  const nodes = await readAll();
  const node: BookmarkNode = {
    id: crypto.randomUUID(),
    parentId,
    kind: "link",
    label: label.trim() || url,
    url,
    order: nextOrder(nodes, parentId),
    addedAt: new Date().toISOString(),
  };
  nodes.push(node);
  await writeAll(nodes);
  return node;
}

/** Add a folder node. Returns the created node. */
export async function addFolder(
  label: string,
  parentId: string | null = null
): Promise<BookmarkNode> {
  const nodes = await readAll();
  const node: BookmarkNode = {
    id: crypto.randomUUID(),
    parentId,
    kind: "folder",
    label: label.trim(),
    order: nextOrder(nodes, parentId),
    addedAt: new Date().toISOString(),
  };
  nodes.push(node);
  await writeAll(nodes);
  return node;
}

/** Update fields on a node (label, url, favorite, parentId). */
export async function updateBookmark(
  id: string,
  patch: Partial<Pick<BookmarkNode, "label" | "url" | "favorite" | "parentId">>
): Promise<void> {
  const nodes = await readAll();
  const node = nodes.find((n) => n.id === id);
  if (!node) return;
  Object.assign(node, patch);
  await writeAll(nodes);
}

/** Ids of `id` plus all its descendants (folders cascade). */
function descendantSet(nodes: BookmarkNode[], id: string): Set<string> {
  const set = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (n.parentId && set.has(n.parentId) && !set.has(n.id)) {
        set.add(n.id);
        grew = true;
      }
    }
  }
  return set;
}

/**
 * Move a node to `newParentId` at sibling position `newIndex`, renumbering
 * the destination siblings in one atomic write. Rejects moves that would
 * place a folder inside itself or a descendant.
 */
export async function moveBookmark(
  id: string,
  newParentId: string | null,
  newIndex: number
): Promise<void> {
  const nodes = await readAll();
  const node = nodes.find((n) => n.id === id);
  if (!node) return;
  if (newParentId !== null && descendantSet(nodes, id).has(newParentId)) {
    throw new Error("Can't move a folder into itself.");
  }

  const siblings = nodes
    .filter((n) => n.parentId === newParentId && n.id !== id)
    .sort((a, b) => a.order - b.order);
  const at = Math.max(0, Math.min(newIndex, siblings.length));
  siblings.splice(at, 0, node);

  node.parentId = newParentId;
  siblings.forEach((n, i) => (n.order = i));
  await writeAll(nodes);
}

/** Remove a node; folders cascade to all descendants. */
export async function removeBookmark(id: string): Promise<void> {
  const nodes = await readAll();
  const doomed = descendantSet(nodes, id);
  await writeAll(nodes.filter((n) => !doomed.has(n.id)));
}

/**
 * Normalize user URL input: prepend https:// when no scheme given, and
 * validate the result is http(s). Returns null for anything unusable.
 */
export function normalizeUrl(input: string): string | null {
  let raw = input.trim();
  if (!raw) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Favicon image URL for a link (Google's favicon service; no caching). */
export function faviconUrl(url: string, size = 64): string {
  try {
    const host = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size}`;
  } catch {
    return "";
  }
}
