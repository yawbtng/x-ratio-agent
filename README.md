# x-ratio-agent

Gets an X (Twitter) following count down to a target by unfollowing accounts that don't follow
back and aren't relevant, while keeping the ones you care about. Built on
[Browserbase](https://browserbase.com) + [Stagehand](https://github.com/browserbase/stagehand).

## Demo

<video src="https://github.com/yawbtng/x-ratio-agent/raw/master/assets/demo.mp4" controls muted width="100%"></video>

An autonomous agent driving a real browser on Browserbase, scoring who to keep, and unfollowing on a schedule with zero server. ([watch on Google Drive](https://drive.google.com/file/d/1cAbH93gAGAA7FiFNix14DaU-jz6uTGWh/view) if the player doesn't load.)

## How it works

1. **Scan** — log into X once (persisted as a Browserbase Context) and harvest your full
   followers + following graph by capturing X's own GraphQL responses in-browser.
2. **Score** — rank every non-mutual you follow by relevance (LLM, vs an interest profile) +
   notability, then mark the lowest as `DROP` until the keep-budget hits your target.
3. **Unfollow** — a stateless [Browserbase Function](functions/) visits each DROP account's profile
   page directly and unfollows up to N per run (default `profile` mode; a `list` mode that scrolls
   /following is kept as a fallback). Profile-nav is the robust path because X throttles the
   /following *list* for automated sessions while profile pages still load. It only unfollows
   accounts that still read as "Following", so it's idempotent — no run-state to manage.
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
| `scripts/setup.mjs` | one-command onboarding (`pnpm setup`) |
| `scripts/gen-droplist.mjs` | (re)generate the Function's target list from `data/scored.json` |
| `data/`, `functions/droplist.ts`, `interest-profile.md`, `functions/config.local.ts` | **your personal data — gitignored.** Templates ship as `*.example.*` |
| `.github/workflows/` | the daily trigger |

## Use it yourself

This is wired to be reusable. Nothing here is tied to one account — your follow graph, interest
profile, target list, and Browserbase Context all get generated for *you* and stay on your disk
(gitignored). To run it on your own X:

**Prerequisites**
- A [Browserbase](https://www.browserbase.com) account (a paid plan — a full grind needs long
  sessions + concurrency the free tier caps).
- An [Anthropic API key](https://console.anthropic.com/) (for relevance scoring — a few cents).
- Node 18+ and `pnpm`.

**One command**
```bash
pnpm install
pnpm setup     # checks env → logs you into X (by hand) → harvests → scores → builds your target list
```
`pnpm setup` walks every step and prints the two deploy commands at the end. It's resumable — re-run
it anytime; it won't redo work that's already done.

**Then deploy the daily grind**
```bash
cd functions && npx bb publish main.ts        # builds + prints your Function ID
gh secret set BROWSERBASE_API_KEY --body "<your key>"
gh secret set BB_FUNCTION_ID      --body "<Function ID from publish>"
```
The [GitHub Actions workflow](.github/workflows/daily-unfollow.yml) then pokes your Function a few
times a day. Full runbook: [`functions/DEPLOY.md`](functions/DEPLOY.md).

Prefer to drive it by hand instead of the setup wizard? The underlying steps are
`pnpm auth → pnpm scan → pnpm score → node scripts/gen-droplist.mjs`, then deploy.

> **Safety.** Login is by hand in a Browserbase Live View (no scripted passwords). Unfollowing is
> gentle + capped per run, verifies each action actually stuck, and aborts on any login/challenge
> wall. Proxies are off by default (X rate-limits per-account, not per-IP). Your personal data and
> Browserbase Context never enter git.
