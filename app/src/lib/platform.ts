/**
 * Platform detection, evaluated synchronously at module load so callers
 * can branch without layout flashes. The webview's `navigator.platform`
 * reports "MacIntel" on both Intel and Apple Silicon Macs.
 */
export const isMac =
  typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");
