import type { Page } from "playwright-core";
import { config, X_BASE } from "./config.js";
import { createStagehand } from "./browser/session.js";
import { loadContextId, verifyLoggedIn } from "./browser/auth.js";
import { installCapture, readExactCounts, harvestList, loadList } from "./scrape/followGraph.js";

/**
 * `scan` — the M1 read pipeline. Resumable + rate-limit-aware harvest of /following + /followers.
 *
 * Run it as many times as needed: each run loads saved progress, grabs as much as X allows before
 * throttling, and persists. When both lists report complete=true, the data is ready for scoring (M2).
 * Designed so a rate-limited run is normal — just re-run after a cooldown to continue.
 */
export async function runScan(): Promise<void> {
  const contextId = loadContextId();
  if (!contextId) {
    console.error("No Context found. Run `pnpm auth` first.");
    process.exitCode = 1;
    return;
  }

  const stagehand = await createStagehand({ contextId, persist: false });
  try {
    const page = stagehand.context.pages()[0] as unknown as Page;
    await installCapture(page); // before any navigation

    if (!(await verifyLoggedIn(page))) {
      console.warn("⚠ Could not confirm login. Continuing; if nothing is captured, run `pnpm auth`.");
    }

    // Exact counts from the profile header (reliable; comma-separated, not abbreviated).
    await page.goto(`${X_BASE}/${config.xHandle}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    const exact = await readExactCounts(page);
    console.log(`Exact counts → following: ${exact.following ?? "?"}, followers: ${exact.followers ?? "?"}\n`);

    // Followers first: small + fast, and its completeness is what the scoring gate depends on.
    console.log("Harvesting /followers...");
    const followers = await harvestList(page, "followers", exact.followers ?? null);
    console.log("\nHarvesting /following...");
    const following = await harvestList(page, "following", exact.following ?? null);

    console.log("\n========== SCAN STATUS ==========");
    for (const d of [following, followers]) {
      const pct = d.exact ? `${Math.round((d.count / d.exact) * 100)}%` : "?";
      console.log(`${d.list.padEnd(10)} ${String(d.count).padStart(6)} / ${String(d.exact ?? "?").padStart(6)} (${pct})  ${d.complete ? "✅ complete" : "⏳ partial — re-run after cooldown"}`);
    }
    const done = following.complete && followers.complete;
    console.log("--------------------------------");
    console.log(done
      ? "✅ Both lists complete. Data saved to data/. Ready for scoring (M2)."
      : "⏳ Not complete (rate limit). Re-run `pnpm scan` after ~30–60 min; it resumes from saved progress.");
    console.log("================================\n");
  } finally {
    await stagehand.close();
  }
}

/**
 * Autonomous harvest: re-run scan with cooldowns until BOTH lists are complete (or max rounds).
 * Survives per-session CDP drops / throttling — each round resumes from saved progress.
 * Run in the background (`pnpm harvest`) and leave it; it stops itself when done.
 */
export async function runScanUntilDone(): Promise<void> {
  const maxRounds = 40;
  const cooldownSec = Number(process.env.HARVEST_COOLDOWN_SEC ?? 150);
  for (let round = 1; round <= maxRounds; round++) {
    console.log(`\n===================== HARVEST ROUND ${round}/${maxRounds} =====================`);
    try {
      await runScan();
    } catch (err) {
      console.warn(`round ${round} errored: ${(err as Error).message}`);
    }
    const f = loadList("following");
    const fo = loadList("followers");
    console.log(`progress: following ${f?.count ?? 0}/${f?.exact ?? "?"} (${f?.complete ? "done" : "…"}), followers ${fo?.count ?? 0}/${fo?.exact ?? "?"} (${fo?.complete ? "done" : "…"})`);
    if (f?.complete && fo?.complete) {
      console.log(`\n✅✅ HARVEST COMPLETE after ${round} rounds. Run \`pnpm score\` then \`pnpm report\`.`);
      return;
    }
    if (round < maxRounds) {
      console.log(`cooldown ${cooldownSec}s before next round...`);
      await new Promise((r) => setTimeout(r, cooldownSec * 1000));
    }
  }
  console.log("\nReached max rounds. Re-run `pnpm harvest` to continue from saved progress.");
}
