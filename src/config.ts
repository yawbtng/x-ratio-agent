import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}. Copy .env.example → .env and fill it in.`);
  return v;
}

export const config = {
  browserbase: {
    apiKey: required("BROWSERBASE_API_KEY"),
    projectId: required("BROWSERBASE_PROJECT_ID"),
  },
  // X handle without @
  xHandle: required("X_HANDLE").replace(/^@/, ""),
  // Goal: get following under this number (keep mutuals + your chosen non-followers).
  targetFollowing: Number(process.env.TARGET_FOLLOWING ?? 700),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY, // optional until M2
  // Proxies OFF by default — residential proxy bandwidth is metered ($12/GB) and blew past the plan
  // allowance. Authenticated via Context, so datacenter IPs work fine. Set USE_PROXY=true to force on.
  useProxy: (process.env.USE_PROXY ?? "false").toLowerCase() === "true",

  // Stagehand uses this for act/extract/observe (not needed by Spike 0).
  model: { modelName: "anthropic/claude-haiku-4-5", apiKey: process.env.ANTHROPIC_API_KEY },

  // Browserbase session max duration (seconds). Default ~5min is far too short for a full
  // following+followers scrape. Dev plan allows long sessions. Override via BB_SESSION_TIMEOUT_SEC.
  sessionTimeoutSec: Number(process.env.BB_SESSION_TIMEOUT_SEC ?? 3600),

  paths: {
    dataDir: path.join(projectRoot, "data"),
    contextFile: path.join(projectRoot, "data", "context.json"),
    allowlistFile: path.join(projectRoot, "data", "allowlist.txt"), // one @handle per line; always KEEP
    scoredFile: path.join(projectRoot, "data", "scored.json"),
    relevanceCacheFile: path.join(projectRoot, "data", "relevance-cache.json"),
    interestProfileFile: path.join(projectRoot, "interest-profile.md"),
    runStateFile: path.join(projectRoot, "data", "run-state.json"), // unfollow progress + daily cap
  },

  // Relevance scoring weights: keepScore = wRelevance*relevance + wNotability*notability
  scoreWeights: { relevance: 0.7, notability: 0.3 },
  relevanceModel: "claude-haiku-4-5-20251001",

  // M3 write-path safety. Unfollowing your REAL account — conservative by default.
  unfollow: {
    dailyCap: Number(process.env.DAILY_UNFOLLOW_CAP ?? 50), // max unfollows per calendar day (persisted)
    minDelayMs: 6000, // randomized human-like pacing between unfollows
    maxDelayMs: 18000,
    longPauseEvery: 12, // every N unfollows, take a longer breather
    longPauseMs: 45000,
  },

  // Scroll tuning for the virtualized-list reader (see plan §1.2).
  scroll: {
    stepFraction: 0.9, // scroll 90% of viewport per tick (overlap to avoid skipping recycled rows)
    settleMs: 700, // wait for new rows to render
    // X drip-feeds the following list (~50 rows, then a ~30-50s rate-limit pause). The stall
    // budget must be large enough to ride those pauses without concluding "end of list" early.
    stagnantRoundsToStop: 14, // "no new rows after K patient rounds" = honest end-sentinel
    maxStallWaitMs: 12000, // cap the escalating per-stall wait
    maxScrolls: 6000, // safety backstop (a full drip harvest is many rounds)
    completenessSlack: 0.05, // captured must be within 5% of exact count to call it "complete"
  },
} as const;

export const X_BASE = "https://x.com";
