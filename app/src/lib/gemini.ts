import {
  GoogleGenAI, Type,
  type FunctionDeclaration, type GenerateContentResponse,
} from "@google/genai";
import { trackSpend } from "./spend";

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

export type ModelId = "gemini-3.5-flash";

/** Image model used for diagram generation (separate from the text models). */
export const IMAGE_MODEL = "gemini-3.1-flash-image";

/** Flat USD cost per generated diagram image (adjust if Google changes pricing). */
export const IMAGE_COST_PER_IMAGE = 0.04;

export interface ModelInfo {
  id: ModelId;
  label: string;
  /** USD per 1M input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens (thinking tokens bill at this rate too). */
  outputPerM: number;
  /** USD per 1M cached input tokens (implicit context caching). */
  cachedPerM: number;
}


/**
 * The app always uses the flagship flash model. Published per-1M-token rates
 * (USD) — easy to update if Google changes pricing.
 */
export const MODELS: Record<ModelId, ModelInfo> = {
  "gemini-3.5-flash": {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    inputPerM: 1.5,
    outputPerM: 9.0,
    cachedPerM: 0.15,
  },
};

export const DEFAULT_MODEL: ModelId = "gemini-3.5-flash";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Estimate cost in USD from token counts for a given model. */
export function estimateCost(
  model: ModelId,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0
): number {
  const info = MODELS[model] ?? MODELS[DEFAULT_MODEL];
  return (
    ((inputTokens - cachedTokens) / 1_000_000) * info.inputPerM +
    (cachedTokens / 1_000_000) * info.cachedPerM +
    (outputTokens / 1_000_000) * info.outputPerM
  );
}

/**
 * Extract billed token usage from a response. Input tokens that hit the
 * implicit context cache bill at the cheaper cached rate; thinking tokens
 * bill as output.
 */
function usageFromResponse(model: ModelId, response: GenerateContentResponse): TokenUsage {
  const meta = response.usageMetadata;
  const inputTokens = meta?.promptTokenCount ?? 0;
  const cachedTokens = meta?.cachedContentTokenCount ?? 0;
  const outputTokens = (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0);
  const costUsd = estimateCost(model, inputTokens, outputTokens, cachedTokens);
  void trackSpend(costUsd);
  return { inputTokens, outputTokens, costUsd };
}

export type Status = "idle" | "uploading" | "processing" | "generating" | "done" | "error";

/**
 * Compose the effective prompt from a base prompt plus optional per-video
 * custom instructions. Used for both summary and diagram generation.
 */
export function composePrompt(basePrompt: string, extra: string | null): string {
  const trimmed = extra?.trim();
  if (!trimmed) return basePrompt;
  return `${basePrompt}\n\nAdditional instructions for this specific video:\n${trimmed}`;
}

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

/** A highlight moment Gemini suggests turning into a screenshot. */
export interface HighlightSpec {
  label: string;
  /** The single moment to capture, in seconds. */
  atSec: number;
}



export interface SummaryResult {
  text: string;
  highlights: HighlightSpec[];
  usage: TokenUsage;
}

