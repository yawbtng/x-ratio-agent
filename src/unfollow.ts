import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import type { Stagehand } from "@browserbasehq/stagehand";
import { config, X_BASE } from "./config.js";
import { createStagehand } from "./browser/session.js";
import { loadContextId, verifyLoggedIn } from "./browser/auth.js";
import type { ScoreResult } from "./score.js";

/**
 * M3 — automated unfollow (the write path; gated + safety-railed because it touches the real account).
 *
 *   pnpm unfollow                 dry-run: show exactly what it WOULD unfollow (default, safe)
 *   pnpm unfollow -- --execute    actually unfollow (respects daily cap)
 *   pnpm unfollow -- --max 25     cap THIS run
 *   pnpm unfollow -- --use-recommendations   target all DROP rows from scored.json (else: approved=yes CSV rows)
 *
 * Safety: dry-run default · persisted daily cap · randomized pacing · verify-after-unfollow (X can
 * silently revert) · abort on login/challenge · resumable (never re-acts an already-unfollowed handle).
 */

interface RunState {
  unfollowedHandles: string[];
  dailyDate: string;
  dailyCount: number;
}

const today = () => new Date().toISOString().slice(0, 10);

function loadState(): RunState {
  try {
    return JSON.parse(fs.readFileSync(config.paths.runStateFile, "utf8")) as RunState;
  } catch {
    return { unfollowedHandles: [], dailyDate: today(), dailyCount: 0 };
  }
}
function saveState(s: RunState): void {
  fs.mkdirSync(config.paths.dataDir, { recursive: true });
  fs.writeFileSync(config.paths.runStateFile, JSON.stringify(s, null, 2));
}

// Minimal CSV parser that respects quoted fields.
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0]!);
  return lines.slice(1).map((l) => {
    const cells = split(l);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h.trim()] = (cells[i] ?? "").trim()));
    return row;
  });
}

function loadApprovedFromCsv(): string[] {
  const files = fs
    .readdirSync(config.paths.dataDir)
    .filter((f) => f.startsWith("report-") && f.endsWith(".csv"))
    .sort();
  const newest = files[files.length - 1];
  if (!newest) return [];
  const rows = parseCsv(fs.readFileSync(path.join(config.paths.dataDir, newest), "utf8"));
  return rows
    .filter((r) => ["yes", "y", "true", "1"].includes((r.approved ?? "").toLowerCase()))
    .map((r) => r.handle!.replace(/^@/, "").toLowerCase());
}

