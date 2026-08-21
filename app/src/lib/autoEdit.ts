import { appDataDir, join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { copyFile, exists, remove } from "@tauri-apps/plugin-fs";
import { save } from "@tauri-apps/plugin-dialog";
import { generateEditPlan, type EditSourceVideo, type ModelId } from "./gemini";
import { addEdit, type Edit, type EditPlan } from "./projects";

const EDITS_DIR = "edits";

/** Absolute path of an edit's output MP4 from its stored relative path. */
export async function editOutputAbsPath(edit: Edit): Promise<string> {
  return join(await appDataDir(), ...edit.outputPath.split("/"));
}

/** Remove an edit's output directory (call alongside removeEdit). */
export async function removeEditDir(editId: string): Promise<void> {
  const dir = await join(await appDataDir(), EDITS_DIR, editId);
  if (await exists(dir)) await remove(dir, { recursive: true });
}

/**
 * Export an edit's MP4 via a save dialog. Returns the chosen path, or null
 * if the user cancelled.
 */
export async function exportEdit(edit: Edit): Promise<string | null> {
  const safeName = edit.title.replace(/[^\w\s-]+/g, "").trim().replace(/\s+/g, "-");
  const path = await save({
    defaultPath: `${safeName || "edit"}.mp4`,
    filters: [{ name: "MP4 video", extensions: ["mp4"] }],
  });
  if (!path) return null;
  await copyFile(await editOutputAbsPath(edit), path);
  return path;
}

/** Cancel an in-flight render. */
export async function cancelRender(jobId: string): Promise<void> {
  await invoke("cancel_render", { jobId });
}

export interface GenerateEditOptions {
  apiKey: string;
  projectId: string;
  /** Edit instructions for the plan generation. */
  prompt: string;
  /** Sources: must all have a local file on disk. */
  videos: (EditSourceVideo & { localPath: string })[];
  /** Absolute path of the music track, or null for original audio only. */
  audioPath: string | null;
  /** "replace" or "mix" — ignored when audioPath is null. */
  audioMode: "replace" | "mix";
  width: number;
  height: number;
  model?: ModelId;
  onStatus: (label: string) => void;
  /** Render progress in [0, 1]. */
  onProgress: (progress: number) => void;
}

/**
 * The full Auto-Edit pipeline: Gemini plan generation → native AVFoundation
 * render (with progress events) → persist the Edit onto the project.
 */
export async function generateAndSaveEdit(opts: GenerateEditOptions): Promise<Edit> {
  opts.onStatus("Watching the videos and planning the edit…");
  const planResult = await generateEditPlan(
    opts.apiKey, opts.prompt, opts.videos, opts.model
  );

  const editId = crypto.randomUUID();
  const relOutput = `${EDITS_DIR}/${editId}/output.mp4`;
  const outputPath = await join(await appDataDir(), EDITS_DIR, editId, "output.mp4");

  const pathById = new Map(opts.videos.map((v) => [v.id, v.localPath]));
  const clips = planResult.clips.map((c) => ({
    path: pathById.get(c.videoId)!,
    start_sec: c.startSec,
    end_sec: c.endSec,
  }));

  opts.onStatus("Rendering the edit…");
  const unlisten = await listen<{ job_id: string; progress: number }>(
    "auto-edit-progress",
    (event) => {
      if (event.payload.job_id === editId) opts.onProgress(event.payload.progress);
    }
  );

  let durationSec: number;
  try {
    const result = await invoke<{ duration_sec: number }>("render_edit", {
      request: {
        job_id: editId,
        clips,
        audio: opts.audioPath
          ? { path: opts.audioPath, mode: opts.audioMode }
          : null,
        width: opts.width,
        height: opts.height,
        output_path: outputPath,
      },
    });
    durationSec = result.duration_sec;
  } finally {
    unlisten();
  }

  const plan: EditPlan = {
    clips: planResult.clips,
    audioMode: opts.audioPath ? opts.audioMode : "original",
    width: opts.width,
    height: opts.height,
  };
  const edit: Edit = {
    id: editId,
    title: planResult.title,
    prompt: opts.prompt,
    createdAt: new Date().toISOString(),
    costUsd: planResult.usage.costUsd,
    sourceIds: opts.videos.map((v) => v.id),
    audioPath: opts.audioPath,
    outputPath: relOutput,
    durationSec,
    plan,
  };
  await addEdit(opts.projectId, edit);
  return edit;
}
