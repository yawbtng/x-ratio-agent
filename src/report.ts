import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { runScore, type ScoreResult } from "./score.js";

/**
 * M2 report — turns scored accounts into (1) a CSV you edit to approve unfollows, and
 * (2) a terminal summary built for a demo: the before/after ratio is the visual hook.
 */

// Read the scored snapshot; if missing, compute it (the expensive LLM step lives in `score`).
async function loadScored(): Promise<ScoreResult> {
  try {
    return JSON.parse(fs.readFileSync(config.paths.scoredFile, "utf8")) as ScoreResult;
  } catch {
    return runScore();
  }
}

function writeCsv(result: ScoreResult): string {
  const rows = [
    "handle,name,follows_back,verified,followers,relevance,recommended_action,reason,approved",
    ...result.accounts.map(
      (a) =>
        `${a.handle},"${(a.name || "").replace(/"/g, "'")}",${a.followsBack},${a.verified},${a.followers ?? ""},${a.relevance ?? ""},${a.recommendedAction},"${a.reason}",`,
    ),
  ];
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(config.paths.dataDir, `report-${date}.csv`);
  fs.writeFileSync(file, rows.join("\n"));
  return file;
}

export async function runReport(): Promise<void> {
  const r = await loadScored();

  const mutuals = r.accounts.filter((a) => a.followsBack).length;
  const nonFollowers = r.accounts.filter((a) => !a.followsBack).length;
  const target = config.targetFollowing;
  const needToDrop = Math.max(0, r.followingCount - target); // minimum unfollows to hit target
  const keepBudget = Math.max(0, target - mutuals); // non-followers you can KEEP and still be under target

  const csv = writeCsv(r);

  console.log("\n┌──────────────────────────────────────────────┐");
  console.log("│           X RATIO REPORT                       │");
  console.log("└──────────────────────────────────────────────┘");
  console.log(`  Following:  ${r.followingCount}${r.followingComplete ? "" : " (partial — harvest not finished)"}`);
  console.log(`  Followers:  ${r.followersCount}`);
  console.log(`  Goal:       get following under ${target}`);
  console.log("  ─────────────────────────────────────────────");
  console.log(`  Mutuals (always keep):     ${mutuals}`);
  console.log(`  Non-followers:             ${nonFollowers}`);
  console.log("  ─────────────────────────────────────────────");
  console.log(`  ➜ To hit under ${target}: unfollow at least ${needToDrop}.`);
  console.log(`  ➜ Keep budget: you can KEEP up to ~${keepBudget} non-followers you care about`);
  console.log(`     and still land under ${target}. Drop the other ~${Math.max(0, nonFollowers - keepBudget)}.`);
  console.log("  ─────────────────────────────────────────────");
  console.log("  Drop candidates (non-followers — trim the ones you want to keep):");
  for (const a of r.accounts.filter((x) => x.recommendedAction === "DROP").slice(0, 10)) {
    console.log(`      @${a.handle}  —  ${a.reason}`);
  }
  if (!r.followingComplete) {
    console.log(`\n  ⚠ Following list still harvesting — re-run after it completes for the full list.`);
  }
  console.log(`\n  CSV (edit 'approved'=yes to queue unfollows): ${csv}\n`);
}
