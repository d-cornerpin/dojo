#!/bin/bash
LAUNCH_DIR="$HOME/Library/LaunchAgents"

# ONE RULE for "is this service up": launchd's own list, not the exit status of `launchctl load`
# (load's exit status says nothing reliable about whether the job is now running).
# rollback.sh applies the same rule. The list is captured first and read from a here-string, so a
# short-read `grep -q` can never turn into a false "missing" under pipefail.
service_loaded() {
    local listing
    listing="$(launchctl list 2>/dev/null)"
    grep -Eq "(^|[[:space:]])com\.dojo\.$1\$" <<<"$listing"
}

echo "🥋 Starting Agent D.O.J.O..."

if [[ -f "$LAUNCH_DIR/com.dojo.platform.plist" ]]; then
    launchctl load "$LAUNCH_DIR/com.dojo.platform.plist" 2>/dev/null
    launchctl load "$LAUNCH_DIR/com.dojo.watchdog.plist" 2>/dev/null
    missing=""
    service_loaded platform || missing="the platform"
    service_loaded watchdog || missing="${missing:+$missing and }the watchdog"
    if [[ -n "$missing" ]]; then
        echo "❌ Launchd did not load $missing. Try again, or run ~/.dojo/scripts/status.sh to see what is running."
        exit 1
    fi
    echo "✅ Services started"
    echo "   Dashboard: http://localhost:3001"
else
    echo "❌ Launchd plists not found. Run install.sh first."
    exit 1
fi
