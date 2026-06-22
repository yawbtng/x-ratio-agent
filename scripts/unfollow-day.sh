#!/usr/bin/env bash
# Autonomous daily unfollow grind. Runs profile-nav unfollow sessions back-to-back until today's
# DAILY_UNFOLLOW_CAP is hit (handles session drops by relaunching; resumable — never repeats a handle).
# Usage:  DAILY_UNFOLLOW_CAP=150 bash scripts/unfollow-day.sh
set -uo pipefail
cd "$(dirname "$0")/.."

CAP=${DAILY_UNFOLLOW_CAP:-150}
export DAILY_UNFOLLOW_CAP=$CAP
COOLDOWN=${UNFOLLOW_COOLDOWN_SEC:-90}

daily_count() { node -e "try{console.log(require('./data/run-state.json').dailyCount||0)}catch(e){console.log(0)}"; }
total_count() { node -e "try{console.log(require('./data/run-state.json').unfollowedHandles.length||0)}catch(e){console.log(0)}"; }

echo "=== Daily unfollow grind — cap ${CAP}/day ==="
for round in $(seq 1 40); do
  daily=$(daily_count)
  if [ "$daily" -ge "$CAP" ]; then echo "✅ Hit daily cap (${daily}/${CAP})."; break; fi
  echo "--- round ${round} | today ${daily}/${CAP} | total $(total_count) ---"
  # 30-min ceiling per session so a hung run can't stall the grind
  out=$(timeout 1800 pnpm unfollow -- --execute --via-profile --use-recommendations 2>&1)
  echo "$out" | grep -E "✓ unfollowed|✅ Done|Nothing to do|⚠"
  if echo "$out" | grep -q "Nothing to do"; then
    echo "No targets left (cap reached or drop list exhausted)."
    break
  fi
  sleep "$COOLDOWN"
done
echo "=== Day done. Total unfollowed: $(total_count) | today: $(daily_count)/${CAP} ==="
