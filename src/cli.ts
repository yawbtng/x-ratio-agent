import { runLogin } from "./browser/auth.js";
import { runSpike0 } from "./spikes/spike0-pagination.js";
import { runScan, runScanUntilDone } from "./scan.js";
import { runScore } from "./score.js";
import { runReport } from "./report.js";
import { runUnfollow } from "./unfollow.js";

const command = process.argv[2];

const commands: Record<string, () => void | Promise<void>> = {
  login: runLogin,
  spike0: runSpike0,
  scan: runScan,
  harvest: runScanUntilDone,
  score: async () => void (await runScore()),
  report: runReport,
  unfollow: runUnfollow,
};

async function main(): Promise<void> {
  const run = command ? commands[command] : undefined;
  if (!run) {
    console.log("Usage: pnpm cli <command>");
    console.log("Commands:");
    console.log("  login    Interactive X login → persists a Browserbase Context");
    console.log("  spike0   Verify X lets you page the whole following/followers list");
    console.log("  scan     Resumable harvest of following + followers → data/ (re-run to continue)");
    console.log("  score    Compute follows-back + recommendations → data/scored.json");
    console.log("  report   Ratio summary + who-to-unfollow CSV (data/report-<date>.csv)");
    console.log("  unfollow Dry-run unfollow plan (add -- --execute to act; respects daily cap)");
    process.exitCode = 1;
    return;
  }
  await run();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
