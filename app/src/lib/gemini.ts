import { GoogleGenAI } from "@google/genai";

export const DEFAULT_PROMPT =
  "You are creating a COMPREHENSIVE written overview of this video — not a " +
  "short summary. The goal is that someone who never watched it could read " +
  "your output and understand essentially everything that was said, shown, " +
  "and decided, in full detail.\n\n" +
  "Walk through the video chronologically and capture the complete narrative: " +
  "every topic introduced, the reasoning and explanations given (not just the " +
  "conclusions), concrete examples, numbers, names, and terminology used, and " +
  "how ideas build on one another. Do not compress or omit content for the " +
  "sake of brevity — err on the side of thoroughness and length.\n\n" +
  "Structure it with clear Markdown headings and subheadings as the material " +
  "warrants. Include these where applicable:\n" +
  "- An opening overview of the main topic and purpose.\n" +
  "- A detailed, section-by-section walkthrough following the video's flow, " +
  "preserving the depth of each explanation.\n" +
  "- Any decisions made, along with the rationale behind them.\n" +
  "- All action items, open questions, or unresolved points raised.\n" +
  "- A description of anything drawn, written, or shown visually (e.g. a " +
  "whiteboard or screen) and how it evolves over time.\n\n" +
  "Use the spoken audio as the primary source and the visuals as supporting " +
  "detail. Prefer completeness over conciseness.";

export type ModelId = "gemini-2.5-flash" | "gemini-2.5-pro";

/** Image model used for diagram generation (separate from the text models). */
export const IMAGE_MODEL = "gemini-3.1-flash-image";

/** Flat USD cost per generated diagram image (adjust if Google changes pricing). */
export const IMAGE_COST_PER_IMAGE = 0.04;

export interface ModelInfo {
  id: ModelId;
  label: string;
  /** USD per 1M input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
}


/**
 * Published per-1M-token rates (USD) as of 2025. Easy to update if Google
 * changes pricing. Pro uses its <=200k-token input tier.
 */
export const MODELS: Record<ModelId, ModelInfo> = {
  "gemini-2.5-flash": {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    inputPerM: 0.3,
    outputPerM: 2.5,
  },
  "gemini-2.5-pro": {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    inputPerM: 1.25,
    outputPerM: 10.0,
  },
};

export const DEFAULT_MODEL: ModelId = "gemini-2.5-flash";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Estimate cost in USD from token counts for a given model. */
export function estimateCost(
  model: ModelId,
  inputTokens: number,
  outputTokens: number
): number {
  const info = MODELS[model] ?? MODELS[DEFAULT_MODEL];
  return (
    (inputTokens / 1_000_000) * info.inputPerM +
    (outputTokens / 1_000_000) * info.outputPerM
  );
}

export type Status = "idle" | "uploading" | "processing" | "generating" | "done" | "error";

export interface GeminiFile {
  name: string;
  uri: string;
  mimeType: string;
  displayName: string;
  state: string;
  sizeBytes?: number;
  createTime?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function client(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey });
}

/** List previously-uploaded files still held by the Gemini File API. */
export async function listFiles(apiKey: string): Promise<GeminiFile[]> {
  const ai = client(apiKey);
  const out: GeminiFile[] = [];
  const pager = await ai.files.list({ config: { pageSize: 100 } });
  for await (const f of pager) {
    if (!f.name || !f.uri || !f.mimeType) continue;
    out.push({
      name: f.name,
      uri: f.uri,
      mimeType: f.mimeType,
      displayName: f.displayName ?? f.name,
      state: String(f.state ?? "UNKNOWN"),
      sizeBytes: f.sizeBytes ? Number(f.sizeBytes) : undefined,
      createTime: f.createTime ? String(f.createTime) : undefined,
    });
  }
  return out;
}

/** Fetch current state of a Gemini file, or null if it no longer exists. */
export async function getFileState(
  apiKey: string,
  name: string
): Promise<GeminiFile | null> {
  const ai = client(apiKey);
  try {
    const f = await ai.files.get({ name });
    if (!f.name || !f.uri || !f.mimeType) return null;
    return {
      name: f.name,
      uri: f.uri,
      mimeType: f.mimeType,
      displayName: f.displayName ?? f.name,
      state: String(f.state ?? "UNKNOWN"),
      sizeBytes: f.sizeBytes ? Number(f.sizeBytes) : undefined,
      createTime: f.createTime ? String(f.createTime) : undefined,
    };
  } catch {
    return null;
  }
}

/** Upload bytes and poll until the file reaches ACTIVE. */
export async function uploadAndWait(
  apiKey: string,
  bytes: Uint8Array,
  mimeType: string,
  displayName: string,
  onStatus: (s: Status) => void
): Promise<GeminiFile> {
  const ai = client(apiKey);

  onStatus("uploading");
  const blob = new Blob([bytes as BlobPart], { type: mimeType });
  let file = await ai.files.upload({ file: blob, config: { mimeType, displayName } });

  onStatus("processing");
  const deadline = Date.now() + 10 * 60 * 1000;
  while (file.state === "PROCESSING") {
    if (Date.now() > deadline) throw new Error("Timed out waiting for file to become ACTIVE.");
    await sleep(3000);
    file = await ai.files.get({ name: file.name as string });
  }
  if (file.state !== "ACTIVE") throw new Error(`File processing failed (state=${file.state}).`);

  return {
    name: file.name as string,
    uri: file.uri as string,
    mimeType: file.mimeType as string,
    displayName: file.displayName ?? displayName,
    state: String(file.state),
  };
}

