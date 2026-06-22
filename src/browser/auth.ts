import Browserbase from "@browserbasehq/sdk";
import fs from "node:fs";
import readline from "node:readline";
import type { Page } from "playwright-core";
import { config, X_BASE } from "../config.js";
import { createStagehand } from "./session.js";

interface ContextFile {
  contextId: string;
  createdAt: string;
}

export function loadContextId(): string | null {
  try {
    const raw = fs.readFileSync(config.paths.contextFile, "utf8");
    return (JSON.parse(raw) as ContextFile).contextId ?? null;
  } catch {
    return null;
  }
}

function saveContextId(contextId: string): void {
  fs.mkdirSync(config.paths.dataDir, { recursive: true });
  const body: ContextFile = { contextId, createdAt: new Date().toISOString() };
  fs.writeFileSync(config.paths.contextFile, JSON.stringify(body, null, 2));
}

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

/**
 * Is this an authenticated X session?
 *
 * Most robust signal: navigate to /home and see where we land. X redirects logged-OUT
 * users off /home into a login flow (/i/flow/login, /login, or the root); a logged-IN
 * session stays on /home. This avoids DOM-testid brittleness and the context-cookie API
 * (which doesn't behave reliably through Stagehand's context wrapper). (plan §1.4)
 */
export async function verifyLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.goto(`${X_BASE}/home`, { waitUntil: "domcontentloaded" });
    // X's logged-out redirect is client-side (SPA) — give it a moment to fire.
    await page.waitForTimeout(4000);
    const path = new URL(page.url()).pathname;
    if (path.startsWith("/home")) return true; // stayed on /home → logged in
    return false; // bounced to /login, /i/flow/login, or /
  } catch {
    return false;
  }
}

/**
 * Interactive login: open a keep-alive Browserbase session bound to a persisted Context,
 * print the Live View URL so the user logs in BY HAND (avoids scripted-password challenges),
 * then verify + persist. Run once; re-run when X expires the session.
 */
export async function runLogin(): Promise<void> {
  const bb = new Browserbase({ apiKey: config.browserbase.apiKey });

  let contextId = loadContextId();
  if (!contextId) {
    const ctx = await bb.contexts.create({ projectId: config.browserbase.projectId });
    contextId = ctx.id;
    saveContextId(ctx.id);
    console.log(`Created new Browserbase Context: ${ctx.id}`);
  } else {
    console.log(`Reusing Context: ${contextId}`);
  }
  if (!contextId) throw new Error("Failed to obtain a Browserbase Context id");

  // keepAlive so the session stays up while you interact with the Live View.
  const stagehand = await createStagehand({ contextId, persist: true, keepAlive: true });
  try {
    const sessionId = stagehand.browserbaseSessionID;
    if (!sessionId) throw new Error("No Browserbase session id — init failed?");

    const page = stagehand.context.pages()[0] as unknown as Page;
    await page.goto(`${X_BASE}/login`, { waitUntil: "domcontentloaded" });

    const live = await bb.sessions.debug(sessionId);
    console.log("\n=== LIVE VIEW — open this in your browser and log into X by hand ===");
    console.log(live.debuggerFullscreenUrl);
    console.log("Tip: complete any captcha/2FA there too.\n");

    await waitForEnter("Press ENTER here once you're logged in...");

    const ok = await verifyLoggedIn(page);
    if (ok) {
      console.log(`✅ Logged in. Context ${contextId} persisted. You can now run: pnpm spike0`);
    } else {
      console.log("❌ Could not confirm a logged-in session. Re-run `pnpm auth` and finish the login in the Live View before pressing ENTER.");
      process.exitCode = 1;
    }
  } finally {
    await stagehand.close(); // cookies sync back to the persisted Context here
  }
}
