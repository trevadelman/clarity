import { load, type Store } from "@tauri-apps/plugin-store";
import {
  appDataDir,
  join,
} from "@tauri-apps/api/path";
import {
  mkdir,
  writeFile,
  readFile,
  remove,
  exists,
} from "@tauri-apps/plugin-fs";
import {
  uploadAndWait,
  getFileState,
  deleteFile,
  type GeminiFile,
  type Status,
  type TokenUsage,
  type HighlightSpec,
} from "./gemini";
import { saveMedia, removeMediaDir, isDataUrl } from "./media";

const STORE_FILE = "library.json";
const KEY_VIDEOS = "videos";
const VIDEO_DIR = "videos";

/** A highlight moment, with its locally-rendered screenshot once generated. */
export interface Highlight {
  id: string;
  label: string;
  /** The moment to capture, in seconds. */
  atSec: number | null;
  /**
   * Stored relative path to the rendered PNG screenshot, or null until
   * generated. Resolve for display with `mediaSrc()`.
   */
  mediaPath: string | null;
}



export interface VideoRecord {
  id: string;
  videoName: string;
  localPath: string;
  mimeType: string;
  sizeBytes: number;
  addedAt: string;
  /** Stored relative path to the poster frame (JPEG). Resolve via `mediaSrc()`. */
  thumbnailPath: string | null;
  durationSec: number | null;
  tags: string[];


  geminiName: string | null;
  geminiUri: string | null;

  summary: string | null;
  summaryPrompt: string | null;
  summaryModel: string | null;
  summarizedAt: string | null;
  summaryInputTokens: number | null;
  summaryOutputTokens: number | null;
  summaryCostUsd: number | null;

  /** Stored relative path to the diagram (PNG). Resolve via `mediaSrc()`. */
  diagramPath: string | null;
  diagramGeneratedAt: string | null;
  diagramCostUsd: number | null;


  highlights: Highlight[];
}


let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE);
  return storePromise;
}

async function readAll(): Promise<VideoRecord[]> {
  const store = await getStore();
  return (await store.get<VideoRecord[]>(KEY_VIDEOS)) ?? [];
}

async function writeAll(records: VideoRecord[]): Promise<void> {
  const store = await getStore();
  await store.set(KEY_VIDEOS, records);
  await store.save();
}

