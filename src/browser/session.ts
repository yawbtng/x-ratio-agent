import { Stagehand } from "@browserbasehq/stagehand";
import { config } from "../config.js";

export interface SessionOpts {
  /** Browserbase Context id to reuse (persisted X login). Omit to run without a context. */
  contextId?: string;
  /** Persist cookie/storage changes back to the Context (set true during login). */
  persist?: boolean;
  /** Keep the Browserbase session alive past stagehand.close() — used for interactive login. */
  keepAlive?: boolean;
}

/**
 * One place that constructs a Browserbase-backed Stagehand session for this project.
 *
 *   env=BROWSERBASE → cloud Chrome. advancedStealth + proxies lower bot-detection on X.
 *   browserSettings.context → reuse the persisted login so we don't re-auth every run.
 *
 * Returns an initialized Stagehand (await init() already called). Caller owns close().
 */
export async function createStagehand(opts: SessionOpts = {}): Promise<Stagehand> {
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: config.browserbase.apiKey,
    projectId: config.browserbase.projectId,
    model: config.model,
    verbose: 1,
    keepAlive: opts.keepAlive ?? false,
    browserbaseSessionCreateParams: {
      projectId: config.browserbase.projectId,
      keepAlive: opts.keepAlive ?? false,
      timeout: config.sessionTimeoutSec, // default ~5min is too short for a full scrape
      proxies: config.useProxy, // residential proxy — baseline for X (plan, outside-review). Available on Dev plan.
      browserSettings: {
        // NOTE: advancedStealth ("verified mode") is ENTERPRISE-only — setting it 403s on Dev/Hobby.
        // Default sessions still get baseline anti-detection; we lean on real-browser + residential proxy.
        ...(opts.contextId
          ? { context: { id: opts.contextId, persist: opts.persist ?? true } }
          : {}),
      },
    },
  });

  await stagehand.init();
  return stagehand;
}
