import { load, type Store } from "@tauri-apps/plugin-store";
import type { ChatMessage } from "./gemini";

const STORE_FILE = "projects.json";
const KEY_PROJECTS = "projects";

/** A generated report artifact within a project. */
export interface Report {
  id: string;
  title: string;
  /** Markdown body. Screenshot images live under <appDataDir>/reports/<id>/. */
  markdown: string;
  /** The purpose prompt / instructions used to generate it. */
  prompt: string;
  createdAt: string;
  costUsd: number;
  /** Library ids of the sources consulted during generation. */
  sourceIds: string[];
}

/** One spliced segment in an auto-edit plan (times in seconds). */
export interface EditClip {
  videoId: string;
  startSec: number;
  endSec: number;
  /** Why this moment was chosen — shown in the plan breakdown UI. */
  reason: string;
}

/** The structured plan Gemini returns; the input to the native render. */
export interface EditPlan {
  clips: EditClip[];
  /** "replace" mutes original audio under the track; "mix" blends both. */
  audioMode: "replace" | "mix" | "original";
  /** Output dimensions in pixels. */
  width: number;
  height: number;
}

/** A rendered auto-edit artifact within a project. */
export interface Edit {
  id: string;
  title: string;
  /** The instructions used to generate the plan. */
  prompt: string;
  createdAt: string;
  costUsd: number;
  /** Library ids of the source videos used. */
  sourceIds: string[];
  /** Absolute path of the user-chosen audio track, or null for none. */
  audioPath: string | null;
  /** Path relative to <appDataDir>: edits/<id>/output.mp4 */
  outputPath: string;
  durationSec: number;
  /** The plan that produced the render — kept for provenance/regenerate. */
  plan: EditPlan;
}

/**
 * A soft emphasis hint chosen at creation time. It only affects section
 * ordering/visibility on the project page — NOT a hard project type; the
 * data model stays a single `Project` shape regardless.
 */
export type ProjectFocus = "research" | "studio";

/**
 * A project: a named workspace over a subset of library sources, with its
 * own chat thread and a running list of generated reports. Members are
 * references into the library (library.json stays the source of truth).
 */
export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  /** Library record ids (any source type). */
  memberIds: string[];
  /** Persistent project-scoped chat thread. */
  chat: ChatMessage[];
  /** Generated reports, newest first. */
  reports: Report[];
  /** Rendered auto-edits, newest first. */
  edits: Edit[];
  /** Optional emphasis hint; absent on older records ⇒ no emphasis. */
  focus?: ProjectFocus;
}

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE);
  return storePromise;
}

async function readAll(): Promise<Project[]> {
  const store = await getStore();
  const projects = (await store.get<Project[]>(KEY_PROJECTS)) ?? [];
  // Records created before Auto-Edit existed have no `edits` field.
  for (const p of projects) p.edits ??= [];
  return projects;
}

async function writeAll(projects: Project[]): Promise<void> {
  const store = await getStore();
  await store.set(KEY_PROJECTS, projects);
  await store.save();
}

/** All projects, newest first. */
export async function listProjects(): Promise<Project[]> {
  const projects = await readAll();
  return projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getProject(id: string): Promise<Project | null> {
  const projects = await readAll();
  return projects.find((p) => p.id === id) ?? null;
}

async function upsert(project: Project): Promise<void> {
  const projects = await readAll();
  const idx = projects.findIndex((p) => p.id === project.id);
  if (idx >= 0) projects[idx] = project;
  else projects.push(project);
  await writeAll(projects);
}

/** Create a new project. Returns the created record. */
export async function createProject(
  name: string,
  description = "",
  focus?: ProjectFocus
): Promise<Project> {
  const project: Project = {
    id: crypto.randomUUID(),
    name: name.trim(),
    description: description.trim(),
    createdAt: new Date().toISOString(),
    memberIds: [],
    chat: [],
    reports: [],
    edits: [],
    focus,
  };
  await upsert(project);
  return project;
}

/** Rename a project / update its description. */
export async function updateProject(
  id: string,
  patch: Partial<Pick<Project, "name" | "description" | "focus">>
): Promise<void> {
  const project = await getProject(id);
  if (!project) return;
  if (patch.name !== undefined) project.name = patch.name.trim();
  if (patch.description !== undefined) project.description = patch.description.trim();
  if (patch.focus !== undefined) project.focus = patch.focus;
  await upsert(project);
}

/** Replace the project's member list (deduplicated, order preserved). */
export async function setMembers(id: string, memberIds: string[]): Promise<void> {
  const project = await getProject(id);
  if (!project) return;
  project.memberIds = [...new Set(memberIds)];
  await upsert(project);
}

/** Add a library source to the project. */
export async function addMember(id: string, libraryId: string): Promise<void> {
  const project = await getProject(id);
  if (!project) return;
  if (!project.memberIds.includes(libraryId)) project.memberIds.push(libraryId);
  await upsert(project);
}

/** Remove a library source from the project. */
export async function removeMember(id: string, libraryId: string): Promise<void> {
  const project = await getProject(id);
  if (!project) return;
  project.memberIds = project.memberIds.filter((m) => m !== libraryId);
  await upsert(project);
}

/** Replace the project's chat thread. */
export async function saveProjectChat(id: string, chat: ChatMessage[]): Promise<void> {
  const project = await getProject(id);
  if (!project) return;
  project.chat = chat;
  await upsert(project);
}

/** Prepend a report onto the project. */
export async function addReport(id: string, report: Report): Promise<void> {
  const project = await getProject(id);
  if (!project) return;
  project.reports = [report, ...project.reports];
  await upsert(project);
}

/** Remove a report from the project. */
export async function removeReport(id: string, reportId: string): Promise<void> {
  const project = await getProject(id);
  if (!project) return;
  project.reports = project.reports.filter((r) => r.id !== reportId);
  await upsert(project);
}

/** Prepend an auto-edit onto the project. */
export async function addEdit(id: string, edit: Edit): Promise<void> {
  const project = await getProject(id);
  if (!project) return;
  project.edits = [edit, ...project.edits];
  await upsert(project);
}

/** Remove an auto-edit from the project. */
export async function removeEdit(id: string, editId: string): Promise<void> {
  const project = await getProject(id);
  if (!project) return;
  project.edits = project.edits.filter((e) => e.id !== editId);
  await upsert(project);
}

/** Delete a project (library sources are untouched). */
export async function deleteProject(id: string): Promise<void> {
  const projects = await readAll();
  await writeAll(projects.filter((p) => p.id !== id));
}
