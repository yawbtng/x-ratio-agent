#!/usr/bin/env bash
# Report how many X accounts have been unfollowed so far.
#
#   bash scripts/status.sh            # print the tally to stdout (run anytime)
#   bash scripts/status.sh --notify   # also post a macOS notification + append to data/status-log.txt
#                                      # (this is what the launchd agent runs every 12h)
#
# HOW IT COUNTS: the function is stateless, so there's no running total to read. We sum
# `results.unfollowed` across every daily-unfollow GitHub Actions run (each one's invocation result
# is fetched from Browserbase and cached), then add a fixed BASELINE for the unfollows done manually
# before the daily automation existed. All unfollows now go through the cron, so the sum stays exact.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── config ──────────────────────────────────────────────────────────────────────────────────────
BASELINE=56          # manual unfollows before the cron existed: 46 (local CLI) + 5 + 5 (test runs)
START_FOLLOWING=2468 # approx following count when the project began
TARGET=750           # goal: get following under this
FID="8af7020e-94a7-480e-8df4-aed789742e89"
GH_REPO="yawbtng/x-ratio-agent"   # explicit — the standalone copy isn't a git repo for gh to infer from

# Location-aware: when scheduled, this script runs from a standalone dir OUTSIDE ~/Documents (macOS
# TCC blocks launchd from reading protected folders). There it reads the API key from a local
# .bbkey and keeps its cache/log alongside itself. When run by hand from the repo, it uses ../.env
# and ../data instead.
if [ -f "$SELF_DIR/.bbkey" ]; then
  KEY=$(tr -d '"'"'"' \n' < "$SELF_DIR/.bbkey")
  DATADIR="$SELF_DIR"
elif [ -f "$SELF_DIR/../.env" ]; then
  KEY=$(grep -E '^BROWSERBASE_API_KEY=' "$SELF_DIR/../.env" | cut -d= -f2- | tr -d '"' | tr -d "'")
  DATADIR="$SELF_DIR/../data"
else
  echo "status: no API key found (.bbkey or ../.env)" >&2; exit 1
fi
if [ -z "${KEY:-}" ]; then echo "status: BROWSERBASE_API_KEY is empty" >&2; exit 1; fi

CACHE="$DATADIR/.status-cache.json"
LOG="$DATADIR/status-log.txt"
NOTIFY=0; [ "${1:-}" = "--notify" ] && NOTIFY=1
mkdir -p "$DATADIR"
[ -f "$CACHE" ] || echo '{}' > "$CACHE"

# ── fetch + cache each completed cron run's unfollow count ───────────────────────────────────────
RUNS=$(gh run list -R "$GH_REPO" --workflow=daily-unfollow.yml --limit 200 \
        --json databaseId,status,createdAt 2>/dev/null || echo '[]')

echo "$RUNS" | jq -c '.[] | select(.status=="completed")' 2>/dev/null | while read -r run; do
  rid=$(echo "$run" | jq -r '.databaseId')
  # already counted? skip (this is what keeps it fast as runs pile up)
  [ -n "$(jq -r --arg r "$rid" '.[$r] // empty' "$CACHE")" ] && continue
  # pull the invocation id this run kicked off, out of its log
  iid=$(gh run view "$rid" -R "$GH_REPO" --log 2>/dev/null | grep -oE '"id":"[a-f0-9-]{36}"' | head -1 | grep -oE '[a-f0-9-]{36}')
  [ -z "$iid" ] && continue
  uf=$(curl -s -H "x-bb-api-key: $KEY" \
        "https://api.browserbase.com/v1/functions/invocations/$iid" \
        | jq -r '.results.unfollowed // empty' 2>/dev/null)
  [ -z "$uf" ] && continue   # not finished / no result yet — leave uncached so we retry next time
  tmp=$(mktemp); jq --arg r "$rid" --argjson u "$uf" '.[$r]=$u' "$CACHE" > "$tmp" && mv "$tmp" "$CACHE"
done

# ── totals ────────────────────────────────────────────────────────────────────────────────────────
AUTO=$(jq '[.[]] | add // 0' "$CACHE")
RUNS_COUNTED=$(jq 'length' "$CACHE")
TOTAL=$((BASELINE + AUTO))
FOLLOWING=$((START_FOLLOWING - TOTAL))
REMAINING=$((FOLLOWING - TARGET))

# most recent counted run's date + delta
LATEST=$(echo "$RUNS" | jq -r '[.[] | select(.status=="completed")] | sort_by(.createdAt) | last | .createdAt // "—"' 2>/dev/null)
LATEST_RID=$(echo "$RUNS" | jq -r '[.[] | select(.status=="completed")] | sort_by(.createdAt) | last | .databaseId // empty' 2>/dev/null)
LATEST_DELTA=$(jq -r --arg r "$LATEST_RID" '.[$r] // "?"' "$CACHE")

NOW=$(date "+%Y-%m-%d %H:%M")
ONELINE="${TOTAL} unfollowed (latest cron +${LATEST_DELTA}). ~${FOLLOWING} following, ${REMAINING} to go for <${TARGET}."

# ── output ──────────────────────────────────────────────────────────────────────────────────────
echo "X-ratio agent — unfollow status  ($NOW)"
echo "  Total unfollowed: $TOTAL"
echo "    ├ $BASELINE  before automation (manual)"
echo "    └ $AUTO  via daily cron ($RUNS_COUNTED runs counted)"
echo "  Latest cron run:  ${LATEST%T*:*}  →  +$LATEST_DELTA"
echo "  Following: ~$FOLLOWING of $START_FOLLOWING   ·   $REMAINING to go for goal <$TARGET"

if [ "$NOTIFY" = "1" ]; then
  /usr/bin/osascript -e "display notification \"$ONELINE\" with title \"X-ratio agent\" sound name \"Pop\"" 2>/dev/null || true
  echo "$NOW | total=$TOTAL baseline=$BASELINE auto=$AUTO following=~$FOLLOWING" >> "$LOG"
fi
