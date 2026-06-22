// Regenerate functions/droplist.ts from data/scored.json (the DROP recommendations).
// Run after re-harvesting + re-scoring to refresh the function's target set:
//   node scripts/gen-droplist.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scored = JSON.parse(fs.readFileSync(path.join(root, "data", "scored.json"), "utf8"));

const drops = scored.accounts
  .filter((a) => a.recommendedAction === "DROP")
  .map((a) => a.handle.toLowerCase());
const uniq = [...new Set(drops)].sort();

const out =
  "// AUTO-GENERATED from data/scored.json (DROP recommendations). Do not edit by hand.\n" +
  "// Regenerate: node scripts/gen-droplist.mjs\n" +
  "// The function walks /following and unfollows only handles in this set that are STILL followed,\n" +
  "// so it is naturally idempotent/resumable — already-unfollowed accounts have left the list.\n" +
  `export const DROP: string[] = ${JSON.stringify(uniq)};\n`;

fs.writeFileSync(path.join(root, "functions", "droplist.ts"), out);
console.log(`wrote functions/droplist.ts with ${uniq.length} handles`);
