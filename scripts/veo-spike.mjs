// Phase 0 spike (docs/studio-roadmap.md): check which video-generation
// models are available to this API key. Free — only lists models.
// Usage: GEMINI_API_KEY=... node scripts/veo-spike.mjs
const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("Set GEMINI_API_KEY");
  process.exit(1);
}

const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${key}`
);
if (!res.ok) {
  console.error("List models failed:", res.status, await res.text());
  process.exit(1);
}
const { models } = await res.json();
const interesting = models.filter(
  (m) =>
    /veo|video|omni/i.test(m.name) ||
    (m.supportedGenerationMethods ?? []).some((g) => /video/i.test(g))
);
for (const m of interesting) {
  console.log(m.name);
  console.log("  methods:", (m.supportedGenerationMethods ?? []).join(", "));
  if (m.description) console.log("  desc:", m.description.slice(0, 120));
}
if (interesting.length === 0) console.log("No video-capable models found.");
