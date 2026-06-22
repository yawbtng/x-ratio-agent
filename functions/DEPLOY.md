# Deploying the `x-unfollow` Browserbase Function

Built and ready. **Not yet deployed** — deploy is blocked until the Browserbase plan has browser
minutes (the account hit `402 Free plan browser minutes limit reached` on 2026-06-21). Once that's
resolved, this is ~10 minutes of work.

## What this is

A stateless Browserbase Function that walks your `/following` list and unfollows up to N accounts
that are on the baked-in `droplist.ts` (the DROP recommendations from the scan/score pipeline).
The browser runs on Browserbase; a daily GitHub Actions curl is the only external trigger.

- **No state to manage.** Already-unfollowed accounts have left the list, so they never reappear.
- **Gentle by default** (`max: 20`). X rate-limits per account — small daily batches avoid the
  throttle-to-zero spiral that a 150/day grind triggered before.
- **Deterministic.** Pure DOM clicks off `aria-label="Following"` + `confirmationSheetConfirm`.
  No LLM, no Anthropic key.

## Prerequisites

1. A Browserbase plan **with browser minutes + proxy allowance** (Free is ~60 min/mo — not enough;
   each gentle run is a few minutes, and the harvest/score steps are minute-heavy too).
2. The persisted X-login Context still valid: `X_CONTEXT_ID=8c6f0abe-73d1-4541-b796-eff6c30adbcd`.
   If login expired, re-run `pnpm auth` in the parent project to refresh the Context first.

## Steps

# IMPORTANT: use npm here, NOT pnpm. The cloud build runs the Heroku Node buildpack → `npm ci`,
# which REQUIRES a package-lock.json. A pnpm-lock.yaml makes the build fail with
# "npm ci can only install with an existing package-lock.json". (pnpm-lock.yaml is gitignored.)
```bash
cd functions
cp .env.example .env          # fill BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, X_HANDLE
npm install                   # generates package-lock.json (required by the cloud build) + node_modules

# 1. Smoke-test locally first (creates ONE real session — uses a little browser time).
#    Dry run: confirms login + that the list renders (also prints a drop-target diagnostic).
npx bb dev main.ts            # starts local runtime on 127.0.0.1:14113 (entrypoint arg is REQUIRED)
#    in another shell:
curl -X POST http://127.0.0.1:14113/v1/functions/x-unfollow/invoke \
  -H "Content-Type: application/json" -d '{"params":{"dryRun":true}}'
#    expect: ok:true, and handles[] showing lastScan_dropTargets > 0 (real targets visible)

# 2. Real local run, tiny batch, to confirm the click path works:
curl -X POST http://127.0.0.1:14113/v1/functions/x-unfollow/invoke \
  -H "Content-Type: application/json" -d '{"params":{"max":5}}'
#    expect: {"ok":true,"unfollowed":5,"handles":[...]}

# 3. Publish to Browserbase (entrypoint arg REQUIRED):
npx bb publish main.ts        # uploads, builds (~1 min), prints the Function ID. Save it.

# 4. Invoke the DEPLOYED function (async — returns {status:PENDING, id}); poll for the result:
curl -X POST https://api.browserbase.com/v1/functions/FUNCTION_ID/invoke \
  -H "x-bb-api-key: $BROWSERBASE_API_KEY" \
  -H "Content-Type: application/json" -d '{"params":{"max":5}}'
#    then: curl -H "x-bb-api-key: $KEY" https://api.browserbase.com/v1/functions/invocations/INVOCATION_ID
#    NOTE: don't fire many invocations back-to-back — X throttles the account and runs return
#    unfollowed:0. One run/day (the cron) is the right cadence.
```

**Currently deployed:** Function ID `8af7020e-94a7-480e-8df4-aed789742e89` (project `d9490f14-...`).
Re-publish with `npx bb publish main.ts` after any code/droplist change (it makes a new version).

## Wire the daily trigger (GitHub Actions)

The workflow is at `../.github/workflows/daily-unfollow.yml` (note: GitHub reads workflows from the
**repo root** — when you push, `projects/x-ratio-agent/` must be the repo root, or move the
`.github/` dir up to wherever the root is).

Set two repo secrets:

```bash
gh secret set BROWSERBASE_API_KEY --body "$BROWSERBASE_API_KEY"
gh secret set BB_FUNCTION_ID      --body "FUNCTION_ID_FROM_PUBLISH"
```

Then it fires daily at 17:00 UTC, or run it on demand from the Actions tab (`workflow_dispatch`,
with an optional `max`). A non-2xx response (e.g. a future 402) fails the run so you get notified.

## Assumptions to verify on first deploy (couldn't test under the 402)

These are the spots where the code follows the documented/typed API but hasn't run against the live
runtime. Check them on the first `bb dev` / `bb publish`:

1. **`sessionConfig.browserSettings.context` is honored.** The whole design assumes the runtime
   creates `ctx.session` *with our Context*, so the browser arrives logged into X. The type is
   `Omit<SessionCreateParams, "projectId">`, which includes `browserSettings.context` — but if the
   dry run returns `{"ok":false,"error":"not_logged_in"}`, the runtime ignored it. Fallback: create
   our own Stagehand/SDK session inside the handler with the Context (the parent project's
   `src/browser/session.ts` is the exact pattern) instead of using `ctx.session`.
2. **The runtime installs deps from `package.json`** (node_modules is excluded from the archive).
   If `playwright-core` is missing at runtime, pin it / check the publish logs.
3. **15-min execution cap.** `max: 20` at ~8s pacing ≈ 4 min, well under. Don't raise `max` past
   ~30 or a long throttle pause could blow the cap.
4. **Proxy bandwidth.** `proxies: true` matches local; residential proxy is metered separately from
   browser minutes — watch both in the Browserbase dashboard.

## Refreshing the target list

After re-harvesting + re-scoring (to map the ~1,000 following not yet covered), regenerate the
baked-in list and re-publish:

```bash
node ../scripts/gen-droplist.mjs   # rewrites droplist.ts from data/scored.json
pnpm bb publish main.ts
```
