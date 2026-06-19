import { appDataDir, join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { mkdir, writeFile, remove, exists } from "@tauri-apps/plugin-fs";

/**
 * Disk-backed media storage. Binaries (screenshots, clips, diagrams,
 * thumbnails) live as files under `<appDataDir>/media/<videoId>/…`; the
 * library store keeps only the relative path. This keeps `library.json` small
 * and text-only (base64 blobs would bloat it ~33% and slow every rewrite).
 */

const MEDIA_DIR = "media";

/** Decode a `data:<mime>;base64,…` URL into raw bytes. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** True if the string is an inline data URL (legacy in-store media). */
export function isDataUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("data:");
}

async function mediaRoot(videoId: string): Promise<string> {
  const dir = await join(await appDataDir(), MEDIA_DIR, videoId);
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Write media bytes (or a data URL) into the video's media folder and return
 * the stored **relative** path (`media/<videoId>/<filename>`) for the store.
 */
export async function saveMedia(
  videoId: string,
  filename: string,
  data: Uint8Array | string
): Promise<string> {
  const bytes = typeof data === "string" ? dataUrlToBytes(data) : data;
  const dir = await mediaRoot(videoId);
  const abs = await join(dir, filename);
  await writeFile(abs, bytes);
  return `${MEDIA_DIR}/${videoId}/${filename}`;
}

/** Resolve a stored relative media path to an absolute filesystem path. */
export async function mediaAbsPath(relativePath: string): Promise<string> {
  return join(await appDataDir(), relativePath);
}

/**
 * Resolve a stored relative media path to an asset-protocol URL usable in
 * `<img>`/`<video>` `src`. Returns the input unchanged if it's already a data
 * URL (legacy records mid-migration).
 */
export async function mediaSrc(relativePath: string | null): Promise<string> {
  if (!relativePath) return "";
  if (isDataUrl(relativePath)) return relativePath;
  return convertFileSrc(await mediaAbsPath(relativePath));
}

/** Remove a single stored media file (best-effort). */
export async function removeMedia(relativePath: string | null): Promise<void> {
  if (!relativePath || isDataUrl(relativePath)) return;
  const abs = await mediaAbsPath(relativePath);
  if (await exists(abs)) await remove(abs);
}

/** Remove a video's entire media folder (best-effort). */
export async function removeMediaDir(videoId: string): Promise<void> {
  const dir = await join(await appDataDir(), MEDIA_DIR, videoId);
  if (await exists(dir)) await remove(dir, { recursive: true });
}
