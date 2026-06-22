import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { config, X_BASE } from "../config.js";

/**
 * Reusable follow-graph reader (plan's `followList.ts`). Resumable + rate-limit-aware.
 *
 * Data is harvested by capturing the page's OWN authenticated GraphQL responses (we monkeypatch
 * window.fetch/XHR via addInitScript, per the tooling principle — everything runs inside the
 * Browserbase session). Resume strategy: ACCUMULATE a handle Set across runs and persist it; X
 * reorders lists run-to-run, so we never replay a cursor — each run merges whatever it can grab
 * before X throttles. Over several cooled-down runs the set fills in.
 *
 * NOTE: all in-page code is passed as STRING IIFEs. Stagehand runs fn.toString() in the page and
 * tsx/esbuild injects __name() helpers into function bodies → ReferenceError. Strings are safe.
 */

export const CAPTURE_INIT = `(() => {
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

// Extracts RICH per-account records {handle, name, bio, verified, followers} from the captured
// GraphQL. Handles both X user shapes (legacy.* and the newer core.*). All "free" from the same
// requests — enables relevance + notability ranking without any extra calls.
const DRAIN_EXPR = `(() => {
  var w = window;
  var cap = w.__xcap || [];
  w.__xcap = [];
  var out = [];
  var walk = function (o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) walk(o[i]); return; }
    var lg = o.legacy, core = o.core;
    var sn = (lg && lg.screen_name) || (core && core.screen_name);
    if (typeof sn === "string" && (lg || core)) {
      out.push({
        handle: sn.toLowerCase(),
        name: (core && core.name) || (lg && lg.name) || "",
        bio: (lg && lg.description) || "",
        verified: !!(o.is_blue_verified || (lg && lg.verified)),
        followers: lg && typeof lg.followers_count === "number" ? lg.followers_count : null,
      });
    }
    for (var k in o) { if (k !== "legacy" && k !== "core") walk(o[k]); }
  };
  for (var c = 0; c < cap.length; c++) walk(cap[c].json);
  return out;
})()`;

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

export type ListName = "following" | "followers";

export interface AccountRecord {
  handle: string;
  name: string;
  bio: string;
  verified: boolean;
  followers: number | null;
}

export interface ListData {
  list: ListName;
  exact: number | null;
  complete: boolean;
  count: number;
  accounts: AccountRecord[];
  updatedAt: string;
}

export async function installCapture(page: Page): Promise<void> {
  await page.addInitScript(CAPTURE_INIT);
}

export async function drain(page: Page): Promise<AccountRecord[]> {
  return (await page.evaluate(DRAIN_EXPR)) as AccountRecord[];
}

export async function readExactCounts(page: Page): Promise<{ following?: number; followers?: number }> {
  try {
    const r = (await page.evaluate(EXACT_COUNT_DOM_EXPR)) as { following: number | null; followers: number | null };
    return { following: r.following ?? undefined, followers: r.followers ?? undefined };
  } catch {
    return {};
  }
}

function listFile(list: ListName): string {
  return path.join(config.paths.dataDir, `${list}.json`);
}

export function loadList(list: ListName): ListData | null {
  try {
    return JSON.parse(fs.readFileSync(listFile(list), "utf8")) as ListData;
  } catch {
    return null;
  }
}

export function saveList(data: ListData): void {
  fs.mkdirSync(config.paths.dataDir, { recursive: true });
  fs.writeFileSync(listFile(data.list), JSON.stringify(data, null, 2));
}

async function scrollStep(page: Page): Promise<void> {
  await page.evaluate(`window.scrollBy(0, Math.round(window.innerHeight * ${config.scroll.stepFraction}))`);
}

/**
 * Harvest one list, resuming from prior saved handles. Merges new captures into the set,
 * persists periodically, and stops when complete (set ≈ exact) or X throttles (stall budget).
 * Returns the merged ListData. `complete` is only true when we reach ≈ the exact count.
 */
export async function harvestList(page: Page, list: ListName, exact: number | null): Promise<ListData> {
  const prior = loadList(list);
  const merged = new Map<string, AccountRecord>((prior?.accounts ?? []).map((a) => [a.handle, a])); // accumulated → output
  const pageSeen = new Set<string>(); // THIS session's page view → stall detection (fixes resume false-stall)
  const self = config.xHandle.toLowerCase();
  const startedWith = merged.size;

  await page.goto(`${X_BASE}/${config.xHandle}/${list}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);

  // The list page header also shows the exact count — read it here (more robust than one profile visit).
  if (exact == null) {
    const onPage = await readExactCounts(page);
    exact = (list === "following" ? onPage.following : onPage.followers) ?? null;
    if (exact != null) console.log(`  ${list}: exact count from list page = ${exact}`);
  }

  const isComplete = () => exact != null && merged.size >= exact * (1 - config.scroll.completenessSlack);
  const save = () =>
    saveList({ list, exact, complete: isComplete(), count: merged.size, accounts: [...merged.values()], updatedAt: new Date().toISOString() });

  let stalls = 0;
  for (let i = 0; i < config.scroll.maxScrolls && stalls < config.scroll.stagnantRoundsToStop; i++) {
    const beforePage = pageSeen.size; // stall = the PAGE stopped showing new rows (not: global set stopped growing)
    try {
      for (const rec of await drain(page)) {
        if (rec.handle === self) continue;
        pageSeen.add(rec.handle);
        // prefer the record with a bio (some captures are sparse)
        const existing = merged.get(rec.handle);
        if (!existing || (!existing.bio && rec.bio)) merged.set(rec.handle, rec);
      }
      await scrollStep(page);
      const stallWait =
        pageSeen.size === beforePage
          ? Math.min(config.scroll.maxStallWaitMs, config.scroll.settleMs + 2000 * (stalls + 1))
          : config.scroll.settleMs;
      await page.waitForTimeout(stallWait);
    } catch (err) {
      console.warn(`  ${list}: interrupted at ${merged.size} (${(err as Error).message}). Saving partial.`);
      break;
    }
    stalls = pageSeen.size === beforePage ? stalls + 1 : 0;
    if (i % 10 === 0 || stalls > 0) {
      console.log(`  ${list}: ${merged.size}${exact ? "/" + exact : ""} (page ${pageSeen.size}${stalls ? `, stall ${stalls}/${config.scroll.stagnantRoundsToStop}` : ""})`);
    }
    if (i % 10 === 0) save();
    if (isComplete()) break;
  }

  save();
  console.log(`  ${list}: ${merged.size}/${exact ?? "?"} (added ${merged.size - startedWith} this run, complete=${isComplete()})`);
  return loadList(list)!;
}