const HIGHLIGHT_INSTRUCTIONS =
  "Also identify 3-8 of the most instructive moments worth capturing as still " +
  "SCREENSHOTS — key static frames such as a finished diagram, an important " +
  "result on screen, or a pivotal step. For each, set `atSec` to the exact " +
  "moment in seconds and give it a concise label.";

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
          atSec: { type: "number", description: "Screenshot moment (seconds)." },
        },
        required: ["label", "atSec"],
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

  // YouTube sources are referenced by URL alone; File API uploads carry a
  // mimeType. Omit an empty mimeType so the API accepts the URL form.
  const fileData = file.mimeType
    ? { fileUri: file.uri, mimeType: file.mimeType }
    : { fileUri: file.uri };

  const response = await ai.models.generateContent({
    model,
    config,
    contents: [
      {
        role: "user",
        parts: [{ fileData }, { text: promptText }],
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

  onStatus("done");
  return { text, highlights, usage: usageFromResponse(model, response) };
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
 * Generate a conceptual learning diagram with the image model, grounded in the
 * written summary plus locally-sampled reference frames. The video itself is
 * NOT sent: the image model rejects audio-bearing input, and the summary
 * already captures the session's content.
 */
export async function generateDiagram(
  apiKey: string,
  summary: string,
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
          { text: `Written summary of the session:\n\n${summary}` },
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
      void trackSpend(IMAGE_COST_PER_IMAGE);
      return { image: `data:${mime};base64,${data}`, costUsd: IMAGE_COST_PER_IMAGE };
    }
  }
  throw new Error("No diagram image returned from Gemini.");
}

/** A report the model has proposed mid-chat, awaiting user approval. */
export interface ReportProposal {
  title: string;
  prompt: string;
  /** Set once the user acts on the proposal. */
  status?: "pending" | "generated" | "dismissed";
  /** Report id once generated. */
  reportId?: string;
}

/** One turn in a stored chat thread. */
export interface ChatMessage {
  role: "user" | "model";
  text: string;
  /** ISO timestamp when the message was created. */
  at: string;
  /** Cost of producing this model message (user messages: undefined). */
  costUsd?: number;
  /** Research steps taken to produce this message (repo chats only). */
  toolCalls?: string[];
  /** Report proposed via the propose_report tool (project chats only). */
  reportProposal?: ReportProposal;
}

const CHAT_SYSTEM_PROMPT =
  "You are a helpful assistant answering questions about a specific video. " +
  "Prefer grounding answers in the provided video context. When you reference " +
  "a moment in the video, include its timestamp in the exact form [mm:ss] or " +
  "[h:mm:ss] so the app can link it.\n\n" +
  "You MAY draw on your general knowledge to answer questions that go beyond " +
  "the video (comparisons, alternatives, background, 'what would X look " +
  "like'), and you should do so willingly — but clearly mark that shift, e.g. " +
  "by prefacing with 'Beyond the video:' or noting 'the video doesn't cover " +
  "this, but…'. Never present general knowledge as something said in the " +
  "video. Keep answers concise and use Markdown.";

export interface ChatReply {
  text: string;
  usage: TokenUsage;
  /** Research steps taken (repo chats only). */
  toolCalls?: string[];
  /** Report proposal captured during the turn (project chats only). */
  reportProposal?: ReportProposal;
}

/**
 * Answer a question about a video. The conversation is grounded in the
 * written summary by default; when `file` is provided the video itself is
 * attached so Gemini can search moments the summary may not capture.
 */
export async function generateChatReply(
  apiKey: string,
  question: string,
  history: ChatMessage[],
  summary: string,
  videoName: string,
  file: GeminiFile | null,
  model: ModelId = DEFAULT_MODEL
): Promise<ChatReply> {
  const ai = client(apiKey);

  const contextParts: object[] = [];
  if (file) {
    const fileData = file.mimeType
      ? { fileUri: file.uri, mimeType: file.mimeType }
      : { fileUri: file.uri };
    contextParts.push({ fileData });
  }
  contextParts.push({
    text:
      `Video: ${videoName}\n\n` +
      (summary
        ? `Written summary of the video:\n\n${summary}`
        : "No summary is available; rely on the attached video."),
  });

  const contents = [
    { role: "user", parts: contextParts },
    { role: "model", parts: [{ text: "Understood. Ask me anything about this video." }] },
    ...history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    { role: "user", parts: [{ text: question }] },
  ];

  const response = await ai.models.generateContent({
    model,
    config: { systemInstruction: CHAT_SYSTEM_PROMPT },
    contents,
  });

  const text = response.text;
  if (!text) throw new Error("No answer returned from Gemini.");
  return { text, usage: usageFromResponse(model, response) };
}

const DIGEST_SYSTEM_PROMPT =
  "You are a senior engineer explaining recent changes in a codebase to a " +
  "teammate. You are given commit messages and their diffs. Produce a clear " +
  "Markdown digest of WHAT CHANGED, grouped by theme (features, refactors, " +
  "fixes, docs, chores) rather than commit-by-commit. Call out anything " +
  "risky, breaking, or worth reviewing. Reference files by path in backticks " +
  "and commits by their short sha in backticks where helpful. Be concrete " +
  "and concise — a teammate should read this in two minutes.";

/**
 * Summarize a set of commit diffs into a change digest. Pure text call —
 * cheap. Diffs should already be truncated to sane sizes by the caller.
 */
export async function generateChangeDigest(
  apiKey: string,
  repoLabel: string,
  commits: { sha: string; message: string; author: string; date: string; patches: string[] }[],
  model: ModelId = DEFAULT_MODEL
): Promise<ChatReply> {
  const ai = client(apiKey);

  const body = commits
    .map(
      (c) =>
        `=== COMMIT ${c.sha.slice(0, 7)} · ${c.author} · ${c.date}\n` +
        `${c.message}\n\nDIFF:\n${c.patches.join("\n\n")}`
    )
    .join("\n\n\n");

  const response = await ai.models.generateContent({
    model,
    config: { systemInstruction: DIGEST_SYSTEM_PROMPT },
    contents: [
      {
        role: "user",
        parts: [{ text: `Repository: ${repoLabel}\n\n${body}` }],
      },
    ],
  });

  const text = response.text;
  if (!text) throw new Error("No digest returned from Gemini.");
  return { text, usage: usageFromResponse(model, response) };
}

const LIBRARY_CHAT_SYSTEM_PROMPT =
  "You are a helpful assistant answering questions across a user's library of " +
  "video summaries. Ground answers in the provided summaries whenever " +
  "possible.\n\n" +
  "CITATIONS: every video in the context has an ID. When your answer draws on " +
  "a video, cite it with a marker in the exact form [VIDEO:<id>] — or " +
  "[VIDEO:<id> @ mm:ss] when the summary gives you a specific moment — so the " +
  "app can render a link to that video. Cite every video you draw from.\n\n" +
  "You MAY draw on general knowledge for questions beyond the library, but " +
  "clearly mark that shift (e.g. 'Beyond the library: …'). Keep answers " +
  "concise and use Markdown.";

/** Minimal video info the library chat needs for context + citations. */
export interface LibraryChatVideo {
  id: string;
  name: string;
  tags: string[];
  summary: string;
}

/**
 * Answer a question across the whole library. Context is the concatenated
 * summaries (text-only — cheap). Answers cite videos via [VIDEO:id] markers.
 */
export async function generateLibraryChatReply(
  apiKey: string,
  question: string,
  history: ChatMessage[],
  videos: LibraryChatVideo[],
  model: ModelId = DEFAULT_MODEL
): Promise<ChatReply> {
  const ai = client(apiKey);

  const context = videos
    .map(
      (v) =>
        `=== VIDEO ID: ${v.id}\nTitle: ${v.name}\n` +
        (v.tags.length ? `Tags: ${v.tags.join(", ")}\n` : "") +
        `Summary:\n${v.summary}`
    )
    .join("\n\n");

  const contents = [
    { role: "user", parts: [{ text: `Video library summaries:\n\n${context}` }] },
    { role: "model", parts: [{ text: "Understood. Ask me anything about the library." }] },
    ...history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    { role: "user", parts: [{ text: question }] },
  ];

  const response = await ai.models.generateContent({
    model,
    config: { systemInstruction: LIBRARY_CHAT_SYSTEM_PROMPT },
    contents,
  });

  const text = response.text;
  if (!text) throw new Error("No answer returned from Gemini.");
  return { text, usage: usageFromResponse(model, response) };
}

const REPO_CHAT_SYSTEM_PROMPT =
  "You are a senior engineer answering questions about a GitHub repository. " +
  "You have LIVE read access to the repo through the provided tools: listing " +
  "commits, reading commit diffs, reading files, listing directories, and " +
  "searching code. Use them whenever the provided context does not fully " +
  "answer the question — do not guess about code you can read.\n\n" +
  "You are also given the repo's metadata and any saved change digests " +
  "(pre-computed AI summaries of selected commit ranges). Treat digests as " +
  "helpful background, not ground truth — verify against the repo when it " +
  "matters.\n\n" +
  "Reference files by path and commits by short sha in backticks. Answer in " +
  "concise Markdown. If something is not covered by the context and cannot be " +
  "found with the tools, say so plainly.\n\n" +
  "CITATIONS: when your answer draws on a specific file, cite it with a marker " +
  "in the exact form [FILE:path/from/repo/root] and when it draws on a specific " +
  "commit use [COMMIT:sha]. Place markers inline where relevant so the app can " +
  "render clickable links. Cite every file and commit you drew from.";

const REPO_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "list_commits",
    description:
      "List commits on the repo's default branch over a recent window (most recent first).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        since_days: {
          type: Type.NUMBER,
          description: "How many days back to look, e.g. 7 or 30.",
        },
      },
      required: ["since_days"],
    },
  },
  {
    name: "get_commit_diff",
    description: "Get a commit's message, stats, and per-file unified diffs.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        sha: { type: Type.STRING, description: "The commit sha (full or short)." },
      },
      required: ["sha"],
    },
  },
  {
    name: "read_file",
    description: "Read a file's current content from the default branch.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: "File path from repo root, e.g. src/lib/media.ts" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_directory",
    description: "List the entries of a directory. Use an empty string for the repo root.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: "Directory path from repo root, or '' for root." },
      },
      required: ["path"],
    },
  },
  {
    name: "search_code",
    description: "Search the repo's code for a term; returns matching file paths with fragments.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Search term, e.g. a function or type name." },
      },
      required: ["query"],
    },
  },
];

