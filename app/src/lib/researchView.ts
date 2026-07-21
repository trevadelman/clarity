import { invoke } from "@tauri-apps/api/core";
import type { RepoRef } from "./github";

/**
 * Live research view: a native child webview docked next to the repo chat
 * that follows the agent's GitHub research in real time. The webview itself
 * is owned by the Rust side (see src-tauri/src/lib.rs); this module is a
 * thin invoke() wrapper plus the tool-call → GitHub URL mapping.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Open (or re-target) the research webview at the given CSS-pixel rect. */
export async function openResearchView(url: string, rect: Rect): Promise<void> {
  await invoke("open_research_view", { url, ...rect });
}

/** Navigate the already-open research webview. */
export async function navigateResearchView(url: string): Promise<void> {
  await invoke("navigate_research_view", { url });
}

/** Reposition/resize the research webview (CSS pixels). */
export async function setResearchViewRect(rect: Rect): Promise<void> {
  await invoke("set_research_view_rect", { ...rect });
}

/** Close the research webview if open. */
export async function closeResearchView(): Promise<void> {
  await invoke("close_research_view");
}

/** GitHub URL for the repo's home page. */
export function repoHomeUrl(ref: RepoRef, branch: string): string {
  return `https://github.com/${ref.owner}/${ref.repo}/tree/${branch}`;
}

/** GitHub URL for a file on the default branch. */
export function fileUrl(ref: RepoRef, branch: string, path: string): string {
  return `https://github.com/${ref.owner}/${ref.repo}/blob/${branch}/${encodePath(path)}`;
}

/** GitHub URL for a commit. */
export function commitUrl(ref: RepoRef, sha: string): string {
  return `https://github.com/${ref.owner}/${ref.repo}/commit/${sha}`;
}

function cleanPath(path: string): string {
  return path.replace(/^\/+/, "");
}

/** Percent-encode each path segment (keeps `/`, handles `[id]` etc.). */
function encodePath(path: string): string {
  return cleanPath(path).split("/").map(encodeURIComponent).join("/");
}

/**
 * Map a repo research tool call to the GitHub page that shows the same
 * information, or null if the call has no natural page.
 */
export function urlForToolCall(
  name: string,
  args: Record<string, unknown>,
  ref: RepoRef,
  branch: string
): string | null {
  const base = `https://github.com/${ref.owner}/${ref.repo}`;
  switch (name) {
    case "read_file":
      return fileUrl(ref, branch, String(args.path ?? ""));
    case "list_directory": {
      const path = encodePath(String(args.path ?? ""));
      return path ? `${base}/tree/${branch}/${path}` : `${base}/tree/${branch}`;
    }
    case "get_commit_diff":
      return commitUrl(ref, String(args.sha ?? ""));
    case "list_commits":
      return `${base}/commits/${branch}`;
    case "search_code": {
      const q = encodeURIComponent(`repo:${ref.owner}/${ref.repo} ${String(args.query ?? "")}`);
      return `https://github.com/search?q=${q}&type=code`;
    }
    default:
      return null;
  }
}