function loadRecommendedDrops(): string[] {
  try {
    const scored = JSON.parse(fs.readFileSync(config.paths.scoredFile, "utf8")) as ScoreResult;
    return scored.accounts.filter((a) => a.recommendedAction === "DROP").map((a) => a.handle);
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function jitter(min: number, max: number): number {
  // deterministic-enough randomness without Math.random (varies by clock)
  const t = Number(process.hrtime.bigint() % 1000n) / 1000;
  return Math.round(min + t * (max - min));
}

// Detect follow state from the profile's primary button via its (stable) aria-label.
// 'following' = we follow them, 'notfollowing' = we don't, 'unknown' = button not rendered yet.
const FOLLOW_STATE_EXPR = `(() => {
  var scope = document.querySelector('[data-testid="primaryColumn"]') || document.body;
  var btns = scope.querySelectorAll('[role="button"][aria-label], button[aria-label]');
  var sawFollow = false;
  for (var i = 0; i < btns.length; i++) {
    var al = btns[i].getAttribute('aria-label') || '';
    if (/^Following/i.test(al)) return 'following';
    if (/^Follow\\b/i.test(al)) sawFollow = true;
  }
  return sawFollow ? 'notfollowing' : 'unknown';
})()`;

// Poll the follow state until it resolves (proxy/profile render can be slow), up to ~timeoutMs.
async function followState(page: Page, timeoutMs = 9000): Promise<"following" | "notfollowing" | "unknown"> {
  const deadline = Date.now() + timeoutMs;
  let state: string = "unknown";
  while (Date.now() < deadline) {
    state = (await page.evaluate(FOLLOW_STATE_EXPR)) as string;
    if (state !== "unknown") break;
    await sleep(700);
  }
  return state as "following" | "notfollowing" | "unknown";
}

/** Unfollow one account via its profile. Returns true only if the state actually changed. */
async function unfollowOne(stagehand: Stagehand, page: Page, handle: string): Promise<boolean> {
  await page.goto(`${X_BASE}/${handle}`, { waitUntil: "domcontentloaded" });

  // Abort if we got bounced to a login/challenge wall.
  if (/\/i\/flow\/login|\/login/.test(new URL(page.url()).pathname)) {
    throw new Error("AbortChallenge: bounced to login/challenge");
  }

  // Only act if we're actually following them (so act() can never accidentally FOLLOW someone).
  const before = await followState(page);
  if (before !== "following") return false; // not following / private / didn't load

  // Stagehand's resilient act() for the fragile click + confirm dialog (their tooling).
  await stagehand.act("click the 'Following' button on this profile to unfollow this account");
  await sleep(900);
  await stagehand.act("if a confirmation dialog appeared, click 'Unfollow' to confirm").catch(() => {});
  await sleep(1500);

  // Verify-after-unfollow: state must flip to notfollowing (X can silently revert).
  return (await followState(page, 6000)) === "notfollowing";
}

// ── List-inline unfollow: scroll /following once, click Unfollow on target rows in place. ──
// Faster + far better demo footage than per-profile navigation. Targets/done live on `window`
// so the in-page finder can skip them; all clicks are deterministic (no per-item LLM call).

// Find the first visible UserCell whose @handle is a target we haven't done, click its
// "Following" button (scoped to that row), and return the handle. Null if none visible.
const FIND_CLICK_EXPR = `(() => {
  var scope = document.querySelector('[data-testid="primaryColumn"]') || document.body;
  var cells = scope.querySelectorAll('[data-testid="UserCell"]');
  for (var i = 0; i < cells.length; i++) {
    var cell = cells[i];
    var m = (cell.textContent || '').match(/@([A-Za-z0-9_]{1,15})/);
    if (!m) continue;
    var h = m[1].toLowerCase();
    if (!window.__drop.has(h) || window.__done.has(h)) continue;
    var btns = cell.querySelectorAll('[role="button"][aria-label], button[aria-label]');
    for (var j = 0; j < btns.length; j++) {
      if (/^Following/i.test(btns[j].getAttribute('aria-label') || '')) {
        btns[j].scrollIntoView({ block: 'center' });
        btns[j].click();
        return h;
      }
    }
  }
  return null;
})()`;

const CONFIRM_EXPR = `(() => { var b = document.querySelector('[data-testid="confirmationSheetConfirm"]'); if (b) { b.click(); return true; } return false; })()`;

// Verify a handle's row flipped to "Follow" (success) vs still "Following" (failed/reverted).
function verifyExpr(handle: string): string {
  return `(() => {
    var scope = document.querySelector('[data-testid="primaryColumn"]') || document.body;
    var cells = scope.querySelectorAll('[data-testid="UserCell"]');
    for (var i = 0; i < cells.length; i++) {
      var m = (cells[i].textContent || '').match(/@([A-Za-z0-9_]{1,15})/);
      if (!m || m[1].toLowerCase() !== ${JSON.stringify(handle)}) continue;
      var btns = cells[i].querySelectorAll('[role="button"][aria-label], button[aria-label]');
      for (var j = 0; j < btns.length; j++) {
        if (/^Following/i.test(btns[j].getAttribute('aria-label') || '')) return 'following';
      }
      return 'notfollowing';
    }
    return 'gone'; // scrolled off — treat as success
  })()`;
}

async function unfollowFromList(page: Page, dropSet: Set<string>, state: RunState, budget: number): Promise<number> {
  await page.goto(`${X_BASE}/${config.xHandle}/following`, { waitUntil: "domcontentloaded" });
  await sleep(3500);
  if (/\/i\/flow\/login|\/login/.test(new URL(page.url()).pathname)) throw new Error("AbortChallenge: login wall");

  // Wait for the list to actually render rows (can be slow / throttled). Poll up to ~20s.
  const cellCount = `document.querySelectorAll('[data-testid="UserCell"]').length`;
  let cells = 0;
  for (let i = 0; i < 14; i++) {
    cells = (await page.evaluate(cellCount)) as number;
    if (cells > 0) break;
    await page.evaluate("window.scrollBy(0, 400)");
    await sleep(1500);
  }
  console.log(`  list rendered ${cells} UserCells${cells === 0 ? " — list looks throttled/blank (try profile-nav)" : ""}`);
  if (cells === 0) return 0;

  // Seed target + done sets on the page so the finder can skip them.
  await page.evaluate(
    `window.__drop = new Set(${JSON.stringify([...dropSet])}); window.__done = new Set(${JSON.stringify(state.unfollowedHandles)}); 'ok'`,
  );

  let count = 0;
  let scrollStalls = 0;
  while (count < budget && scrollStalls < 25) {
    const h = (await page.evaluate(FIND_CLICK_EXPR)) as string | null;
    if (h) {
      await sleep(900);
      await page.evaluate(CONFIRM_EXPR);
      await sleep(1300);
      const st = (await page.evaluate(verifyExpr(h))) as string;
      await page.evaluate(`window.__done.add(${JSON.stringify(h)})`); // never retry this handle
      if (st !== "following") {
        count++;
        state.unfollowedHandles.push(h);
        state.dailyCount++;
        saveState(state);
        console.log(`  ✓ unfollowed ${count}/${budget}: @${h}`);
      } else {
        console.log(`  · @${h} didn't take, skipping`);
      }
      scrollStalls = 0;
      await sleep(jitter(config.unfollow.minDelayMs, config.unfollow.maxDelayMs));
      if (count > 0 && count % config.unfollow.longPauseEvery === 0) {
        console.log(`  …pausing ${Math.round(config.unfollow.longPauseMs / 1000)}s`);
        await sleep(config.unfollow.longPauseMs);
      }
    } else {
      await page.evaluate("window.scrollBy(0, Math.round(window.innerHeight * 0.85))");
      await sleep(config.scroll.settleMs);
      scrollStalls++;
    }
  }
  return count;
}

interface Args {
  execute: boolean;
  max: number | null;
  useRecs: boolean;
  viaProfile: boolean;
}
function parseArgs(): Args {
  const a = process.argv.slice(3);
  const maxIdx = a.indexOf("--max");
  return {
    execute: a.includes("--execute"),
    max: maxIdx >= 0 ? Number(a[maxIdx + 1]) : null,
    useRecs: a.includes("--use-recommendations"),
    viaProfile: a.includes("--via-profile"), // fallback: per-profile nav instead of list-inline
  };
}

export async function runUnfollow(): Promise<void> {
  const args = parseArgs();
  const state = loadState();
  if (state.dailyDate !== today()) {
    state.dailyDate = today();
    state.dailyCount = 0;
  }

  const source = args.useRecs ? loadRecommendedDrops() : loadApprovedFromCsv();
  if (source.length === 0) {
    console.error(
      args.useRecs
        ? "No DROP recommendations in scored.json — run `pnpm score` first."
        : "No approved rows. Edit the newest data/report-*.csv (set approved=yes), or pass --use-recommendations.",
    );
    process.exitCode = 1;
    return;
  }

  const done = new Set(state.unfollowedHandles);
  let queue = source.filter((h) => !done.has(h));

  // Daily cap budget.
  const remainingToday = Math.max(0, config.unfollow.dailyCap - state.dailyCount);
  let budget = remainingToday;
  if (args.max != null) budget = Math.min(budget, args.max);
  queue = queue.slice(0, budget);

  console.log(`Targets: ${source.length} · already done: ${done.size} · daily cap left: ${remainingToday} · this run: ${queue.length}`);
  if (queue.length === 0) {
    console.log("Nothing to do (daily cap reached or all done). Re-run tomorrow or raise DAILY_UNFOLLOW_CAP.");
    return;
  }

  if (!args.execute) {
    console.log("\n[DRY RUN] Would unfollow (pass --execute to do it for real):");
    queue.slice(0, 30).forEach((h, i) => console.log(`  ${i + 1}. @${h}`));
    if (queue.length > 30) console.log(`  …and ${queue.length - 30} more`);
    console.log("\nNo changes made.");
    return;
  }

  const contextId = loadContextId();
  if (!contextId) {
    console.error("No Context — run `pnpm auth` first.");
    process.exitCode = 1;
    return;
  }
  const stagehand = await createStagehand({ contextId, persist: false });
  try {
    const page = stagehand.context.pages()[0] as unknown as Page;
    if (!(await verifyLoggedIn(page))) {
      console.error("Not logged in — run `pnpm auth`.");
      process.exitCode = 1;
      return;
    }

    let count = 0;
    if (!args.viaProfile) {
      // DEFAULT: scroll the /following list once and unfollow targets inline (fast + great footage).
      console.log("Unfollowing inline from the /following list...");
      try {
        const eligible = new Set(source.filter((h) => !done.has(h)));
        count = await unfollowFromList(page, eligible, state, budget);
      } catch (err) {
        console.warn(`\n⚠ ${(err as Error).message} — stopping for safety.`);
      }
    } else {
      // Fallback: visit each profile (reliable, slower, duller footage).
      for (const handle of queue) {
        try {
          const ok = await unfollowOne(stagehand, page, handle);
          if (ok) {
            count++;
            state.unfollowedHandles.push(handle);
            state.dailyCount++;
            saveState(state);
            console.log(`  ✓ unfollowed ${count}/${queue.length}: @${handle}`);
          } else {
            console.log(`  · skipped @${handle} (not following / reverted)`);
          }
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("AbortChallenge")) {
            console.warn(`\n⚠ ${msg} — stopping for safety. Re-run after resolving on x.com.`);
            break;
          }
          console.warn(`  ! @${handle} failed: ${msg}`);
        }
        await sleep(jitter(config.unfollow.minDelayMs, config.unfollow.maxDelayMs));
        if (count > 0 && count % config.unfollow.longPauseEvery === 0) {
          console.log(`  …pausing ${Math.round(config.unfollow.longPauseMs / 1000)}s`);
          await sleep(config.unfollow.longPauseMs);
        }
      }
    }
    console.log(`\n✅ Done. Unfollowed ${count} this run. Daily total: ${state.dailyCount}/${config.unfollow.dailyCap}.`);
  } finally {
    await stagehand.close();
  }
}
