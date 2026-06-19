import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { load, type Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "settings.json";
const KEY_DISMISSED = "dismissedUpdateVersion";

export interface UpdateInfo {
  /** Latest available version (without a leading "v"). */
  version: string;
  /** Currently-running app version. */
  current: string;
  /** Release notes body, if provided in the manifest. */
  notes: string;
  /** The underlying Tauri update handle used to download & install. */
  handle: Update;
}

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE);
  return storePromise;
}

/**
 * Check the configured updater endpoint for a newer signed release. Returns
 * update info when one is available, otherwise null. Network/verification
 * failures resolve to null so the UI can fail silently.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      current: update.currentVersion,
      notes: update.body ?? "",
      handle: update,
    };
  } catch {
    return null;
  }
}

/**
 * Download and install the update, reporting progress, then relaunch the app
 * into the new version. The downloaded bundle is verified against the public
 * key baked into the app before it is applied.
 */
export async function installUpdate(
  info: UpdateInfo,
  onProgress?: (downloaded: number, total: number | null) => void
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;
  await info.handle.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        onProgress?.(0, total);
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.(downloaded, total);
        break;
      case "Finished":
        onProgress?.(total ?? downloaded, total);
        break;
    }
  });
  await relaunch();
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
