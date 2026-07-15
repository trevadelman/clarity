import { load, type Store } from "@tauri-apps/plugin-store";
import { DEFAULT_PROMPT, DEFAULT_DIAGRAM_PROMPT } from "./gemini";

const STORE_FILE = "settings.json";
const KEY_API = "geminiApiKey";
const KEY_PROMPT = "summaryPrompt";
const KEY_DIAGRAM_PROMPT = "diagramPrompt";

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE);
  return storePromise;
}

export async function loadApiKey(): Promise<string> {
  const store = await getStore();
  return (await store.get<string>(KEY_API)) ?? "";
}

export async function saveApiKey(key: string): Promise<void> {
  const store = await getStore();
  await store.set(KEY_API, key);
  await store.save();
}

export async function loadPrompt(): Promise<string> {
  const store = await getStore();
  return (await store.get<string>(KEY_PROMPT)) ?? DEFAULT_PROMPT;
}

export async function savePrompt(prompt: string): Promise<void> {
  const store = await getStore();
  await store.set(KEY_PROMPT, prompt);
  await store.save();
}

export async function loadDiagramPrompt(): Promise<string> {
  const store = await getStore();
  return (await store.get<string>(KEY_DIAGRAM_PROMPT)) ?? DEFAULT_DIAGRAM_PROMPT;
}

export async function saveDiagramPrompt(prompt: string): Promise<void> {
  const store = await getStore();
  await store.set(KEY_DIAGRAM_PROMPT, prompt);
  await store.save();
}
