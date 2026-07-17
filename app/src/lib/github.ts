import { fetch as httpFetch } from "@tauri-apps/plugin-http";

/**
 * GitHub REST API client for the repo activity feature. All calls go through
 * the Tauri HTTP plugin (scoped to api.github.com) and accept an optional
 * personal access token for private repos and higher rate limits.
 */

const API = "https://api.github.com";

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface RepoInfo {
  owner: string;
  repo: string;
  description: string | null;
  language: string | null;
  stars: number;
  defaultBranch: string;
  htmlUrl: string;
  pushedAt: string | null;
  isPrivate: boolean;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
  htmlUrl: string;
}

export interface CommitDetail extends CommitInfo {
  additions: number;
  deletions: number;
  filesChanged: number;
  /** Unified diff patches, one entry per file (may be truncated). */
  patches: string[];
}

/** Parse `https://github.com/owner/repo[...]` into a ref, or null. */
export function parseGitHubRepo(url: string): RepoRef | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "");
  if (host !== "github.com") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repoRaw] = parts;
  const repo = repoRaw.replace(/\.git$/, "");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

function headers(token: string, accept = "application/vnd.github+json"): Record<string, string> {
  const h: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function api<T>(path: string, token: string): Promise<T> {
  const res = await httpFetch(`${API}${path}`, { headers: headers(token) });
  if (res.status === 404) {
    throw new Error("Repository not found. Private repo? Add a GitHub token in Settings.");
  }
  if (res.status === 403 || res.status === 429) {
    throw new Error("GitHub rate limit hit. Add a GitHub token in Settings to raise it.");
  }
  if (!res.ok) throw new Error(`GitHub API error (${res.status}).`);
  return (await res.json()) as T;
}

/** Fetch repo metadata. */
export async function fetchRepoInfo(ref: RepoRef, token: string): Promise<RepoInfo> {
  const r = await api<{
    description: string | null;
    language: string | null;
    stargazers_count: number;
    default_branch: string;
    html_url: string;
    pushed_at: string | null;
    private: boolean;
  }>(`/repos/${ref.owner}/${ref.repo}`, token);
  return {
    owner: ref.owner,
    repo: ref.repo,
    description: r.description,
    language: r.language,
    stars: r.stargazers_count,
    defaultBranch: r.default_branch,
    htmlUrl: r.html_url,
    pushedAt: r.pushed_at,
    isPrivate: r.private,
  };
}

interface ApiCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name?: string; date?: string } | null;
  };
  author: { login?: string } | null;
}

function toCommitInfo(c: ApiCommit): CommitInfo {
  return {
    sha: c.sha,
    message: c.commit.message,
    author: c.author?.login ?? c.commit.author?.name ?? "unknown",
    date: c.commit.author?.date ?? "",
    htmlUrl: c.html_url,
  };
}

/** List commits on the default branch since an ISO date (paged, up to 300). */
export async function fetchCommitsSince(
  ref: RepoRef,
  sinceIso: string,
  token: string
): Promise<CommitInfo[]> {
  const out: CommitInfo[] = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await api<ApiCommit[]>(
      `/repos/${ref.owner}/${ref.repo}/commits?since=${encodeURIComponent(sinceIso)}&per_page=100&page=${page}`,
      token
    );
    out.push(...batch.map(toCommitInfo));
    if (batch.length < 100) break;
  }
  return out;
}

const MAX_PATCH_CHARS_PER_FILE = 12_000;
const MAX_PATCHES_PER_COMMIT = 40;

/** Fetch one commit's stats and per-file patches (truncated to sane sizes). */
export async function fetchCommitDetail(
  ref: RepoRef,
  sha: string,
  token: string
): Promise<CommitDetail> {
  const c = await api<
    ApiCommit & {
      stats: { additions: number; deletions: number };
      files: { filename: string; patch?: string; status: string }[];
    }
  >(`/repos/${ref.owner}/${ref.repo}/commits/${sha}`, token);
  const files = c.files ?? [];
  const patches = files.slice(0, MAX_PATCHES_PER_COMMIT).map((f) => {
    const body = f.patch
      ? f.patch.slice(0, MAX_PATCH_CHARS_PER_FILE)
      : `(no text diff — ${f.status})`;
    return `--- ${f.filename} (${f.status})\n${body}`;
  });
  return {
    ...toCommitInfo(c),
    additions: c.stats?.additions ?? 0,
    deletions: c.stats?.deletions ?? 0,
    filesChanged: files.length,
    patches,
  };
}

const MAX_FILE_CHARS = 50_000;

/** Read a file's current content from the default branch (truncated). */
export async function fetchFileContent(
  ref: RepoRef,
  path: string,
  token: string
): Promise<string> {
  const res = await httpFetch(
    `${API}/repos/${ref.owner}/${ref.repo}/contents/${path.replace(/^\/+/, "")}`,
    { headers: headers(token, "application/vnd.github.raw+json") }
  );
  if (res.status === 404) return `(file not found: ${path})`;
  if (!res.ok) throw new Error(`GitHub API error (${res.status}) reading ${path}.`);
  const text = await res.text();
  return text.length > MAX_FILE_CHARS
    ? `${text.slice(0, MAX_FILE_CHARS)}\n\n(truncated at ${MAX_FILE_CHARS} chars)`
    : text;
}

/** List a directory's entries ("" for repo root). */
export async function fetchDirectory(
  ref: RepoRef,
  path: string,
  token: string
): Promise<{ name: string; path: string; type: string; size: number }[]> {
  const entries = await api<
    { name: string; path: string; type: string; size: number }[] | { type: string }
  >(`/repos/${ref.owner}/${ref.repo}/contents/${path.replace(/^\/+/, "")}`, token);
  if (!Array.isArray(entries)) throw new Error(`${path} is a file, not a directory.`);
  return entries.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size }));
}

/** Search code in the repo; returns matching file paths with fragments. */
export async function searchCode(
  ref: RepoRef,
  query: string,
  token: string
): Promise<{ path: string; fragments: string[] }[]> {
  const q = encodeURIComponent(`${query} repo:${ref.owner}/${ref.repo}`);
  const res = await httpFetch(`${API}/search/code?q=${q}&per_page=10`, {
    headers: headers(token, "application/vnd.github.text-match+json"),
  });
  if (!res.ok) throw new Error(`GitHub code search error (${res.status}).`);
  const data = (await res.json()) as {
    items: { path: string; text_matches?: { fragment: string }[] }[];
  };
  return data.items.map((i) => ({
    path: i.path,
    fragments: (i.text_matches ?? []).map((m) => m.fragment),
  }));
}

/** Fetch the repo README as plain text (empty string if none). */
export async function fetchReadme(ref: RepoRef, token: string): Promise<string> {
  const res = await httpFetch(`${API}/repos/${ref.owner}/${ref.repo}/readme`, {
    headers: headers(token, "application/vnd.github.raw+json"),
  });
  if (!res.ok) return "";
  return await res.text();
}
