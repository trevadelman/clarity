import { GoogleGenAI } from "@google/genai";

export const DEFAULT_PROMPT =
  "This video is a whiteboard working session with a person narrating. " +
  "Produce a structured summary: (1) the main topic, (2) key points and " +
  "decisions in order, (3) any action items or open questions raised, " +
  "(4) a short description of what's drawn on the whiteboard and how it " +
  "evolves. Use the spoken audio as the primary source and the whiteboard " +
  "visuals as support.";

export type ModelId = "gemini-2.5-flash" | "gemini-2.5-pro";

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

export interface SummaryResult {
  text: string;
  usage: TokenUsage;
}

/** Generate a summary from an already-ACTIVE file. */
export async function generateSummary(
  apiKey: string,
  file: GeminiFile,
  prompt: string,
  model: ModelId,
  onStatus: (s: Status) => void
): Promise<SummaryResult> {
  const ai = client(apiKey);
  onStatus("generating");
  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { fileData: { fileUri: file.uri, mimeType: file.mimeType } },
          { text: prompt },
        ],
      },
    ],
  });
  const text = response.text;
  if (!text) throw new Error("No summary text returned from Gemini.");

  const meta = response.usageMetadata;
  const inputTokens = meta?.promptTokenCount ?? 0;
  const outputTokens = meta?.candidatesTokenCount ?? 0;
  const usage: TokenUsage = {
    inputTokens,
    outputTokens,
    costUsd: estimateCost(model, inputTokens, outputTokens),
  };

  onStatus("done");
  return { text, usage };
}

/** Delete a file from the Gemini File API. */
export async function deleteFile(apiKey: string, name: string): Promise<void> {
  const ai = client(apiKey);
  await ai.files.delete({ name });
}
