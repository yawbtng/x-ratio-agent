// Browserbase Function: gentle, stateless X (Twitter) unfollow grind.
//
// WHY a Function: the browser runs on Browserbase's own infra (not your laptop, not a GitHub
// runner). A daily GitHub Actions curl just pokes this function's URL — all the heavy work
// (the logged-in session, the scrolling, the clicks) happens here, on Browserbase.
//
// WHY stateless: X itself is the source of truth for "who's left to unfollow." We walk the
// /following list and only unfollow handles that are (a) on the baked-in DROP list and (b) STILL
// followed. Anyone already unfollowed has left the list, so they never reappear. No run-state,
// no database, no committing progress back — which is exactly what the "no persistent storage
// between invocations" Functions limit requires.
//
// WHY inline (not per-profile): walking the list once + clicking in place costs ~1 page load.
// Visiting N profiles costs N page loads — N× the browser-minutes + proxy bandwidth. Minutes are
// metered (they're literally what ran out before), so inline is the cost-correct default.
//
// WHY deterministic (no Stagehand/LLM): every action here is a plain DOM query/click keyed off
// the stable aria-label="Following" signal + X's confirmationSheetConfirm testid. No model call,
// no Anthropic key, smaller bundle, fully repeatable.

import { chromium } from "playwright-core";
import { z } from "zod";
import { defineFn } from "@browserbasehq/sdk-functions";
import { DROP } from "./droplist.js";

const X_BASE = "https://x.com";

// The /following list owner + the Browserbase Context holding the persisted X login.
// Neither is a secret (a context id is just an identifier; the handle is public), so they're safe
// to commit. Override via env if you ever rotate them.
const X_HANDLE = (process.env.X_HANDLE ?? "").replace(/^@/, "") || "REPLACE_WITH_X_HANDLE";
const CONTEXT_ID = process.env.X_CONTEXT_ID ?? "8c6f0abe-73d1-4541-b796-eff6c30adbcd";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => Math.round(min + Math.random() * (max - min));

// Extract a UserCell's @handle from its profile LINK href (e.g. <a href="/jack">), NOT from
// textContent. textContent glues the handle directly to the "Following" button label with no
// separator, so a text regex swallows "…Follow"/"…Following" into the handle and nothing matches.
// The href is the single source of truth: `/handle` with no extra path segment.
const CELL_HANDLE_JS = `function cellHandle(cell){
  var links = cell.querySelectorAll('a[href]');
  for (var i = 0; i < links.length; i++) {
    var href = links[i].getAttribute('href') || '';
    var mm = href.match(/^\\/([A-Za-z0-9_]{1,15})$/);
    if (mm) return mm[1].toLowerCase();
  }
  return null;
}`;

