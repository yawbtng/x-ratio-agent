// Regenerate functions/droplist.ts from data/scored.json (the DROP recommendations).
// Run after re-harvesting + re-scoring to refresh the function's target set:
//   node scripts/gen-droplist.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scoredPath = path.join(root, "data", "scored.json");

// Empty-safe: before you've scanned+scored, there's no scored.json yet. Still write a valid
// (empty) droplist.ts so `functions/main.ts` compiles and `npx bb publish` doesn't break.
let uniq = [];
if (fs.existsSync(scoredPath)) {
  const scored = JSON.parse(fs.readFileSync(scoredPath, "utf8"));
  // ONLY_SCORED=1 keeps only DROPs that carry a real LLM relevance score. Use it when a scoring
  // run degraded (e.g. an expired ANTHROPIC_API_KEY 401s and score.ts falls back to notability
  // alone) — otherwise accounts get unfollowed on no information at all, which is exactly what the
  // KEEP-what-you-care-about goal is trying to avoid. Drop the flag once scoring is healthy again.
  const onlyScored = process.env.ONLY_SCORED === "1";
  const all = (scored.accounts ?? []).filter((a) => a.recommendedAction === "DROP");
  const kept = onlyScored ? all.filter((a) => a.relevance !== null) : all;
  if (onlyScored) {
    console.log(`ONLY_SCORED=1 → ${kept.length} of ${all.length} DROPs have a relevance score (${all.length - kept.length} unscored held back)`);
  }
  uniq = [...new Set(kept.map((a) => a.handle.toLowerCase()))].sort();
} else {
  console.log("no data/scored.json yet — writing an empty droplist.ts (run scan + score first)");
}

const out =
  "// AUTO-GENERATED from data/scored.json (DROP recommendations). Do not edit by hand.\n" +
  "// Regenerate: node scripts/gen-droplist.mjs\n" +
  "// The function walks /following and unfollows only handles in this set that are STILL followed,\n" +
  "// so it is naturally idempotent/resumable — already-unfollowed accounts have left the list.\n" +
  `export const DROP: string[] = ${JSON.stringify(uniq)};\n`;

fs.writeFileSync(path.join(root, "functions", "droplist.ts"), out);
console.log(`wrote functions/droplist.ts with ${uniq.length} handles`);
