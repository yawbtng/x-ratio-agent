import fs from "node:fs";
import { config } from "./config.js";
import { loadList, type AccountRecord } from "./scrape/followGraph.js";
import { scoreRelevance } from "./relevance.js";

/**
 * M2 scoring + selection. Goal: get following under `targetFollowing` while keeping the accounts
 * you actually want.
 *
 *   KEEP  = mutuals (follow you back) + allowlist + your top non-followers by keepScore, up to budget
 *   DROP  = the remaining non-followers (lowest keepScore first)
 *   budget = target - mustKeep
 *
 * keepScore = wRelevance*relevance + wNotability*notability. Relevance (LLM vs your interests) only
 * ever helps an account survive — it never forces a DROP. Completeness gate: only DROP when the
 * followers list is fully captured (else a missed follower could be wrongly unfollowed).
 */

export type Action = "KEEP" | "REVIEW" | "DROP";

export interface ScoredAccount {
  handle: string;
  name: string;
  followsBack: boolean;
  followers: number | null;
  verified: boolean;
  relevance: number | null;
  keepScore: number;
  recommendedAction: Action;
  reason: string;
}

export interface ScoreResult {
  generatedAt: string;
  target: number;
  followingCount: number;
  followersCount: number;
  followingComplete: boolean;
  followersComplete: boolean;
  ratio: number;
  accounts: ScoredAccount[];
  stats: { keep: number; review: number; drop: number };
}

function loadAllowlist(): Set<string> {
  try {
    return new Set(
      fs
        .readFileSync(config.paths.allowlistFile, "utf8")
        .split("\n")
        .map((l) => l.trim().replace(/^@/, "").toLowerCase())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

// Notability 0..1: log-scaled follower count (0 → 10M) plus a small verified bonus.
function notability(a: AccountRecord): number {
  const f = a.followers ?? 0;
  const base = Math.min(1, Math.log10(f + 1) / 7);
  return Math.min(1, base + (a.verified ? 0.1 : 0));
}

export async function runScore(): Promise<ScoreResult> {
  const following = loadList("following");
  const followers = loadList("followers");
  if (!following || !followers) throw new Error("Missing data — run `pnpm scan` first.");

  const followersSet = new Set(followers.accounts.map((a) => a.handle));
  const allowlist = loadAllowlist();

  const mutuals: AccountRecord[] = [];
  const allowed: AccountRecord[] = [];
  const nonFollowers: AccountRecord[] = [];
  for (const a of following.accounts) {
    if (allowlist.has(a.handle)) allowed.push(a);
    else if (followersSet.has(a.handle)) mutuals.push(a);
    else nonFollowers.push(a);
  }

  // Relevance only for the accounts we might drop (non-followers).
  console.log(`Scoring relevance for ${nonFollowers.length} non-followers...`);
  const relevanceMap = await scoreRelevance(nonFollowers);

  const ranked = nonFollowers
    .map((a) => {
      const rel = relevanceMap.get(a.handle);
      const relevance = rel ? rel.score : null;
      const keepScore = config.scoreWeights.relevance * (relevance ?? 0.3) + config.scoreWeights.notability * notability(a);
      return { a, relevance, keepScore, relReason: rel?.reason ?? "" };
    })
    .sort((x, y) => y.keepScore - x.keepScore); // best-to-keep first

  const mustKeep = mutuals.length + allowed.length;
  const keepBudget = Math.max(0, config.targetFollowing - mustKeep); // non-followers we can still keep
  const canDrop = followers.complete; // completeness gate

  const accounts: ScoredAccount[] = [];
  const push = (a: AccountRecord, action: Action, reason: string, relevance: number | null, keepScore: number) =>
    accounts.push({
      handle: a.handle,
      name: a.name,
      followsBack: followersSet.has(a.handle),
      followers: a.followers,
      verified: a.verified,
      relevance,
      keepScore,
      recommendedAction: action,
      reason,
    });

  for (const a of mutuals) push(a, "KEEP", "mutual — follows you back", null, 1);
  for (const a of allowed) push(a, "KEEP", "on allowlist", null, 1);
  ranked.forEach((r, i) => {
    const keep = i < keepBudget;
    if (keep) push(r.a, "KEEP", r.relReason || "kept (within budget)", r.relevance, r.keepScore);
    else if (!canDrop) push(r.a, "REVIEW", "would drop, but followers list incomplete", r.relevance, r.keepScore);
    else push(r.a, "DROP", r.relReason ? `drop — ${r.relReason}` : "drop — low relevance/notability", r.relevance, r.keepScore);
  });

  // DROP first (lowest keepScore first), then REVIEW, then KEEP.
  const order: Record<Action, number> = { DROP: 0, REVIEW: 1, KEEP: 2 };
  accounts.sort((x, y) => order[x.recommendedAction] - order[y.recommendedAction] || x.keepScore - y.keepScore);

  const stats = {
    keep: accounts.filter((a) => a.recommendedAction === "KEEP").length,
    review: accounts.filter((a) => a.recommendedAction === "REVIEW").length,
    drop: accounts.filter((a) => a.recommendedAction === "DROP").length,
  };

  const result: ScoreResult = {
    generatedAt: new Date().toISOString(),
    target: config.targetFollowing,
    followingCount: following.count,
    followersCount: followers.count,
    followingComplete: following.complete,
    followersComplete: followers.complete,
    ratio: following.count ? Number((followers.count / following.count).toFixed(3)) : 0,
    accounts,
    stats,
  };

  fs.writeFileSync(config.paths.scoredFile, JSON.stringify(result, null, 2));
  console.log(`Scored ${accounts.length} → KEEP ${stats.keep} · REVIEW ${stats.review} · DROP ${stats.drop}`);
  return result;
}