/** A highlight moment Gemini suggests turning into a screenshot or short GIF. */
export interface HighlightSpec {
  label: string;
  kind: "screenshot" | "gif";
  /** For screenshots: the single moment in seconds. */
  atSec?: number;
  /** For GIFs: the clip's start in seconds. */
  startSec?: number;
  /** For GIFs: the clip's end in seconds. */
  endSec?: number;
}

export interface SummaryResult {
  text: string;
  highlights: HighlightSpec[];
  usage: TokenUsage;
}

const HIGHLIGHT_INSTRUCTIONS =
  "Also identify 3-8 of the most instructive moments worth capturing as a " +
  "still SCREENSHOT (a key static frame, e.g. a finished diagram or an " +
  "important result on screen). Give each a concise label and use seconds " +
  "from the start of the video for the `atSec` timestamp.";

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "The full structured summary in Markdown.",
    },
    highlights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          kind: { type: "string", enum: ["screenshot"] },
          atSec: { type: "number" },
        },
        required: ["label", "kind", "atSec"],
      },
    },
  },
  required: ["summary", "highlights"],
};

/**
 * Combined call: returns the Markdown summary plus (optionally) structured
 * highlight moments in a single request, so the video's input tokens are only
 * paid for once.
 */
export async function generateSummary(
  apiKey: string,
  file: GeminiFile,
  prompt: string,
  model: ModelId,
  onStatus: (s: Status) => void,
  withHighlights = false
): Promise<SummaryResult> {
  const ai = client(apiKey);
  onStatus("generating");

  const promptText = withHighlights
    ? `${prompt}\n\n${HIGHLIGHT_INSTRUCTIONS}`
    : prompt;

  const config = withHighlights
    ? { responseMimeType: "application/json", responseSchema: SUMMARY_SCHEMA as object }
    : undefined;

  const response = await ai.models.generateContent({
    model,
    config,
    contents: [
      {
        role: "user",
        parts: [
          { fileData: { fileUri: file.uri, mimeType: file.mimeType } },
          { text: promptText },
        ],
      },
    ],
  });

  const raw = response.text;
  if (!raw) throw new Error("No summary text returned from Gemini.");

  let text = raw;
  let highlights: HighlightSpec[] = [];
  if (withHighlights) {
    const parsed = JSON.parse(raw) as { summary?: string; highlights?: HighlightSpec[] };
    text = parsed.summary ?? "";
    highlights = Array.isArray(parsed.highlights) ? parsed.highlights : [];
    if (!text) throw new Error("No summary text returned from Gemini.");
  }

  const meta = response.usageMetadata;
  const inputTokens = meta?.promptTokenCount ?? 0;
  const outputTokens = meta?.candidatesTokenCount ?? 0;
  const usage: TokenUsage = {
    inputTokens,
    outputTokens,
    costUsd: estimateCost(model, inputTokens, outputTokens),
  };

  onStatus("done");
  return { text, highlights, usage };
}

export interface DiagramResult {
  /** PNG image as a data URL. */
  image: string;
  costUsd: number;
}

export const DEFAULT_DIAGRAM_PROMPT =
  "Create a single, clean CONCEPTUAL diagram that helps someone LEARN the key " +
  "ideas from this session — a teaching aid, not a screenshot recreation.\n\n" +
  "GOAL: Organize the underlying concepts into a clear visual structure (flow, " +
  "hierarchy, mental model, or labeled schematic — whichever best fits the " +
  "material). Prioritize conceptual clarity and pedagogical value over visual " +
  "fidelity to the recording.\n\n" +
  "STRICT RULES:\n" +
  "- Do NOT reproduce the literal scene, recording, or screen capture.\n" +
  "- NEVER include operating-system or desktop chrome of any kind: no macOS/" +
  "Windows dock, taskbar, menu bar, traffic-light window buttons, wallpaper, " +
  "cursor, browser tabs, or notification badges.\n" +
  "- Do NOT invent placeholder tokens, file names, ports, or labels like " +
  "'<IMAGE_1>' that were not actually discussed.\n" +
  "- You MAY use the video/frames as reference ONLY to get the aesthetic of a " +
  "specific UI component or artifact being demonstrated correct (e.g. the look " +
  "of a button, panel, or form that is the subject of teaching) — but render it " +
  "as a clean, isolated, idealized element, never embedded in OS chrome.\n" +
  "- Use legible labels, clear arrows/grouping, and a tidy layout suitable for " +
  "teaching.\n\n" +
  "Output only the image.";

/**
 * Generate a conceptual learning diagram from an already-ACTIVE file using the
 * image model. Optionally include locally-sampled reference frames so the model
 * can match the aesthetic of demonstrated UI without re-ingesting the whole
 * video, and a user-customized prompt.
 */
export async function generateDiagram(
  apiKey: string,
  file: GeminiFile,
  prompt: string = DEFAULT_DIAGRAM_PROMPT,
  frames: { base64: string; mimeType: string }[] = []
): Promise<DiagramResult> {
  const ai = client(apiKey);
  const frameParts = frames.map((f) => ({
    inlineData: { data: f.base64, mimeType: f.mimeType },
  }));
  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { fileData: { fileUri: file.uri, mimeType: file.mimeType } },
          ...frameParts,
          { text: prompt },
        ],
      },
    ],
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const data = part.inlineData?.data;
    if (data) {
      const mime = part.inlineData?.mimeType ?? "image/png";
      return { image: `data:${mime};base64,${data}`, costUsd: IMAGE_COST_PER_IMAGE };
    }
  }
  throw new Error("No diagram image returned from Gemini.");
}

/** Delete a file from the Gemini File API. */
export async function deleteFile(apiKey: string, name: string): Promise<void> {
  const ai = client(apiKey);
  await ai.files.delete({ name });
}
