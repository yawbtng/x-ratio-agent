# x-ratio-agent

Gets an X (Twitter) following count down to a target by unfollowing accounts that don't follow
back and aren't relevant, while keeping the ones you care about. Built on
[Browserbase](https://browserbase.com) + [Stagehand](https://github.com/browserbase/stagehand).

## How it works

1. **Scan** — log into X once (persisted as a Browserbase Context) and harvest your full
   followers + following graph by capturing X's own GraphQL responses in-browser.
2. **Score** — rank every non-mutual you follow by relevance (LLM, vs an interest profile) +
   notability, then mark the lowest as `DROP` until the keep-budget hits your target.
3. **Unfollow** — a stateless [Browserbase Function](functions/) walks your `/following` list and
   unfollows up to N accounts on the DROP list per run. Already-unfollowed accounts have left the
   list, so it's naturally idempotent — no run-state to manage.
4. **Automate** — a daily [GitHub Actions workflow](.github/workflows/daily-unfollow.yml) pokes the
   function's URL. The browser work all runs on Browserbase; GitHub is just the alarm clock.

## Why gentle

X rate-limits at the **account** level (not IP/browser), so proxies and fresh sessions can't speed
it up. A small daily batch (~20) is what avoids the throttle-to-zero spiral. Getting from ~2,400 to
under 750 is a multi-week grind by design, not a one-shot.

## Layout

| Path | What |
|---|---|
| `src/` | the scan → score → report pipeline + local unfollow CLI (`pnpm cli`) |
| `functions/` | the deployed Browserbase Function + [`DEPLOY.md`](functions/DEPLOY.md) |
| `scripts/gen-droplist.mjs` | regenerate the function's baked-in target list from `scored.json` |
| `data/` | harvested graph, scores, droplist source (personal — private repo only) |
| `.github/workflows/` | the daily trigger |

## Run it

Local pipeline: `pnpm install`, copy `.env.example` → `.env`, then `pnpm auth` → `pnpm scan` →
`pnpm score` → `pnpm report`. Deploy the daily grind: see [`functions/DEPLOY.md`](functions/DEPLOY.md).

> Safety: login is by hand in a Browserbase Live View (no scripted passwords). Sessions use a
> residential proxy. Unfollowing is gentle + capped, verifies each action, and aborts on any
> login/challenge wall.
