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
}

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE);
  return storePromise;
}

async function readAll(): Promise<Project[]> {
  const store = await getStore();
  return (await store.get<Project[]>(KEY_PROJECTS)) ?? [];
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
  description = ""
): Promise<Project> {
  const project: Project = {
    id: crypto.randomUUID(),
    name: name.trim(),
    description: description.trim(),
    createdAt: new Date().toISOString(),
    memberIds: [],
    chat: [],
    reports: [],
  };
  await upsert(project);
  return project;
}

/** Rename a project / update its description. */
export async function updateProject(
  id: string,
  patch: Partial<Pick<Project, "name" | "description">>
): Promise<void> {
  const project = await getProject(id);
  if (!project) return;
  if (patch.name !== undefined) project.name = patch.name.trim();
  if (patch.description !== undefined) project.description = patch.description.trim();
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

/** Delete a project (library sources are untouched). */
export async function deleteProject(id: string): Promise<void> {
  const projects = await readAll();
  await writeAll(projects.filter((p) => p.id !== id));
}
