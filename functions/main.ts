// Browserbase Function: gentle, stateless X (Twitter) unfollow grind.
//
// WHY a Function: the browser runs on Browserbase's own infra (not your laptop, not a GitHub
// runner). A daily GitHub Actions curl just pokes this function's URL — all the heavy work
// (the logged-in session, the navigation, the clicks) happens here, on Browserbase.
//
// WHY stateless: X itself is the source of truth for "who's left to unfollow." We only unfollow
// handles that are (a) on the baked-in DROP list and (b) STILL followed right now. Anyone already
// unfollowed reads as "not following" and is skipped. No run-state, no database — which is exactly
// what the "no persistent storage between invocations" Functions limit requires.
//
// TWO MODES (param `mode`):
//   "profile" (DEFAULT) — visit each drop account's profile page directly and unfollow there.
//       Robust: it does NOT depend on the /following list rendering. X was observed throttling the
//       /following LIST for automated sessions (3 rows then empty) while profiles still load fine,
//       so this is the path that actually makes progress. We shuffle the drop list each run so we
//       hit still-followed targets fast instead of re-walking the already-done prefix.
//   "list" — the original inline path: scroll /following once, click Unfollow in place. Cheaper in
//       browser-minutes, but useless when X starves the list view. Kept as a fallback.
//
// WHY deterministic (no Stagehand/LLM): every action is a plain DOM query/click keyed off the
// stable aria-label="Following" signal + X's confirmationSheetConfirm testid. No model call.

import { chromium } from "playwright-core";
import { z } from "zod";
import { defineFn } from "@browserbasehq/sdk-functions";
import { DROP } from "./droplist.js";
import { CONTEXT_ID as CFG_CONTEXT_ID, X_HANDLE as CFG_X_HANDLE } from "./config.local.js";

const X_BASE = "https://x.com";