/** Executes one named tool call and returns a JSON-serializable result. */
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** Reports a tool call for UI purposes (label plus the raw call details). */
export type ToolReporter = (
  label: string,
  name: string,
  args: Record<string, unknown>
) => void;

/** Minimal digest info the repo chat needs for context. */
export interface RepoChatDigest {
  label: string;
  generatedAt: string;
  text: string;
}

/** Fallback research-turn budget when the caller doesn't pass one. */
const DEFAULT_TOOL_TURNS = 15;

/**
 * Reports get a much higher research budget than chat: the writer needs
 * the agency to walk many files/commits before drafting. High ceiling
 * (rather than none) so a looping model can't burn unbounded spend.
 */
export const REPORT_MAX_TOOL_TURNS = 100;

/** Everything one agentic chat run needs beyond the shared loop mechanics. */
interface AgenticChatSpec {
  systemInstruction: string;
  toolDeclarations: FunctionDeclaration[];
  /** Seed turns (context + primer) placed before the history. */
  seed: object[];
  /** Human-readable label for a tool call, shown in the chat UI. */
  describe: (name: string, args: Record<string, unknown>) => string;
  /** Error when the turn budget runs out without an answer. */
  exceededMessage: string;
}

/**
 * Shared agentic function-calling loop: ask Gemini, execute any requested
 * tools, feed results back, repeat until it answers (or the turn budget
 * runs out). Tracks token usage/cost across all turns.
 */
