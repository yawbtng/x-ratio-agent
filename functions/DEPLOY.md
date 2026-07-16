# Deploying the `x-unfollow` Browserbase Function

The runbook for publishing this Function to your Browserbase account and re-deploying after
code/droplist changes, plus the record of how it works. (First-time setup? Run `pnpm setup` from the
project root — it generates your target list and prints the two commands below.)

## What this is

A stateless Browserbase Function that unfollows up to N accounts on the baked-in `droplist.ts`
(the DROP recommendations from the scan/score pipeline). The browser runs on Browserbase; a daily
GitHub Actions curl is the only external trigger.

- **Two modes (param `mode`).** `"profile"` (DEFAULT) visits each drop account's profile page
  directly and unfollows there — robust, because X throttles the `/following` LIST for automated
  sessions (renders ~3 rows then empty) while profiles still load fine. `"list"` is the original
  inline path (scroll /following, click in place) — cheaper but useless under the list-throttle.
  Kept as a fallback. **Profile mode is what actually makes progress.**
- **No state to manage.** Profile mode shuffles the drop list each run and only unfollows accounts
  that read as still-"Following"; already-done ones are skipped. No run-state, idempotent.
- **Gentle by default** (`max: 20`). X rate-limits per account — small daily batches avoid the
  throttle-to-zero spiral that a 150/day grind triggered before.
- **Deterministic.** Pure DOM clicks off `aria-label="Following"` + `confirmationSheetConfirm`,
  with verify-after (X silently reverts uncommitted unfollows). No LLM, no Anthropic key.

## Prerequisites

1. A Browserbase plan **with browser minutes + proxy allowance** (Free is ~60 min/mo — not enough;
   each gentle run is a few minutes, and the harvest/score steps are minute-heavy too).
2. A valid persisted X-login Context. Its id lives in `functions/config.local.ts` (gitignored,
   written by `pnpm auth` / `pnpm setup`). If login expired, re-run `pnpm auth` to refresh it.

## Steps

# IMPORTANT: use npm here, NOT pnpm. The cloud build runs the Heroku Node buildpack → `npm ci`,
# which REQUIRES a package-lock.json. A pnpm-lock.yaml makes the build fail with
# "npm ci can only install with an existing package-lock.json". (pnpm-lock.yaml is gitignored.)
```bash
cd functions
cp .env.example .env          # fill BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, X_HANDLE
npm install                   # generates package-lock.json (required by the cloud build) + node_modules

# 1. Smoke-test locally first (creates ONE real session — uses a little browser time).
#    Profile-mode dry run: visits 6 shuffled drop profiles, reports their follow-state.
npx bb dev main.ts            # starts local runtime on 127.0.0.1:14113 (entrypoint arg is REQUIRED)
#    in another shell:
curl -X POST http://127.0.0.1:14113/v1/functions/x-unfollow/invoke \
  -H "Content-Type: application/json" -d '{"params":{"dryRun":true}}'
#    expect: ok:true, handles[] like ["wing_vc=following","mem0ai=following",...]
#    (several "=following" means targets are still actionable → profile mode will make progress)

# 2. Real local run, tiny batch, to confirm the unfollow path works:
curl -X POST http://127.0.0.1:14113/v1/functions/x-unfollow/invoke \
  -H "Content-Type: application/json" -d '{"params":{"max":5}}'
#    expect: {"ok":true,"unfollowed":5,"visited":~6,"handles":[...]}
#    (to test the fallback list mode instead: add "mode":"list" to params)

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

`npx bb publish main.ts` prints your Function ID — save it (you'll set it as the `BB_FUNCTION_ID`
GitHub secret below). Re-publish after any code/droplist change; each publish makes a new version.

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

## Verified behavior + operational notes

All confirmed against the live runtime (2026-06-22 → 06-24):

1. **`sessionConfig.browserSettings.context` IS honored** — the auto-created `ctx.session` arrives
   logged into X via the persisted Context. (If a dry run ever returns `error:"not_logged_in"`, the
   Context expired: re-run `pnpm auth` in the parent project to refresh it.)
2. **The runtime installs deps from `package.json`** (node_modules excluded from the archive). The
   cloud build is the Heroku Node buildpack → `npm ci`, which is why a committed `package-lock.json`
   is mandatory (see the npm note above).
3. **15-min execution cap** — profile mode at `max: 20` runs ~5 min (a visit-cap of `max*3+15`
   bounds it). Don't raise `max` past ~30.
4. **Proxies are OFF** — X rate-limits per-account, not per-IP, so a proxy doesn't help and
   residential bandwidth is metered ($12/GB). Only turn it on if X starts IP-blocking you.
5. **Cadence** — X throttles the account under rapid back-to-back sessions. One run/day (the cron)
   is the right pace; don't fire many invocations manually in a short window.

## Refreshing the target list

After re-harvesting + re-scoring (to map the ~1,000 following not yet covered), regenerate the
baked-in list and re-publish:

```bash
node ../scripts/gen-droplist.mjs   # rewrites droplist.ts from data/scored.json
npx bb publish main.ts
```