// The /following list owner + the Browserbase Context holding the persisted X login come from
// config.local.ts (gitignored, personal). Env vars still win if set, so you can override without
// editing files. Fail fast if neither is configured — never fall back to someone else's account.
const X_HANDLE = (process.env.X_HANDLE ?? CFG_X_HANDLE).replace(/^@/, "");
const CONTEXT_ID = process.env.X_CONTEXT_ID ?? CFG_CONTEXT_ID;
if (!CONTEXT_ID || CONTEXT_ID.startsWith("REPLACE")) {
  throw new Error(
    "No Browserbase Context configured. Run `pnpm auth` to create one, then set CONTEXT_ID in " +
      "functions/config.local.ts (copy config.local.example.ts). See README → Use it yourself.",
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => Math.round(min + Math.random() * (max - min));
function shuffled<T>(arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ── Profile-page primitives (mode: "profile") ──────────────────────────────────────────────────
// Follow state from a PROFILE's primary button via its (stable) aria-label.
//   'following' = we follow them · 'notfollowing' = we don't · 'unknown' = button not rendered yet.
const PROFILE_STATE_EXPR = `(() => {
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

// Click the profile's "Following" button (opens the unfollow confirm). Returns true if clicked.
const PROFILE_CLICK_EXPR = `(() => {
  var scope = document.querySelector('[data-testid="primaryColumn"]') || document.body;
  var btns = scope.querySelectorAll('[role="button"][aria-label], button[aria-label]');
  for (var i = 0; i < btns.length; i++) {
    if (/^Following/i.test(btns[i].getAttribute('aria-label') || '')) { btns[i].click(); return true; }
  }
  return false;
})()`;

const CONFIRM_EXPR = `(() => { var b = document.querySelector('[data-testid="confirmationSheetConfirm"]'); if (b) { b.click(); return true; } return false; })()`;

// ── List-page primitives (mode: "list", fallback) ──────────────────────────────────────────────
// Extract a UserCell's @handle from its profile LINK href (e.g. <a href="/jack">), NOT from
// textContent — textContent glues the handle to the "Following" button label with no separator,
// so a text regex swallows "…Following" into the handle and nothing matches. href is unambiguous.
const CELL_HANDLE_JS = `function cellHandle(cell){
  var links = cell.querySelectorAll('a[href]');
  for (var i = 0; i < links.length; i++) {
    var href = links[i].getAttribute('href') || '';
    var mm = href.match(/^\\/([A-Za-z0-9_]{1,15})$/);
    if (mm) return mm[1].toLowerCase();
  }
  return null;
}`;

const FIND_CLICK_EXPR = `(() => {
  ${CELL_HANDLE_JS}
  var scope = document.querySelector('[data-testid="primaryColumn"]') || document.body;
  var cells = scope.querySelectorAll('[data-testid="UserCell"]');
  for (var i = 0; i < cells.length; i++) {
    var h = cellHandle(cells[i]);
    if (!h) continue;
    if (!window.__drop.has(h) || window.__done.has(h)) continue;
    var btns = cells[i].querySelectorAll('[role="button"][aria-label], button[aria-label]');
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
  visited: number;
  dryRun: boolean;
};
const result = (r: Partial<Result>): Result => ({
  ok: false,
  unfollowed: 0,
  handles: [],
  error: "",
  visited: 0,
  dryRun: false,
  ...r,
});

// Poll a profile's follow-state until it resolves (proxy/profile render can be slow).
async function profileState(
  page: import("playwright-core").Page,
  timeoutMs = 9000,
): Promise<"following" | "notfollowing" | "unknown"> {
  const deadline = Date.now() + timeoutMs;
  let s = "unknown";
  while (Date.now() < deadline) {
    s = (await page.evaluate(PROFILE_STATE_EXPR)) as string;
    if (s !== "unknown") break;
    await sleep(700);
  }
  return s as "following" | "notfollowing" | "unknown";
}

const paramsSchema = z.object({
  // How many to unfollow this run. Keep it gentle — X rate-limits at the ACCOUNT level, so a
  // small daily batch is what avoids the throttle-to-zero spiral. Hard-capped at 40.
  max: z.number().int().positive().max(40).optional(),
  // "profile" (default, robust) or "list" (cheaper, but dies when X starves the list view).
  mode: z.enum(["profile", "list"]).optional(),
  // dryRun: confirm login + that targets are actionable, unfollow nothing.
  dryRun: z.boolean().optional(),
});

defineFn(
  "x-unfollow",
  async (ctx, params) => {
    const max = params?.max ?? 20;
    const mode = params?.mode ?? "profile";
    const dryRun = params?.dryRun ?? false;

    // ctx.session was created by the runtime using our sessionConfig below — it already loaded our
    // Context, so this browser is logged into X. We just attach over CDP.
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

      // ── PROFILE MODE (default) ──────────────────────────────────────────────────────────────
      if (mode === "profile") {
        const queue = shuffled(DROP);
        const handles: string[] = [];
        let count = 0;
        let visited = 0;

        if (dryRun) {
          // Visit a few shuffled drop profiles and report their follow-state — proves profiles load
          // and that targets are still followable (i.e. profile-nav can make progress).
          const states: string[] = [];
          for (const h of queue.slice(0, 6)) {
            await page.goto(`${X_BASE}/${h}`, { waitUntil: "domcontentloaded" });
            states.push(`${h}=${await profileState(page)}`);
            await sleep(jitter(1500, 3000));
          }
          return result({ ok: true, dryRun: true, visited: 6, handles: states });
        }

        // Cap total profile visits so a run of mostly-already-done accounts can't blow the 15-min
        // execution ceiling. With most of DROP still un-done, `count` hits `max` well before this.
        const visitCap = Math.min(queue.length, max * 3 + 15);
        // Circuit breaker: if many shuffled profiles in a row are non-actionable, the account is
        // throttled (profiles not loading → "unknown") or we hit a done-cluster — bail rather than
        // burn minutes. With ~93% of DROP still followed, 15-in-a-row is near-impossible normally.
        let consecutiveSkips = 0;
        for (const handle of queue) {
          if (count >= max || visited >= visitCap || consecutiveSkips >= 15) break;
          visited++;
          try {
            await page.goto(`${X_BASE}/${handle}`, { waitUntil: "domcontentloaded" });
          } catch {
            consecutiveSkips++;
            continue; // profile failed to load — skip
          }
          if (/\/i\/flow\/login|\/login/.test(new URL(page.url()).pathname)) {
            // bounced to a login/challenge wall — stop and report what we got
            return result({ error: "login_wall", unfollowed: count, handles, visited });
          }
          const before = await profileState(page);
          if (before !== "following") {
            // already unfollowed / suspended / private / didn't load — skip quickly
            consecutiveSkips++;
            await sleep(jitter(1200, 3000));
            continue;
          }
          consecutiveSkips = 0; // found a live target — reset the breaker
          await page.evaluate(PROFILE_CLICK_EXPR);
          await sleep(900);
          await page.evaluate(CONFIRM_EXPR);
          await sleep(1300);
          if ((await profileState(page, 6000)) === "notfollowing") {
            count++;
            handles.push(handle);
          }
          await sleep(jitter(4000, 9000)); // human-like pacing
          if (count > 0 && count % 12 === 0) await sleep(30000); // periodic breather
        }
        return result({ ok: true, unfollowed: count, handles, visited });
      }

      // ── LIST MODE (fallback) ────────────────────────────────────────────────────────────────
      await page.goto(`${X_BASE}/${X_HANDLE}/following`, { waitUntil: "domcontentloaded" });
      await sleep(3500);
      if (/\/i\/flow\/login|\/login/.test(new URL(page.url()).pathname)) {
        return result({ error: "login_wall" });
      }
      let cells = 0;
      for (let i = 0; i < 14; i++) {
        cells = (await page.evaluate(`document.querySelectorAll('[data-testid="UserCell"]').length`)) as number;
        if (cells > 0) break;
        await page.evaluate("window.scrollBy(0, 400)");
        await sleep(1500);
      }
      if (cells === 0) return result({ error: "list_blank_throttled" });

      await page.evaluate(
        `window.__drop = new Set(${JSON.stringify(DROP)}); window.__done = new Set(); 'ok'`,
      );

      const handles: string[] = [];
      let count = 0;
      let stalls = 0;
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
          await sleep(jitter(5000, 11000));
          if (count > 0 && count % 12 === 0) await sleep(30000);
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
    // session arrive already logged into X. timeout is just under the 15-min execution ceiling.
    // NOTE: proxies intentionally OFF — residential proxy bandwidth ($12/GB) blew past the 1GB plan
    // allowance (640% over) loading full profile pages 60×/day. The account is authenticated via the
    // Context (cookies), and X rate-limits per-account not per-IP, so the datacenter IP is fine here.
    sessionConfig: {
      browserSettings: {
        context: { id: CONTEXT_ID, persist: false },
      },
      timeout: 870,
    },
    parametersSchema: paramsSchema,
  },
);
