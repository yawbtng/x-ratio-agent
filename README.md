# x-ratio-agent

Browser-automation agent (Browserbase + Stagehand) that audits your X/Twitter following and recommends who to unfollow. Full design + reasoning: [`../../tasks/x-ratio-agent-plan.md`](../../tasks/x-ratio-agent-plan.md).

> **Status:** M0 (de-risking spikes). Read-only so far — no unfollowing yet.

## Setup

```bash
pnpm install
cp .env.example .env   # then fill in BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, X_HANDLE
```

## Commands

> Note: the auth script is `auth`, NOT `login` — `pnpm login` is a pnpm built-in that
> logs into the npm registry, not this project.

```bash
pnpm auth     # opens a Browserbase Live View — log into X by hand, then press ENTER. Persists a Context.
pnpm spike0   # verifies X lets you page your ENTIRE following + followers list (the make-or-break check)
```

### Spike 0 — why it runs first

The whole design assumes "follows-you-back" can be computed from set math:
`following ∖ followers`. That only works if X lets us scroll the *complete* lists.
X is known to truncate list pagination at a few thousand entries. Spike 0 compares
what we can scrape against the exact count from X's own GraphQL response (not the
rounded "1.2K" header). If it prints **TRUNCATED**, the approach needs rethinking
before building anything else.

## Safety

- Login is **by hand** in the Live View (no scripted passwords → fewer challenges).
- Sessions run through a **residential proxy** (`USE_PROXY=true`) and `advancedStealth`.
- `data/` (your Context id + social graph) is **gitignored**. Never commit it.
- No write/unfollow actions exist yet — that's M3, gated behind M2 proving trustworthy.
