import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { config, X_BASE } from "../config.js";
import { createStagehand } from "../browser/session.js";
import { loadContextId, verifyLoggedIn } from "../browser/auth.js";

/**
 * SPIKE 0 — the biggest-risk check (plan §5).
 *
 * Question: will X let us page through the ENTIRE following + followers list?
 *
 * Approach (per user's insight + tooling principle): do everything inside the Browserbase
 * session. We monkeypatch window.fetch / XMLHttpRequest via addInitScript BEFORE navigation,
 * so the logged-in page makes its OWN authenticated GraphQL calls (correct cookies/CSRF/hashes)
 * as it loads + scrolls, and we just READ the captured JSON:
 *   - exact friends_count / followers_count (from the UserBy* call) — not the rounded header
 *   - the real paginated handle entries (from Followers/Following calls)
 * Scrolling drives pagination; when captured handles stop growing, the list ended (or X
 * truncated). Compare captured vs exact to tell which.
 *
 * IMPORTANT: all in-page code is passed as STRING IIFEs, never as functions. Stagehand runs
 * `fn.toString()` in the page, and tsx/esbuild injects `__name(...)` helpers into function
 * bodies → ReferenceError in the page. String literals are passed through untouched.
 */

// Installed on every new document. Self-invoking; guards against double-install.
const CAPTURE_INIT = `(() => {
  var w = window;
  if (w.__xcapInstalled) return;
  w.__xcapInstalled = true;
  w.__xcap = [];
  var want = function (u) { return typeof u === "string" && /graphql/i.test(u) && /(Followers|Following|UserBy)/.test(u); };
  var origFetch = w.fetch;
  w.fetch = function () {
    var args = arguments;
    return origFetch.apply(this, args).then(function (res) {
      try {
        var u = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        if (want(u)) { res.clone().json().then(function (j) { w.__xcap.push({ url: u, json: j }); }).catch(function () {}); }
      } catch (e) {}
      return res;
    });
  };
  var OrigXHR = w.XMLHttpRequest;
  function PatchedXHR() {
    var xhr = new OrigXHR();
    var url = "";
    var open = xhr.open;
    xhr.open = function (m, u) { url = u; return open.apply(this, arguments); };
    xhr.addEventListener("load", function () {
      try { if (want(url)) w.__xcap.push({ url: url, json: JSON.parse(xhr.responseText) }); } catch (e) {}
    });
    return xhr;
  }
  w.XMLHttpRequest = PatchedXHR;
})()`;

// Drains the capture buffer → { handles, following?, followers? }, then resets it.
const DRAIN_EXPR = `(() => {
  var w = window;
  var cap = w.__xcap || [];
  w.__xcap = [];
  var handles = [];
  var following, followers;
  var walk = function (o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) walk(o[i]); return; }
    for (var k in o) {
      if (k === "screen_name" && typeof o[k] === "string") handles.push(o[k].toLowerCase());
      else walk(o[k]);
    }
  };
  for (var c = 0; c < cap.length; c++) {
    var item = cap[c];
    if (/UserBy/.test(item.url)) {
      var u = item.json && item.json.data && item.json.data.user && item.json.data.user.result;
      var legacy = u && u.legacy;
      if (legacy) {
        if (typeof legacy.friends_count === "number") following = legacy.friends_count;
        if (typeof legacy.followers_count === "number") followers = legacy.followers_count;
      }
    } else {
      walk(item.json);
    }
  }
  return { handles: handles, following: following, followers: followers };
})()`;

interface Delta {
  handles: string[];
  following?: number;
  followers?: number;
}

async function drainCaptures(page: Page): Promise<Delta> {
  return (await page.evaluate(DRAIN_EXPR)) as Delta;
}

// X's profile header shows EXACT following/followers counts (comma-separated, not abbreviated).
// This is the reliable exact-count source when the GraphQL capture doesn't fire.
const EXACT_COUNT_DOM_EXPR = `(() => {
  var parse = function (a) {
    if (!a) return null;
    var m = (a.textContent || "").replace(/,/g, "").match(/([\\d.]+)([KM]?)/i);
    if (!m) return null;
    var n = parseFloat(m[1]); var s = (m[2] || "").toUpperCase();
    if (s === "K") n *= 1e3; if (s === "M") n *= 1e6;
    return Math.round(n);
  };
  return {
    following: parse(document.querySelector('a[href$="/following"]')),
    followers: parse(document.querySelector('a[href$="/verified_followers"]') || document.querySelector('a[href$="/followers"]')),
  };
})()`;

async function readExactCountsFromDom(page: Page): Promise<{ following?: number; followers?: number }> {
  try {
    const r = (await page.evaluate(EXACT_COUNT_DOM_EXPR)) as { following: number | null; followers: number | null };
    return { following: r.following ?? undefined, followers: r.followers ?? undefined };
  } catch {
    return {};
  }
}

async function scrollStep(page: Page): Promise<void> {
  await page.evaluate(`window.scrollBy(0, Math.round(window.innerHeight * ${config.scroll.stepFraction}))`);
}

function persist(list: string, handles: string[]): void {
  try {
    fs.mkdirSync(config.paths.dataDir, { recursive: true });
    fs.writeFileSync(path.join(config.paths.dataDir, `spike0-${list}.json`), JSON.stringify({ count: handles.length, handles }, null, 2));
  } catch {
    /* best-effort */
  }
}

