import { getVersion } from "@tauri-apps/api/app";
import { load, type Store } from "@tauri-apps/plugin-store";

const REPO = "trevadelman/clarity";
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const STORE_FILE = "settings.json";
const KEY_DISMISSED = "dismissedUpdateVersion";

export interface UpdateInfo {
  /** Latest release version, normalized without a leading "v". */
  version: string;
  /** Currently-running app version. */
  current: string;
  /** Human-facing release page. */
  htmlUrl: string;
  /** Release notes body. */
  notes: string;
}

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE);
  return storePromise;
}

function stripV(tag: string): string {
  return tag.replace(/^v/i, "").trim();
}

/** Compare two dotted version strings. Returns 1 if a>b, -1 if a<b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

/**
 * Check GitHub for a newer release. Returns update info when a strictly newer
 * version is available, otherwise null. Network/parse failures return null.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const current = await getVersion();

    const res = await fetch(LATEST_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      body?: string;
    };
    if (!data.tag_name) return null;
    const version = stripV(data.tag_name);
    if (compareVersions(version, current) <= 0) return null;
    return {
      version,
      current,
      htmlUrl: data.html_url ?? `https://github.com/${REPO}/releases/latest`,
      notes: data.body ?? "",
    };
  } catch {
    return null;
  }
}

export async function isVersionDismissed(version: string): Promise<boolean> {
  const store = await getStore();
  return (await store.get<string>(KEY_DISMISSED)) === version;
}

export async function dismissVersion(version: string): Promise<void> {
  const store = await getStore();
  await store.set(KEY_DISMISSED, version);
  await store.save();
}