async function runAgenticChat(
  apiKey: string,
  question: string,
  history: ChatMessage[],
  spec: AgenticChatSpec,
  execute: ToolExecutor,
  onToolCall: ToolReporter,
  maxToolTurns: number,
  model: ModelId
): Promise<ChatReply> {
  const ai = client(apiKey);

  const contents: object[] = [
    ...spec.seed,
    ...history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    { role: "user", parts: [{ text: question }] },
  ];

  const config = {
    systemInstruction: spec.systemInstruction,
    tools: [{ functionDeclarations: spec.toolDeclarations }],
  };

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  const toolCalls: string[] = [];

  for (let turn = 0; turn <= maxToolTurns; turn++) {
    const response = await ai.models.generateContent({ model, config, contents });

    const meta = response.usageMetadata;
    inputTokens += meta?.promptTokenCount ?? 0;
    outputTokens += (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0);
    cachedTokens += meta?.cachedContentTokenCount ?? 0;

    const calls = response.functionCalls;
    if (!calls || calls.length === 0) {
      const text = response.text;
      if (!text) throw new Error("No answer returned from Gemini.");
      const costUsd = estimateCost(model, inputTokens, outputTokens, cachedTokens);
      void trackSpend(costUsd);
      return { text, usage: { inputTokens, outputTokens, costUsd }, toolCalls };
    }

    // Append the model's turn verbatim (preserves thought signatures), then
    // execute each requested tool and reply with matching-id responses.
    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);

    const responseParts: object[] = [];
    for (const call of calls) {
      const name = call.name ?? "";
      const args = (call.args ?? {}) as Record<string, unknown>;
      const label = spec.describe(name, args);
      toolCalls.push(label);
      onToolCall(label, name, args);
      let result: unknown;
      try {
        result = await execute(name, args);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      responseParts.push({
        functionResponse: { name, id: call.id, response: { result } },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  throw new Error(spec.exceededMessage);
}

/**
 * Agentic repo Q&A: Gemini can call GitHub research tools (via `execute`)
 * in a loop before answering. `onToolCall` reports activity for the UI;
 * `maxToolTurns` caps how many research rounds are allowed.
 */
export function generateRepoChatReply(
  apiKey: string,
  question: string,
  history: ChatMessage[],
  repoContext: string,
  digests: RepoChatDigest[],
  execute: ToolExecutor,
  onToolCall: ToolReporter = () => {},
  maxToolTurns: number = DEFAULT_TOOL_TURNS,
  model: ModelId = DEFAULT_MODEL
): Promise<ChatReply> {
  const digestText = digests.length
    ? digests
        .map((d) => `## Digest (${d.label}, ${d.generatedAt})\n\n${d.text}`)
        .join("\n\n")
    : "(no saved change digests yet)";

  const spec: AgenticChatSpec = {
    systemInstruction: REPO_CHAT_SYSTEM_PROMPT,
    toolDeclarations: REPO_TOOL_DECLARATIONS,
    seed: [
      {
        role: "user",
        parts: [{ text: `${repoContext}\n\nSaved change digests:\n\n${digestText}` }],
      },
      { role: "model", parts: [{ text: "Understood. Ask me anything about this repository." }] },
    ],
    describe: describeToolCall,
    exceededMessage: "Repo research exceeded the tool-call limit without an answer.",
  };
  return runAgenticChat(apiKey, question, history, spec, execute, onToolCall, maxToolTurns, model);
}

/** Human-readable label for a tool call, shown in the chat UI. */
function describeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "list_commits": return `Listing commits from the last ${args.since_days} days…`;
    case "get_commit_diff": return `Reading commit ${String(args.sha).slice(0, 7)}…`;
    case "read_file": return `Reading ${args.path}…`;
    case "list_directory": return `Browsing ${args.path || "repo root"}…`;
    case "search_code": return `Searching code for “${args.query}”…`;
    default: return `Running ${name}…`;
  }
}

const PROJECT_CHAT_SYSTEM_PROMPT =
  "You are a senior engineer working inside a PROJECT: a workspace over a " +
  "chosen set of sources — GitHub repositories and videos (attached as " +
  "media). Answer questions by combining them: watch the attached videos " +
  "for what was said/shown, and use the live repo tools to read the actual " +
  "code. Every repo tool takes a `repo` parameter naming which member " +
  "repository to act on — only the listed repos are available.\n\n" +
  "Use the tools whenever the context does not fully answer the question — " +
  "do not guess about code you can read. Treat any provided digests as " +
  "background, not ground truth.\n\n" +
  "CITATIONS (use these exact forms so the app can render clickable " +
  "links):\n" +
  "- Video moment: [TS:<videoId>:mm:ss] (always include the video id — " +
  "there may be several videos).\n" +
  "- File: [FILE:<repo>:path/from/root]\n" +
  "- Commit: [COMMIT:<repo>:sha]\n" +
  "Cite every video moment, file, and commit you draw from. Answer in " +
  "concise Markdown. If something cannot be found in the sources or with " +
  "the tools, say so plainly.";

/** Repo tool declarations with a `repo` parameter constrained to members. */
function projectToolDeclarations(repoNames: string[]): FunctionDeclaration[] {
  const repoParam = {
    type: Type.STRING,
    description: `Which member repository to act on. One of: ${repoNames.join(", ")}`,
    enum: repoNames,
  };
  return REPO_TOOL_DECLARATIONS.map((d) => ({
    ...d,
    parameters: {
      type: Type.OBJECT,
      properties: { repo: repoParam, ...(d.parameters?.properties ?? {}) },
      required: ["repo", ...(d.parameters?.required ?? [])],
    },
  }));
}

/** A video attached to a project chat. */
export interface ProjectChatVideo {
  id: string;
  name: string;
  file: GeminiFile;
  summary: string | null;
}

/**
 * Agentic project Q&A: videos are attached as media, and Gemini can research
 * every member repo through `repo`-parameterized GitHub tools. The executor
 * receives the `repo` argument and routes to the right repository.
 */
export function generateProjectChatReply(
  apiKey: string,
  question: string,
  history: ChatMessage[],
  projectContext: string,
  repoNames: string[],
  videos: ProjectChatVideo[],
  execute: ToolExecutor,
  onToolCall: ToolReporter = () => {},
  maxToolTurns: number = DEFAULT_TOOL_TURNS,
  model: ModelId = DEFAULT_MODEL
): Promise<ChatReply> {
  const seedParts = projectSeedParts(videos, projectContext);

  // Intercept propose_report locally: record the proposal, tell the model
  // it's awaiting approval, and let the loop continue to a final answer.
  let proposal: ReportProposal | undefined;
  const executeWithProposal: ToolExecutor = async (name, args) => {
    if (name === "propose_report") {
      proposal = {
        title: String(args.title ?? "Untitled report"),
        prompt: String(args.prompt ?? ""),
        status: "pending",
      };
      return {
        status: "awaiting_user_approval",
        note:
          "The proposal is now shown to the user with Generate/Dismiss " +
          "buttons. Do not call propose_report again; briefly tell the user " +
          "what the report would cover and that it awaits their approval.",
      };
    }
    return execute(name, args);
  };

  const spec: AgenticChatSpec = {
    systemInstruction:
      PROJECT_CHAT_SYSTEM_PROMPT +
      "\n\nREPORTS: you can propose a written report with the propose_report " +
      "tool. It only ASKS the user — never assume the report exists. Propose " +
      "one when the user asks for a report or when one would clearly help.",
    toolDeclarations: [...projectToolDeclarations(repoNames), PROPOSE_REPORT_DECLARATION],
    seed: [
      { role: "user", parts: seedParts },
      { role: "model", parts: [{ text: "Understood. Ask me anything about this project." }] },
    ],
    describe: describeProjectToolCall,
    exceededMessage: "Project research exceeded the tool-call limit without an answer.",
  };
  return runAgenticChat(
    apiKey, question, history, spec, executeWithProposal, onToolCall, maxToolTurns, model
  ).then((reply) => (proposal ? { ...reply, reportProposal: proposal } : reply));
}

/** Seed parts shared by project chat and report generation. */
function projectSeedParts(videos: ProjectChatVideo[], projectContext: string): object[] {
  const seedParts: object[] = [];
  for (const v of videos) {
    const fileData = v.file.mimeType
      ? { fileUri: v.file.uri, mimeType: v.file.mimeType }
      : { fileUri: v.file.uri };
    seedParts.push({ fileData });
    seedParts.push({
      text:
        `The media above is video "${v.name}" (videoId: ${v.id}).` +
        (v.summary ? `\nIts written summary:\n${v.summary}` : ""),
    });
  }
  seedParts.push({ text: projectContext });
  return seedParts;
}

/** Human-readable label for a project tool call, shown in the chat UI. */
function describeProjectToolCall(name: string, args: Record<string, unknown>): string {
  if (name === "propose_report") return `Proposing report “${args.title}”…`;
  const repo = args.repo ? `${args.repo}: ` : "";
  return `${repo}${describeToolCall(name, args)}`;
}

/**
 * The chat can PROPOSE a report but never generate one on its own — the
 * tool records the proposal and immediately returns an "awaiting approval"
 * result. The UI renders an approval card; generation only happens when
 * the user explicitly clicks Generate.
 */
const PROPOSE_REPORT_DECLARATION: FunctionDeclaration = {
  name: "propose_report",
  description:
    "Propose generating a written report over the project's sources. This does " +
    "NOT generate anything — it asks the user for approval. Use it when the " +
    "user asks for a report or when one would clearly help. Provide a concise " +
    "title and the full generation prompt (instructions describing what the " +
    "report should cover).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "Concise report title." },
      prompt: {
        type: Type.STRING,
        description: "Full instructions for what the report should cover and how.",
      },
    },
    required: ["title", "prompt"],
  },
};