interface ListScanResult {
  list: "following" | "followers";
  exactCount: number | null;
  capturedCount: number;
  complete: boolean;
  note: string;
}

async function scrapeList(
  page: Page,
  list: "following" | "followers",
  counts: { following?: number; followers?: number },
): Promise<number> {
  await page.goto(`${X_BASE}/${config.xHandle}/${list}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);

  const seen = new Set<string>();
  let stalls = 0;
  const self = config.xHandle.toLowerCase();
  const target = list === "following" ? counts.following : counts.followers;

  for (let i = 0; i < config.scroll.maxScrolls && stalls < config.scroll.stagnantRoundsToStop; i++) {
    const before = seen.size;
    try {
      const delta = await drainCaptures(page);
      for (const h of delta.handles) if (h !== self) seen.add(h);
      if (delta.following != null) counts.following = delta.following;
      if (delta.followers != null) counts.followers = delta.followers;

      await scrollStep(page);
      // Patience: when stalled, wait progressively longer to ride through X's rate-limit
      // PAUSES (which otherwise look like "end of list"). A real end just burns these waits.
      const stallWait = seen.size === before ? config.scroll.settleMs + 2500 * (stalls + 1) : config.scroll.settleMs;
      await page.waitForTimeout(stallWait);
    } catch (err) {
      console.warn(`  ${list}: scrape interrupted at ${seen.size} captured (${(err as Error).message}). Reporting partial.`);
      break;
    }

    stalls = seen.size === before ? stalls + 1 : 0;
    if (i % 10 === 0 || stalls > 0) {
      console.log(`  ${list}: ${seen.size}${target ? "/" + target : ""} captured (scroll ${i}${stalls ? `, stall ${stalls}/${config.scroll.stagnantRoundsToStop}` : ""})...`);
    }
    if (target && seen.size >= target) break; // reached the real total — done
  }
  persist(list, [...seen]);
  return seen.size;
}

export async function runSpike0(): Promise<void> {
  const contextId = loadContextId();
  if (!contextId) {
    console.error("No Context found. Run `pnpm auth` first.");
    process.exitCode = 1;
    return;
  }

  const stagehand = await createStagehand({ contextId, persist: false });
  try {
    const page = stagehand.context.pages()[0] as unknown as Page;

    // Install the capture BEFORE any navigation so we catch the page's own GraphQL calls.
    await page.addInitScript(CAPTURE_INIT);

    if (!(await verifyLoggedIn(page))) {
      console.warn("⚠ Could not confirm login via /home redirect. Continuing; if captured counts are 0, run `pnpm auth`.");
    }

    const counts: { following?: number; followers?: number } = {};

    // Profile visit → read EXACT counts from the header DOM (reliable; comma numbers, not abbreviated).
    // Also drain any captured GraphQL as a bonus.
    await page.goto(`${X_BASE}/${config.xHandle}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    const profileDelta = await drainCaptures(page);
    if (profileDelta.following != null) counts.following = profileDelta.following;
    if (profileDelta.followers != null) counts.followers = profileDelta.followers;
    const domCounts = await readExactCountsFromDom(page);
    if (counts.following == null && domCounts.following != null) counts.following = domCounts.following;
    if (counts.followers == null && domCounts.followers != null) counts.followers = domCounts.followers;
    console.log(`Exact counts → following: ${counts.following ?? "?"}, followers: ${counts.followers ?? "?"}`);

    const results: ListScanResult[] = [];
    for (const list of ["following", "followers"] as const) {
      console.log(`\nScraping /${list}...`);
      const captured = await scrapeList(page, list, counts);
      const exact = list === "following" ? counts.following ?? null : counts.followers ?? null;
      const complete = exact != null && captured >= exact * (1 - config.scroll.completenessSlack);
      // Distinguish a likely THROTTLE (stalled very low vs a known large total) from a real truncation cap.
      let note: string;
      if (exact == null) note = "no exact count — can't judge";
      else if (complete) note = "complete";
      else if (captured < Math.min(300, exact * 0.25)) note = "LIKELY RATE-LIMITED (stalled low) — retry later";
      else note = "TRUNCATED (paged a lot then capped)";
      results.push({ list, exactCount: exact, capturedCount: captured, complete, note });
    }

    console.log("\n========== SPIKE 0 VERDICT ==========");
    for (const r of results) {
      const pct = r.exactCount ? `${Math.round((r.capturedCount / r.exactCount) * 100)}%` : "?";
      console.log(
        `${r.list.padEnd(10)} captured ${String(r.capturedCount).padStart(6)} / exact ${String(r.exactCount ?? "?").padStart(6)} (${pct})  → ${r.note}`,
      );
    }
    const allComplete = results.every((r) => r.complete);
    const anyThrottled = results.some((r) => r.note.startsWith("LIKELY RATE-LIMITED"));
    console.log("-------------------------------------");
    if (allComplete) {
      console.log("✅ PASS — full pagination works. The set-math premise holds. Proceed to Spike A/B/C.");
    } else if (anyThrottled) {
      console.log("⏳ INCONCLUSIVE — looks rate-limited (account hit by repeated runs). Wait 30–60 min and re-run.");
    } else {
      console.log("❌ TRUNCATED — X capped the list well below the real total. Rethink approach for large accounts before M1.");
    }
    console.log("=====================================\n");
  } finally {
    await stagehand.close();
  }
}