export async function listVideos(): Promise<VideoRecord[]> {
  const records = await readAll();
  let dirty = false;
  for (const r of records) {
    if (!Array.isArray(r.tags)) r.tags = [];
    if (!Array.isArray(r.highlights)) r.highlights = [];
    if (await migrateRecordMedia(r)) dirty = true;
  }
  if (dirty) await writeAll(records);
  return records.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

/**
 * One-time, transparent migration of legacy records that stored media as
 * inline base64 data URLs (and used `kind:"gif"`). Writes any such blob out to
 * a disk file, replaces the field with its relative path, and renames legacy
 * field names. Returns true if the record was modified.
 */
async function migrateRecordMedia(r: VideoRecord): Promise<boolean> {
  let dirty = false;

  // Legacy field renames: thumbnail → thumbnailPath, diagram → diagramPath.
  const legacy = r as unknown as Record<string, unknown>;
  if (legacy.thumbnail !== undefined) {
    if (r.thumbnailPath == null && typeof legacy.thumbnail === "string") {
      r.thumbnailPath = legacy.thumbnail as string;
    }
    delete legacy.thumbnail;
    dirty = true;
  }
  if (legacy.diagram !== undefined) {
    if (r.diagramPath == null && typeof legacy.diagram === "string") {
      r.diagramPath = legacy.diagram as string;
    }
    delete legacy.diagram;
    dirty = true;
  }

  if (isDataUrl(r.thumbnailPath)) {
    r.thumbnailPath = await saveMedia(r.id, "thumbnail.jpg", r.thumbnailPath!);
    dirty = true;
  }
  if (isDataUrl(r.diagramPath)) {
    r.diagramPath = await saveMedia(r.id, "diagram.png", r.diagramPath!);
    dirty = true;
  }

  for (const h of r.highlights ?? []) {
    const lh = h as unknown as Record<string, unknown>;
    // Legacy clip/gif highlights are no longer supported — collapse any
    // remaining `kind`, `startSec`, and `endSec` fields down to a screenshot.
    if (lh.kind !== undefined) {
      if (h.atSec == null && typeof lh.startSec === "number") h.atSec = lh.startSec;
      delete lh.kind;
      delete lh.startSec;
      delete lh.endSec;
      dirty = true;
    }
    if (lh.image !== undefined) {
      if (h.mediaPath == null && typeof lh.image === "string") {
        h.mediaPath = lh.image as string;
      }
      delete lh.image;
      dirty = true;
    }
    if (isDataUrl(h.mediaPath)) {
      h.mediaPath = await saveMedia(r.id, `highlight-${h.id}.png`, h.mediaPath!);
      dirty = true;
    }
  }


  return dirty;
}


function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** Add a tag to a record (deduplicated, normalized). Returns updated tags. */
export async function addTag(record: VideoRecord, tag: string): Promise<string[]> {
  const clean = normalizeTag(tag);
  if (!clean) return record.tags ?? [];
  const tags = Array.isArray(record.tags) ? record.tags : [];
  if (!tags.includes(clean)) tags.push(clean);
  record.tags = tags;
  await upsert(record);
  return tags;
}

/** Remove a tag from a record. Returns updated tags. */
export async function removeTag(record: VideoRecord, tag: string): Promise<string[]> {
  const tags = (Array.isArray(record.tags) ? record.tags : []).filter((t) => t !== tag);
  record.tags = tags;
  await upsert(record);
  return tags;
}

/** Collect all distinct tags across the library, sorted alphabetically. */
export async function listAllTags(): Promise<string[]> {
  const records = await readAll();
  const set = new Set<string>();
  for (const r of records) for (const t of r.tags ?? []) set.add(t);
  return [...set].sort();
}

export async function getVideo(id: string): Promise<VideoRecord | null> {
  const records = await readAll();
  return records.find((r) => r.id === id) ?? null;
}

async function upsert(record: VideoRecord): Promise<void> {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === record.id);
  if (idx >= 0) records[idx] = record;
  else records.push(record);
  await writeAll(records);
}

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export function mimeForName(name: string): string {
  const ext = (name.split(".").pop() ?? "mp4").toLowerCase();
  return MIME_BY_EXT[ext] ?? "video/mp4";
}

/** Copy a chosen local video into app data and create a record. */
export async function addVideo(sourcePath: string): Promise<VideoRecord> {
  const videoName = sourcePath.split("/").pop() ?? sourcePath;
  const ext = (videoName.split(".").pop() ?? "mp4").toLowerCase();
  const bytes = await readFile(sourcePath);

  const dir = await join(await appDataDir(), VIDEO_DIR);
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });

  const id = crypto.randomUUID();
  const localPath = await join(dir, `${id}.${ext}`);
  await writeFile(localPath, bytes);

  const record: VideoRecord = {
    id,
    videoName,
    localPath,
    mimeType: mimeForName(videoName),
    sizeBytes: bytes.length,
    addedAt: new Date().toISOString(),
    thumbnailPath: null,
    durationSec: null,
    tags: [],
    geminiName: null,
    geminiUri: null,
    summary: null,
    summaryPrompt: null,
    summaryModel: null,
    summarizedAt: null,
    summaryInputTokens: null,
    summaryOutputTokens: null,
    summaryCostUsd: null,
    diagramPath: null,
    diagramGeneratedAt: null,
    diagramCostUsd: null,
    highlights: [],

  };
  await upsert(record);
  return record;
}

export type GeminiStatus = "active" | "missing" | "checking";

/** Check whether the record's Gemini file is currently ACTIVE. */
export async function checkGeminiStatus(
  apiKey: string,
  record: VideoRecord
): Promise<GeminiStatus> {
  if (!record.geminiName) return "missing";
  const file = await getFileState(apiKey, record.geminiName);
  return file && file.state === "ACTIVE" ? "active" : "missing";
}