/** Default purpose prompt for the New-report flow (editable by the user). */
export const DEFAULT_REPORT_PROMPT =
  "Cross-reference the project's videos against its repositories. For each " +
  "claim, decision, or demonstration in the videos, verify it against the " +
  "actual code and commits: does the implementation match what was said? " +
  "Walk through the material thematically, citing the exact video moments " +
  "and the files/commits that substantiate (or contradict) them. Call out " +
  "anything shown in a video that has since changed in the code, and " +
  "anything in the code the videos never mention but a reader should know.";

const PROJECT_REPORT_SYSTEM_PROMPT =
  "You are a senior engineer writing a REPORT over a project's sources — " +
  "GitHub repositories (via live tools) and videos (attached as media). " +
  "Research thoroughly with the tools before writing: read the relevant " +
  "files and commits rather than guessing. Every repo tool takes a `repo` " +
  "parameter naming which member repository to act on.\n\n" +
  "When you are done researching, output ONLY the final report as " +
  "well-structured Markdown with a # title heading, using these exact " +
  "citation forms so the app can render clickable links:\n" +
  "- Video moment: [TS:<videoId>:mm:ss]\n" +
  "- File: [FILE:<repo>:path/from/root]\n" +
  "- Commit: [COMMIT:<repo>:sha]\n\n" +
  "SCREENSHOTS: mark up to 8 illustration-worthy video moments with a " +
  "marker on its own line in the exact form [SHOT:<videoId>:mm:ss caption " +
  "text]. The app replaces each with a captured still from that video. Use " +
  "them where a visual genuinely helps (a finished diagram, a key screen, " +
  "a pivotal step).\n\n" +
  "Be concrete and complete — the report should stand alone for someone " +
  "who never watched the videos or read the code.";

