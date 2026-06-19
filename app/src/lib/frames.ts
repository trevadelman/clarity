import { convertFileSrc } from "@tauri-apps/api/core";
import { GIFEncoder, quantize, applyPalette } from "gifenc";

// Screenshots are captured at (near) native resolution for crisp stills.
const SCREENSHOT_MAX_WIDTH = 1920;
// GIFs stay smaller to keep the animated file size reasonable.
const GIF_MAX_WIDTH = 720;
// Frames sent to the image model as reference material.
const SAMPLE_MAX_WIDTH = 768;
const GIF_FPS = 10;
const GIF_MAX_SECONDS = 6;
const SEEK_TIMEOUT_MS = 10000;

/** Load a local video element ready for seeking, sized down to MAX_WIDTH. */
function loadVideo(localPath: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.src = convertFileSrc(localPath);
    const timer = setTimeout(
      () => reject(new Error("Timed out loading video for capture.")),
      SEEK_TIMEOUT_MS
    );
    // HAVE_CURRENT_DATA (2) means at least the current frame is decodable and
    // the video is ready to be seeked reliably.
    video.addEventListener(
      "loadeddata",
      () => {
        clearTimeout(timer);
        resolve(video);
      },
      { once: true }
    );
    video.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("Failed to load video."));
      },
      { once: true }
    );
  });
}

function scaledSize(video: HTMLVideoElement, maxWidth: number): { w: number; h: number } {
  const scale = video.videoWidth > maxWidth ? maxWidth / video.videoWidth : 1;
  return {
    w: Math.round(video.videoWidth * scale) || maxWidth,
    h: Math.round(video.videoHeight * scale) || Math.round(maxWidth * 0.5625),
  };
}

/**
 * Wait until the frame for the current `currentTime` is actually decoded and
 * painted before we read pixels. `requestVideoFrameCallback` fires only once a
 * new frame is presented, which prevents capturing a stale frame — the usual
 * cause of a "static" GIF where every frame is identical.
 */
function waitForFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const rvfc = (video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    }).requestVideoFrameCallback;
    if (typeof rvfc === "function") rvfc.call(video, done);
    else requestAnimationFrame(() => requestAnimationFrame(done));
    // `requestVideoFrameCallback` only fires while frames are being presented,
    // which a paused/seeked video may never do — always cap the wait so a
    // capture can't hang indefinitely.
    setTimeout(done, 120);
  });
}

/** Clamp a requested time into the valid, seekable range of the video. */
function clampTime(video: HTMLVideoElement, sec: number): number {
  const duration = Number.isFinite(video.duration) ? video.duration : sec;
  // Stay a hair short of the very end; seeking exactly to `duration` often
  // never fires `seeked` in WebKit.
  const max = Math.max(0, duration - 0.05);
  return Math.min(Math.max(0, sec), max);
}

/**
 * Seek the video to a time and resolve once the frame is ready. Guards against
 * the `seeked` event never firing (a known WebKit issue) with a timeout, and
 * resolves immediately if we're already at the target time.
 */
function seekTo(video: HTMLVideoElement, sec: number): Promise<void> {
  const target = clampTime(video, sec);
  return new Promise((resolve, reject) => {
    if (Math.abs(video.currentTime - target) < 0.01 && video.readyState >= 2) {
      resolve();
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out seeking video to ${target.toFixed(1)}s.`));
    }, SEEK_TIMEOUT_MS);
    video.addEventListener("seeked", onSeeked, { once: true });
    video.currentTime = target;
  });
}

function releaseVideo(video: HTMLVideoElement): void {
  video.removeAttribute("src");
  video.load();
}

/** Capture a single PNG frame at `atSec`, returned as a data URL. */
export async function captureFrame(localPath: string, atSec: number): Promise<string> {
  const video = await loadVideo(localPath);
  try {
    const { w, h } = scaledSize(video, SCREENSHOT_MAX_WIDTH);
    await seekTo(video, atSec);
    await waitForFrame(video);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not available.");
    ctx.drawImage(video, 0, 0, w, h);
    return canvas.toDataURL("image/png");
  } finally {
    releaseVideo(video);
  }
}

/** Capture an animated GIF for [startSec, endSec], returned as a data URL. */
export async function captureGif(
  localPath: string,
  startSec: number,
  endSec: number
): Promise<string> {
  const video = await loadVideo(localPath);
  try {
    const { w, h } = scaledSize(video, GIF_MAX_WIDTH);
    const duration = Math.min(Math.max(endSec - startSec, 0.5), GIF_MAX_SECONDS);
    const frameCount = Math.max(2, Math.round(duration * GIF_FPS));
    const delayMs = Math.round(1000 / GIF_FPS);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas not available.");

    const gif = GIFEncoder();
    for (let i = 0; i < frameCount; i++) {
      const t = startSec + (duration * i) / (frameCount - 1);
      await seekTo(video, t);
      // Ensure the seeked frame is actually decoded before we read it, so each
      // GIF frame is distinct rather than a repeat of the first.
      await waitForFrame(video);
      ctx.drawImage(video, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      const palette = quantize(data, 256);
      const index = applyPalette(data, palette);
      // gifenc defaults to `repeat: -1` (play once). Set `repeat: 0` on the
      // first frame to write the Netscape loop extension so the GIF animates
      // forever instead of freezing on the last frame.
      gif.writeFrame(index, w, h, i === 0 ? { palette, delay: delayMs, repeat: 0 } : { palette, delay: delayMs });
    }
    gif.finish();

    const bytes = gif.bytes();
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return `data:image/gif;base64,${btoa(binary)}`;
  } finally {
    releaseVideo(video);
  }
}

/**
 * Capture `count` evenly-spaced still frames across the whole video as raw
 * base64 PNG strings (no data-URL prefix), suitable for sending to an image
 * model as inline reference material. Frames are sampled between 5% and 95% of
 * the duration to avoid black intro/outro frames.
 */
export async function sampleFrames(
  localPath: string,
  count: number
): Promise<{ base64: string; mimeType: string }[]> {
  const video = await loadVideo(localPath);
  try {
    const { w, h } = scaledSize(video, SAMPLE_MAX_WIDTH);
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration <= 0) return [];

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not available.");

    const start = duration * 0.05;
    const span = duration * 0.9;
    const frames: { base64: string; mimeType: string }[] = [];
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? duration / 2 : start + (span * i) / (count - 1);
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, w, h);
      const base64 = canvas.toDataURL("image/png").split(",")[1] ?? "";
      frames.push({ base64, mimeType: "image/png" });
    }
    return frames;
  } finally {
    releaseVideo(video);
  }
}
