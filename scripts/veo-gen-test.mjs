// Phase 0 spike: one real text-to-video generation on veo-3.1-lite.
// Measures generation time, prints operation/response shape, downloads
// the MP4 to /tmp/veo-lite-test.mp4. THIS COSTS MONEY (one Veo request).
// Usage: GEMINI_API_KEY=... node scripts/veo-gen-test.mjs
import { writeFile } from "node:fs/promises";

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("Set GEMINI_API_KEY");
  process.exit(1);
}

const MODEL = "veo-3.1-lite-generate-preview";
const BASE = "https://generativelanguage.googleapis.com/v1beta";

const started = Date.now();
const startRes = await fetch(
  `${BASE}/models/${MODEL}:predictLongRunning?key=${key}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [
        { prompt: "A pink flamingo standing in shallow turquoise water, gentle ripples, golden hour light, cinematic" },
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
await writeFile("/tmp/veo-lite-test.mp4", bytes);
console.log(`Saved /tmp/veo-lite-test.mp4 (${(bytes.length / 1e6).toFixed(1)} MB)`);