/**
 * Ensure the record has an ACTIVE Gemini file, re-uploading from the local
 * copy and remapping the record if it's missing or expired.
 */
export async function ensureActiveFile(
  apiKey: string,
  record: VideoRecord,
  onStatus: (s: Status) => void
): Promise<GeminiFile> {
  if (record.geminiName) {
    const existing = await getFileState(apiKey, record.geminiName);
    if (existing && existing.state === "ACTIVE") return existing;
  }

  const bytes = await readFile(record.localPath);
  const file = await uploadAndWait(
    apiKey,
    bytes,
    record.mimeType,
    record.videoName,
    onStatus
  );

  record.geminiName = file.name;
  record.geminiUri = file.uri;
  await upsert(record);
  return file;
}

export async function saveSummary(
  record: VideoRecord,
  summary: string,
  prompt: string,
  model: string,
  usage: TokenUsage,
  highlights?: HighlightSpec[]
): Promise<void> {
  record.summary = summary;
  record.summaryPrompt = prompt;
  record.summaryModel = model;
  record.summarizedAt = new Date().toISOString();
  record.summaryInputTokens = usage.inputTokens;
  record.summaryOutputTokens = usage.outputTokens;
  record.summaryCostUsd = usage.costUsd;
  if (highlights) record.highlights = highlights.map(specToHighlight);
  await upsert(record);
}

function specToHighlight(spec: HighlightSpec): Highlight {
  return {
    id: crypto.randomUUID(),
    label: spec.label,
    atSec: spec.atSec ?? null,
    mediaPath: null,
  };
}


/** Persist a generated diagram image (PNG data URL) onto a record, on disk. */
export async function saveDiagram(
  record: VideoRecord,
  image: string,
  costUsd: number
): Promise<void> {
  record.diagramPath = await saveMedia(record.id, "diagram.png", image);
  record.diagramGeneratedAt = new Date().toISOString();
  record.diagramCostUsd = costUsd;
  await upsert(record);
}

/**
 * Store a rendered highlight screenshot (PNG data URL) on disk and record its
 * relative path.
 */
export async function saveHighlightMedia(
  record: VideoRecord,
  highlightId: string,
  data: string
): Promise<void> {
  const h = record.highlights.find((x) => x.id === highlightId);
  if (!h) return;
  h.mediaPath = await saveMedia(record.id, `highlight-${highlightId}.png`, data);
  await upsert(record);
}


/** Persist a generated poster frame (JPEG data URL) + duration onto a record. */
export async function setThumbnail(
  record: VideoRecord,
  thumbnail: string | null,
  durationSec: number | null
): Promise<void> {
  record.thumbnailPath = thumbnail
    ? await saveMedia(record.id, "thumbnail.jpg", thumbnail)
    : null;
  record.durationSec = durationSec;
  await upsert(record);
}


/** Delete every video: local files, Gemini uploads, and all records. */
export async function clearAll(apiKey: string): Promise<void> {
  const records = await readAll();
  for (const record of records) {
    if (apiKey && record.geminiName) {
      try {
        await deleteFile(apiKey, record.geminiName);
      } catch {
        // already gone on Gemini's side; ignore
      }
    }
    if (await exists(record.localPath)) await remove(record.localPath);
    await removeMediaDir(record.id);
  }
  await writeAll([]);
}


/** Delete the record, its local file, and its Gemini file (if mapped). */
export async function deleteVideo(apiKey: string, record: VideoRecord): Promise<void> {
  if (record.geminiName) {
    try {
      await deleteFile(apiKey, record.geminiName);
    } catch {
      // file may already be expired/gone on Gemini's side; ignore
    }
  }
  if (await exists(record.localPath)) await remove(record.localPath);
  await removeMediaDir(record.id);
  const records = await readAll();
  await writeAll(records.filter((r) => r.id !== record.id));
}

