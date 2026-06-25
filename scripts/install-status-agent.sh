#!/usr/bin/env bash
# Install the 12-hour unfollow-status notifier as a macOS launchd agent.
#
# Why this exists: macOS TCC blocks background (launchd) processes from reading ~/Documents, so the
# scheduled job can't live in the repo. This copies a self-contained status.sh + the API key into
#   ~/Library/Application Support/x-ratio-status/
# (not TCC-protected) and registers a launchd agent that runs it every 12h with a notification.
#
#   bash scripts/install-status-agent.sh          # install / reinstall
#   bash scripts/install-status-agent.sh --uninstall
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$HOME/Library/Application Support/x-ratio-status"
PLIST="$HOME/Library/LaunchAgents/com.xratioagent.status.plist"
LABEL="com.xratioagent.status"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$APP_DIR"
  echo "Uninstalled the status agent."
  exit 0
fi

# 1. self-contained copy outside ~/Documents
mkdir -p "$APP_DIR"
cp "$REPO/scripts/status.sh" "$APP_DIR/status.sh"
chmod +x "$APP_DIR/status.sh"

# 2. the Browserbase API key (read once from the repo .env), locked down
grep -E '^BROWSERBASE_API_KEY=' "$REPO/.env" | cut -d= -f2- | tr -d '"' | tr -d "'" > "$APP_DIR/.bbkey"
chmod 600 "$APP_DIR/.bbkey"

# 3. the launchd plist, pointing at the standalone script
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${APP_DIR}/status.sh</string>
    <string>--notify</string>
  </array>
  <key>StartInterval</key><integer>43200</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${APP_DIR}/cron.out</string>
  <key>StandardErrorPath</key><string>${APP_DIR}/cron.err</string>
</dict>
</plist>
PLISTEOF

# 4. (re)load it
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo "Installed. Runs every 12h (and once now)."
echo "  script: $APP_DIR/status.sh"
echo "  plist:  $PLIST"
echo "  uninstall: bash scripts/install-status-agent.sh --uninstall"