/**
 * Generate a project report: same agentic loop and sources as project chat,
 * but driven by a report-writer prompt. Returns the raw markdown (with
 * [SHOT:…] markers still in place — the caller runs the screenshot pass).
 */
export function generateProjectReport(
  apiKey: string,
  reportPrompt: string,
  projectContext: string,
  repoNames: string[],
  videos: ProjectChatVideo[],
  execute: ToolExecutor,
  onToolCall: ToolReporter = () => {},
  maxToolTurns: number = DEFAULT_TOOL_TURNS,
  model: ModelId = DEFAULT_MODEL
): Promise<ChatReply> {
  const seedParts = projectSeedParts(videos, projectContext);
  const spec: AgenticChatSpec = {
    systemInstruction: PROJECT_REPORT_SYSTEM_PROMPT,
    toolDeclarations: projectToolDeclarations(repoNames),
    seed: [
      { role: "user", parts: seedParts },
      { role: "model", parts: [{ text: "Understood. Give me the report instructions." }] },
    ],
    describe: describeProjectToolCall,
    exceededMessage: "Report research exceeded the tool-call limit without a result.",
  };
  return runAgenticChat(apiKey, reportPrompt, [], spec, execute, onToolCall, maxToolTurns, model);
}

const PAGE_CHAT_SYSTEM_PROMPT =
  "You are a helpful assistant answering questions about the web page the " +
  "user currently has open. You have LIVE read access to that page through " +
  "the provided tools: page metadata, readable text, raw HTML, the user's " +
  "text selection, and the page's links. Use them — start with get_page_text " +
  "or get_page_meta rather than guessing. The page may be a JS-rendered app; " +
  "the tools see the live DOM, not the original source.\n\n" +
  "You can also NAVIGATE the user's visible tab with navigate_to — e.g. to " +
  "follow a link found via get_page_links when the user asks what's there, " +
  "or to do lightweight research across a site's pages. Navigation happens " +
  "in the user's own tab where they can see it, so navigate only in service " +
  "of the user's question, keep hops to a few, and return to answering " +
  "promptly. Only http(s) URLs are allowed.\n\n" +
  "You MAY draw on general knowledge beyond the page, but clearly mark that " +
  "shift (e.g. 'Beyond this page: …'). Keep answers concise and use Markdown.";

