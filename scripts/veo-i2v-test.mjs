// Phase 0 spike (final gate): one real image-to-video generation on
// veo-3.1-lite, conditioning on a local PNG/JPEG sent as inline base64.
// THIS COSTS MONEY (one Veo request, ~$0.40 for 8s @ 720p lite).
// Usage: GEMINI_API_KEY=... node scripts/veo-i2v-test.mjs <image-path> [motion prompt]
import { readFile, writeFile } from "node:fs/promises";

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("Set GEMINI_API_KEY");
  process.exit(1);
}
const imagePath = process.argv[2];
if (!imagePath) {
  console.error("Usage: node scripts/veo-i2v-test.mjs <image-path> [motion prompt]");
  process.exit(1);
}
const prompt =
  process.argv.slice(3).join(" ") ||
  "The scene comes to life with gentle, natural motion. Cinematic.";

const MODEL = "veo-3.1-lite-generate-preview";
const BASE = "https://generativelanguage.googleapis.com/v1beta";

const imgBytes = await readFile(imagePath);
const mimeType = imagePath.toLowerCase().endsWith(".jpg") || imagePath.toLowerCase().endsWith(".jpeg")
  ? "image/jpeg"
  : "image/png";
console.log(`Image: ${imagePath} (${(imgBytes.length / 1024).toFixed(0)} KB, ${mimeType})`);

const started = Date.now();
const startRes = await fetch(
  `${BASE}/models/${MODEL}:predictLongRunning?key=${key}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [
        {
          prompt,
          image: {
            bytesBase64Encoded: imgBytes.toString("base64"),
            mimeType,
          },
        },
      ],
    }),
  }
);
if (!startRes.ok) {
  console.error("Start failed:", startRes.status, await startRes.text());
  process.exit(1);
}
const op = await startRes.json();
console.log("Operation:", op.name);

let result;
for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  const pollRes = await fetch(`${BASE}/${op.name}?key=${key}`);
  const poll = await pollRes.json();
  process.stdout.write(".");
  if (poll.error) {
    console.error("\nOperation error:", JSON.stringify(poll.error, null, 2));
    process.exit(1);
  }
  if (poll.done) {
    result = poll;
    break;
  }
}
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nDone in ${secs}s`);
console.log("Response shape:", JSON.stringify(result.response, null, 2).slice(0, 2000));

const video =
  result.response?.generateVideoResponse?.generatedSamples?.[0]?.video ??
  result.response?.generatedVideos?.[0]?.video;
const uri = video?.uri;
if (!uri) {
  console.log("No video URI found — inspect the shape above.");
  process.exit(0);
}
const dl = await fetch(uri.includes("key=") ? uri : `${uri}&key=${key}`);
const bytes = Buffer.from(await dl.arrayBuffer());
await writeFile("/tmp/veo-i2v-test.mp4", bytes);
console.log(`Saved /tmp/veo-i2v-test.mp4 (${(bytes.length / 1e6).toFixed(1)} MB)`);
