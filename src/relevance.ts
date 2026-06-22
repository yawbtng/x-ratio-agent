import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import { config } from "./config.js";
import type { AccountRecord } from "./scrape/followGraph.js";

/**
 * LLM relevance (M2 v2). Scores how much YOU'd want to keep following each account, 0..1, based on
 * your interest-profile.md + the account's name/bio. Batched (cheap) + cached by handle (free re-runs).
 *
 * Per the plan: relevance can only RESCUE an account toward KEEP. It is never the deciding vote that
 * causes an unfollow — the selection logic (score.ts) uses it to RANK who to keep within your budget.
 */

export interface Relevance {
  score: number;
  reason: string;
}

function loadCache(): Record<string, Relevance> {
  try {
    return JSON.parse(fs.readFileSync(config.paths.relevanceCacheFile, "utf8")) as Record<string, Relevance>;
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, Relevance>): void {
  fs.mkdirSync(config.paths.dataDir, { recursive: true });
  fs.writeFileSync(config.paths.relevanceCacheFile, JSON.stringify(cache, null, 2));
}

function loadProfile(): string {
  try {
    return fs.readFileSync(config.paths.interestProfileFile, "utf8");
  } catch {
    return "";
  }
}

export async function scoreRelevance(accounts: AccountRecord[]): Promise<Map<string, Relevance>> {
  const out = new Map<string, Relevance>();
  const cache = loadCache();
  const todo: AccountRecord[] = [];
  for (const a of accounts) {
    const cached = cache[a.handle];
    if (cached) out.set(a.handle, cached);
    else todo.push(a);
  }

  if (!config.anthropicApiKey) {
    console.warn("  ⚠ No ANTHROPIC_API_KEY — skipping relevance (selection falls back to notability only).");
    return out;
  }
  if (todo.length === 0) return out;

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const profile = loadProfile();
  const BATCH = 20;

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const list = batch
      .map((a, idx) => `${idx + 1}. @${a.handle} | name: ${a.name || "(none)"} | bio: ${(a.bio || "(none)").slice(0, 200)}`)
      .join("\n");
    const prompt = `Here is who I want to KEEP following on X (my interests):\n${profile}\n\nScore each account 0.0–1.0 for how much I'd want to KEEP following them (1.0 = definitely keep, 0.0 = fine to unfollow), based ONLY on relevance to my interests above. Return ONLY a JSON array, no prose:\n[{"handle":"name","score":0.0,"reason":"<=8 words"}]\n\nAccounts:\n${list}`;

    try {
      const msg = await client.messages.create({
        model: config.relevanceModel,
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      });
      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const parsed = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as Array<{
        handle: string;
        score: number;
        reason: string;
      }>;
      for (const r of parsed) {
        const h = String(r.handle).replace(/^@/, "").toLowerCase();
        const rel: Relevance = { score: Math.max(0, Math.min(1, Number(r.score) || 0)), reason: String(r.reason || "") };
        out.set(h, rel);
        cache[h] = rel;
      }
      saveCache(cache);
      console.log(`  relevance: ${Math.min(i + BATCH, todo.length)}/${todo.length} scored`);
    } catch (err) {
      console.warn(`  relevance batch ${i}-${i + BATCH} failed: ${(err as Error).message}`);
    }
  }
  return out;
}
