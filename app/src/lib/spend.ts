import { load, type Store } from "@tauri-apps/plugin-store";

/**
 * Lifetime spend tracker. Every billed Gemini call records its estimated
 * cost here, so the running total survives re-summarizes, cleared chats,
 * and replaced diagrams. Resettable from Settings.
 */

const STORE_FILE = "spend.json";
const KEY_TOTAL = "totalUsd";
const KEY_SINCE = "since";

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE);
  return storePromise;
}

export interface SpendInfo {
  totalUsd: number;
  /** ISO timestamp of the last reset (or first tracked spend). */
  since: string | null;
}

export async function loadSpend(): Promise<SpendInfo> {
  const store = await getStore();
  return {
    totalUsd: (await store.get<number>(KEY_TOTAL)) ?? 0,
    since: (await store.get<string>(KEY_SINCE)) ?? null,
  };
}

/** Add a billed cost to the lifetime total. Fire-and-forget safe. */
export async function trackSpend(usd: number): Promise<void> {
  if (!(usd > 0)) return;
  const store = await getStore();
  const total = (await store.get<number>(KEY_TOTAL)) ?? 0;
  await store.set(KEY_TOTAL, total + usd);
  if (!(await store.get<string>(KEY_SINCE))) {
    await store.set(KEY_SINCE, new Date().toISOString());
  }
  await store.save();
}

/** Reset the tracker to zero, restarting the "since" clock. */
export async function resetSpend(): Promise<void> {
  const store = await getStore();
  await store.set(KEY_TOTAL, 0);
  await store.set(KEY_SINCE, new Date().toISOString());
  await store.save();
}