// Find the first visible UserCell whose @handle is a DROP target we haven't already clicked this
// run, click its row-scoped "Following" button, return the handle. Null if none currently visible.
const FIND_CLICK_EXPR = `(() => {
  ${CELL_HANDLE_JS}
  var scope = document.querySelector('[data-testid="primaryColumn"]') || document.body;
  var cells = scope.querySelectorAll('[data-testid="UserCell"]');
  for (var i = 0; i < cells.length; i++) {
    var cell = cells[i];
    var h = cellHandle(cell);
    if (!h) continue;
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

// After clicking, confirm the row flipped to "Follow" (success) vs still "Following" (X reverted).
// "gone" = scrolled out of the DOM — treat as success (it was acted on).
const verifyExpr = (handle: string) => `(() => {
  ${CELL_HANDLE_JS}
  var scope = document.querySelector('[data-testid="primaryColumn"]') || document.body;
  var cells = scope.querySelectorAll('[data-testid="UserCell"]');
  for (var i = 0; i < cells.length; i++) {
    if (cellHandle(cells[i]) !== ${JSON.stringify(handle)}) continue;
    var btns = cells[i].querySelectorAll('[role="button"][aria-label], button[aria-label]');
    for (var j = 0; j < btns.length; j++) {
      if (/^Following/i.test(btns[j].getAttribute('aria-label') || '')) return 'following';
    }
    return 'notfollowing';
  }
  return 'gone';
})()`;

// One consistent return shape (all fields always present). The runtime requires a JSONObject —
// optional/undefined-valued props would violate its index signature — so we default every field.
type Result = {
  ok: boolean;
  unfollowed: number;
  handles: string[];
  error: string;
  cellsRendered: number;
  dryRun: boolean;
};
const result = (r: Partial<Result>): Result => ({
  ok: false,
  unfollowed: 0,
  handles: [],
  error: "",
  cellsRendered: 0,
  dryRun: false,
  ...r,
});

const paramsSchema = z.object({
  // How many to unfollow this run. Keep it gentle — X rate-limits at the ACCOUNT level, so a
  // small daily batch is what avoids the throttle-to-zero spiral. Hard-capped at 40.
  max: z.number().int().positive().max(40).optional(),
  // dryRun: just confirm we're logged in + the list renders, unfollow nothing.
  dryRun: z.boolean().optional(),
});

defineFn(
  "x-unfollow",
  async (ctx, params) => {
    const max = params?.max ?? 20;
    const dryRun = params?.dryRun ?? false;

    // ctx.session was created by the runtime using our sessionConfig below — i.e. it already
    // loaded our Context, so this browser is logged into X. We just attach over CDP.
    const browser = await chromium.connectOverCDP(ctx.session.connectUrl);
    try {
      const context = browser.contexts()[0]!;
      const page = context.pages()[0] ?? (await context.newPage());

      // Login check: /home only stays /home when authenticated (else it bounces to a login flow).
      await page.goto(`${X_BASE}/home`, { waitUntil: "domcontentloaded" });
      await sleep(4000);
      if (!new URL(page.url()).pathname.startsWith("/home")) {
        return result({ error: "not_logged_in" });
      }

      await page.goto(`${X_BASE}/${X_HANDLE}/following`, { waitUntil: "domcontentloaded" });
      await sleep(3500);
      if (/\/i\/flow\/login|\/login/.test(new URL(page.url()).pathname)) {
        return result({ error: "login_wall" });
      }

      // Wait for the virtualized list to actually paint rows (can be slow / rate-limited).
      let cells = 0;
      for (let i = 0; i < 14; i++) {
        cells = (await page.evaluate(`document.querySelectorAll('[data-testid="UserCell"]').length`)) as number;
        if (cells > 0) break;
        await page.evaluate("window.scrollBy(0, 400)");
        await sleep(1500);
      }
      if (cells === 0) return result({ error: "list_blank_throttled" });

      // Seed the target set (DROP) + an in-run "already clicked" set onto the page.
      await page.evaluate(
        `window.__drop = new Set(${JSON.stringify(DROP)}); window.__done = new Set(); 'ok'`,
      );

      if (dryRun) {
        // DIAGNOSTIC: walk the list (no clicks) and report what the finder would actually see —
        // how many distinct drop-targets become visible, and whether scrolling advances the list.
        const SCAN_EXPR = `(() => {
          ${CELL_HANDLE_JS}
          var scope = document.querySelector('[data-testid="primaryColumn"]') || document.body;
          var cells = scope.querySelectorAll('[data-testid="UserCell"]');
          var withHandle = 0, dropTargets = 0, dropWithBtn = 0; var samples = [];
          for (var i = 0; i < cells.length; i++) {
            var h = cellHandle(cells[i]);
            if (!h) continue; withHandle++;
            if (samples.length < 10) samples.push(h);
            if (!window.__drop.has(h)) continue; dropTargets++;
            var btns = cells[i].querySelectorAll('[role="button"][aria-label], button[aria-label]');
            var hasBtn = false;
            for (var j = 0; j < btns.length; j++) { if (/^Following/i.test(btns[j].getAttribute('aria-label')||'')) hasBtn = true; }
            if (hasBtn) dropWithBtn++;
          }
          return { cells: cells.length, withHandle: withHandle, dropTargets: dropTargets, dropWithBtn: dropWithBtn, samples: samples };
        })()`;
        const seen = new Set<string>();
        let lastTop = "";
        let scrollAdvanced = 0;
        let scan: any = await page.evaluate(SCAN_EXPR);
        for (let i = 0; i < 12; i++) {
          const cur: any = await page.evaluate(SCAN_EXPR);
          if (cur.samples[0] && cur.samples[0] !== lastTop) scrollAdvanced++;
          lastTop = cur.samples[0] ?? lastTop;
          for (const s of cur.samples) seen.add(s);
          scan = cur;
          await page.evaluate("window.scrollBy(0, Math.round(window.innerHeight * 0.85))");
          await sleep(900);
        }
        return result({
          ok: true,
          dryRun: true,
          cellsRendered: cells,
          // pack diagnostics into handles[] so we can read them off the JSON return
          handles: [
            `lastScan_cells=${scan.cells}`,
            `lastScan_withHandle=${scan.withHandle}`,
            `lastScan_dropTargets=${scan.dropTargets}`,
            `lastScan_dropWithBtn=${scan.dropWithBtn}`,
            `scrollAdvancedRounds=${scrollAdvanced}/12`,
            `distinctTargetsSeen=${seen.size}`,
            `samples=${scan.samples.join(",")}`,
          ],
        });
      }

      const handles: string[] = [];
      let count = 0;
      let stalls = 0;
      // Stop when we hit `max`, or the list stops yielding fresh targets after many scrolls.
      while (count < max && stalls < 25) {
        const h = (await page.evaluate(FIND_CLICK_EXPR)) as string | null;
        if (h) {
          await sleep(900);
          await page.evaluate(CONFIRM_EXPR);
          await sleep(1300);
          const st = (await page.evaluate(verifyExpr(h))) as string;
          await page.evaluate(`window.__done.add(${JSON.stringify(h)})`);
          if (st !== "following") {
            count++;
            handles.push(h);
          }
          stalls = 0;
          await sleep(jitter(5000, 11000)); // human-like pacing
          if (count > 0 && count % 12 === 0) await sleep(30000); // periodic breather
        } else {
          await page.evaluate("window.scrollBy(0, Math.round(window.innerHeight * 0.85))");
          await sleep(700);
          stalls++;
        }
      }

      return result({ ok: true, unfollowed: count, handles });
    } finally {
      await browser.close();
    }
  },
  {
    // The runtime creates ctx.session FROM this config. Loading our Context here is what makes the
    // session arrive already logged into X. proxies:true matches the local setup (residential IP
    // is baseline for X). timeout is just under the 15-min Function execution ceiling.
    sessionConfig: {
      browserSettings: {
        context: { id: CONTEXT_ID, persist: false },
      },
      proxies: true,
      timeout: 870,
    },
    parametersSchema: paramsSchema,
  },
);