const PAGE_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "get_page_meta",
    description: "Get the open page's title, URL, meta description, and language.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_page_text",
    description:
      "Get the readable text content of the open page (live DOM, includes JS-rendered content).",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_page_html",
    description:
      "Get the open page's current DOM as HTML. Large; prefer get_page_text unless markup/attributes matter.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_selection",
    description: "Get the text the user currently has selected on the page, if any.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_page_links",
    description: "List the hyperlinks on the open page as {text, href} pairs.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "navigate_to",
    description:
      "Navigate the user's visible tab to a new http(s) URL and wait for it to load. " +
      "Returns the landing page's metadata; use the read tools afterwards for content.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "Absolute http(s) URL to open." },
      },
      required: ["url"],
    },
  },
];

/**
 * Agentic page Q&A: Gemini pulls what it needs from the live page via the
 * extraction tools (executed by the caller against the active browse tab).
 */
export function generatePageChatReply(
  apiKey: string,
  question: string,
  history: ChatMessage[],
  pageLabel: string,
  pageUrl: string,
  execute: ToolExecutor,
  onToolCall: ToolReporter = () => {},
  maxToolTurns: number = DEFAULT_TOOL_TURNS,
  model: ModelId = DEFAULT_MODEL
): Promise<ChatReply> {
  const spec: AgenticChatSpec = {
    systemInstruction: PAGE_CHAT_SYSTEM_PROMPT,
    toolDeclarations: PAGE_TOOL_DECLARATIONS,
    seed: [
      { role: "user", parts: [{ text: `Open page: ${pageLabel}\nURL: ${pageUrl}` }] },
      { role: "model", parts: [{ text: "Understood. Ask me anything about this page." }] },
    ],
    describe: describePageToolCall,
    exceededMessage: "Page research exceeded the tool-call limit without an answer.",
  };
  return runAgenticChat(apiKey, question, history, spec, execute, onToolCall, maxToolTurns, model);
}

/** Human-readable label for a page tool call, shown in the chat UI. */
function describePageToolCall(name: string, args: Record<string, unknown> = {}): string {
  switch (name) {
    case "navigate_to": return `Navigating to ${args.url}…`;
    case "get_page_meta": return "Reading page details…";
    case "get_page_text": return "Reading page content…";
    case "get_page_html": return "Reading page HTML…";
    case "get_selection": return "Reading your selection…";
    case "get_page_links": return "Scanning page links…";
    default: return `Running ${name}…`;
  }
}

/** Delete a file from the Gemini File API. */
export async function deleteFile(apiKey: string, name: string): Promise<void> {
  const ai = client(apiKey);
  await ai.files.delete({ name });
}
