import { appDataDir, join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { mkdir, writeFile, remove, exists } from "@tauri-apps/plugin-fs";
import { captureFrame } from "./frames";
import { addReport, type Report } from "./projects";
import { save } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { marked } from "marked";
import {
  generateProjectReport, REPORT_MAX_TOOL_TURNS,
  type ProjectChatVideo, type ToolExecutor, type ToolReporter,
} from "./gemini";

const REPORTS_DIR = "reports";

// [SHOT:videoId:mm:ss caption text] — screenshot markers emitted by the
// report writer, replaced with captured stills post-generation.
const SHOT_RE = /\[SHOT:\s*([\w-]+)\s*:\s*(\d{1,2}:\d{2}(?::\d{2})?)\s+([^\]]+)\]/g;

function tsToSec(ts: string): number {
  const parts = ts.split(":").map(Number);
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

async function reportDir(reportId: string): Promise<string> {
  const dir = await join(await appDataDir(), REPORTS_DIR, reportId);
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  return dir;
}

/** Absolute path of a report image from its stored relative path. */
export async function reportImageAbsPath(relativePath: string): Promise<string> {
  return join(await appDataDir(), ...relativePath.split("/"));
}

/** Remove a report's screenshot directory (call alongside removeReport). */
export async function removeReportDir(reportId: string): Promise<void> {
  const dir = await join(await appDataDir(), REPORTS_DIR, reportId);
  if (await exists(dir)) await remove(dir, { recursive: true });
}

/** Extract the report's title from its first # heading, if present. */
function titleFromMarkdown(markdown: string): string | null {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Replace every [SHOT:videoId:mm:ss caption] marker with a captured still
 * saved under <appDataDir>/reports/<reportId>/. Markers whose video can't be
 * captured (YouTube, missing file) degrade to a plain timestamp citation.
 */
async function processShots(
  markdown: string,
  reportId: string,
  localPathById: Map<string, string>,
  onStatus: (label: string) => void
): Promise<string> {
  const matches = [...markdown.matchAll(SHOT_RE)];
  if (matches.length === 0) return markdown;

  let out = markdown;
  let shot = 0;
  for (const m of matches) {
    const [marker, videoId, ts, caption] = m;
    const localPath = localPathById.get(videoId);
    if (!localPath) {
      // Not capturable (e.g. YouTube member) — keep the moment as a citation.
      out = out.replace(marker, `[TS:${videoId}:${ts}]`);
      continue;
    }
    shot++;
    onStatus(`Capturing screenshot ${shot} (${ts})…`);
    try {
      const dataUrl = await captureFrame(localPath, tsToSec(ts));
      const filename = `shot-${shot}.png`;
      const dir = await reportDir(reportId);
      await writeFile(await join(dir, filename), dataUrlToBytes(dataUrl));
      const rel = `${REPORTS_DIR}/${reportId}/${filename}`;
      out = out.replace(
        marker,
        `![${caption.trim()}](${rel})\n*${caption.trim()} — [TS:${videoId}:${ts}]*`
      );
    } catch {
      out = out.replace(marker, `[TS:${videoId}:${ts}]`);
    }
  }
  return out;
}

/** Rewrite stored relative image paths into loadable asset URLs for display. */
export function resolveReportImages(markdown: string, appData: string): string {
  return markdown.replace(
    /\]\((reports\/[^\s)]+)\)/g,
    (_m, rel) => `](${convertFileSrc(`${appData}/${rel}`)})`
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Inline every stored report screenshot as a base64 data URL. */
async function inlineReportImages(markdown: string): Promise<string> {
  const rels = [...markdown.matchAll(/\]\((reports\/[^\s)]+)\)/g)].map((m) => m[1]);
  let out = markdown;
  for (const rel of rels) {
    try {
      const bytes = await readFile(await reportImageAbsPath(rel));
      out = out.replace(`](${rel})`, `](data:image/png;base64,${bytesToBase64(bytes)})`);
    } catch {
      // Missing image — leave the relative path; the export still reads fine.
    }
  }
  return out;
}

