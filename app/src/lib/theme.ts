import { writable } from "svelte/store";

export type Theme = "light" | "dark";

const KEY = "theme";

function initial(): Theme {
  if (typeof localStorage !== "undefined") {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
  }
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "dark";
}

export const theme = writable<Theme>("dark");

/** Apply the theme to <html> and persist it. Call from the layout on mount. */
export function applyTheme(value: Theme) {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = value;
  }
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(KEY, value);
  }
}

export function initTheme() {
  const value = initial();
  theme.set(value);
  applyTheme(value);
}

export function toggleTheme() {
  theme.update((t) => {
    const next: Theme = t === "dark" ? "light" : "dark";
    applyTheme(next);
    return next;
  });
}
