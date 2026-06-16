import { convertFileSrc } from "@tauri-apps/api/core";

export interface VideoProbe {
  /** JPEG poster frame as a data URL, or null if capture failed. */
  thumbnail: string | null;
  /** Duration in seconds, or null if unknown. */
  durationSec: number | null;
}

/**
 * Load a local video via the asset protocol, seek to ~10%, and grab a poster
 * frame plus its duration. Runs entirely in the webview's DOM.
 */
export function probeVideo(localPath: string): Promise<VideoProbe> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    video.crossOrigin = "anonymous";
    video.src = convertFileSrc(localPath);

    const done = (probe: VideoProbe) => {
      video.removeAttribute("src");
      video.load();
      resolve(probe);
    };

    let duration: number | null = null;

    video.addEventListener("loadedmetadata", () => {
      duration = Number.isFinite(video.duration) ? video.duration : null;
      const target = duration ? Math.min(duration * 0.1, 3) : 0;
      video.currentTime = target;
    });

    video.addEventListener("seeked", () => {
      const canvas = document.createElement("canvas");
      const maxW = 640;
      const scale = video.videoWidth > maxW ? maxW / video.videoWidth : 1;
      canvas.width = Math.round(video.videoWidth * scale) || maxW;
      canvas.height = Math.round(video.videoHeight * scale) || Math.round(maxW * 0.5625);
      const ctx = canvas.getContext("2d");
      if (!ctx) return done({ thumbnail: null, durationSec: duration });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      done({ thumbnail: canvas.toDataURL("image/jpeg", 0.7), durationSec: duration });
    });

    video.addEventListener("error", () => done({ thumbnail: null, durationSec: duration }));
  });
}

export function formatDuration(sec: number | null): string | null {
  if (sec == null || !Number.isFinite(sec)) return null;
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
