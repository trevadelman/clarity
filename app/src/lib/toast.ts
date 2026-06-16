import { writable } from "svelte/store";

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

export const toasts = writable<Toast[]>([]);

let nextId = 1;

export function pushToast(message: string, kind: ToastKind = "info", ms = 2600) {
  const id = nextId++;
  toasts.update((list) => [...list, { id, message, kind }]);
  setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number) {
  toasts.update((list) => list.filter((t) => t.id !== id));
}

export const toast = {
  success: (m: string) => pushToast(m, "success"),
  error: (m: string) => pushToast(m, "error", 4000),
  info: (m: string) => pushToast(m, "info"),
};