/** Flatten app citation chips into plain readable text for export. */
function flattenCitations(markdown: string, videoNames: Record<string, string>): string {
  return markdown
    .replace(/\[TS:\s*([\w-]+)\s*:\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\]/g, (_m, vid, ts) => {
      const name = videoNames[vid];
      return name ? `*(${name} @ ${ts})*` : `*(@ ${ts})*`;
    })
    .replace(/\[FILE:\s*([^:\]\s]+)\s*:\s*(\S+)\s*\]/g, "`$1: $2`")
    .replace(
      /\[COMMIT:\s*([^:\]\s]+)\s*:\s*([0-9a-f]{6,40})\s*\]/gi,
      (_m, repo, sha) => `\`${repo}@${String(sha).slice(0, 7)}\``
    );
}

const EXPORT_CSS = `
  body { max-width: 860px; margin: 2rem auto; padding: 0 1.2rem;
    font: 16px/1.65 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1c1c28; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.2rem; margin-top: 1.6rem; }
  img { max-width: 100%; border: 1px solid #ddd; border-radius: 8px; }
  code { background: #f0f0f4; padding: 0.1rem 0.3rem; border-radius: 4px;
    font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 0.85em; }
  pre code { display: block; padding: 0.8rem; overflow-x: auto; }
  em { color: #555; }
`;

/**
 * Export a report as a single self-contained HTML file (screenshots inlined
 * as data URLs, citation chips flattened to text). Opens a save dialog;
 * returns the chosen path, or null if the user cancelled.
 */
export async function exportReportHtml(
  report: Report,
  videoNames: Record<string, string>
): Promise<string | null> {
  const safeName = report.title.replace(/[^\w\s-]+/g, "").trim().replace(/\s+/g, "-");
  const path = await save({
    defaultPath: `${safeName || "report"}.html`,
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (!path) return null;

  const md = flattenCitations(await inlineReportImages(report.markdown), videoNames);
  const body = marked.parse(md) as string;
  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>${report.title}</title><style>${EXPORT_CSS}</style></head>` +
    `<body>${body}</body></html>`;
  await writeFile(path, new TextEncoder().encode(html));
  return path;
}

export interface GenerateReportOptions {
  apiKey: string;
  projectId: string;
  /** User-supplied or proposed generation prompt. */
  prompt: string;
  /** Optional explicit title; the report's # heading wins if present. */
  title: string;
  projectContext: string;
  repoNames: string[];
  videos: ProjectChatVideo[];
  /** Video id → local file path, for screenshot capture. */
  localPathById: Map<string, string>;
  /** Library ids of the sources consulted (project members at run time). */
  sourceIds: string[];
  execute: ToolExecutor;
  onToolCall: ToolReporter;
  onStatus: (label: string) => void;
}

/**
 * The one report-generation mechanism used by both the New-report button
 * and chat-approved proposals: run the agentic report writer, process
 * [SHOT] markers into saved screenshots, persist, and return the report.
 */
export async function generateAndSaveReport(opts: GenerateReportOptions): Promise<Report> {
  opts.onStatus("Researching sources…");
  // Reports use their own high research budget, independent of the
  // user-configurable chat tool-turn setting.
  const reply = await generateProjectReport(
    opts.apiKey, opts.prompt, opts.projectContext, opts.repoNames,
    opts.videos, opts.execute, opts.onToolCall, REPORT_MAX_TOOL_TURNS
  );

  const reportId = crypto.randomUUID();
  const markdown = await processShots(
    reply.text, reportId, opts.localPathById, opts.onStatus
  );

  const report: Report = {
    id: reportId,
    title: titleFromMarkdown(markdown) ?? (opts.title.trim() || "Untitled report"),
    markdown,
    prompt: opts.prompt,
    createdAt: new Date().toISOString(),
    costUsd: reply.usage.costUsd,
    sourceIds: opts.sourceIds,
  };
  await addReport(opts.projectId, report);
  return report;
}
