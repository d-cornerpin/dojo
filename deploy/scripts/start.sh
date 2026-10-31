#!/bin/bash
LAUNCH_DIR="$HOME/Library/LaunchAgents"

echo "🥋 Starting Agent D.O.J.O..."

if [[ -f "$LAUNCH_DIR/com.dojo.platform.plist" ]]; then
    launchctl load "$LAUNCH_DIR/com.dojo.platform.plist" 2>/dev/null
    launchctl load "$LAUNCH_DIR/com.dojo.watchdog.plist" 2>/dev/null
    missing=""
    launchctl list 2>/dev/null | grep -q 'com\.dojo\.platform' || missing="the platform"
    launchctl list 2>/dev/null | grep -q 'com\.dojo\.watchdog' || missing="${missing:+$missing and }the watchdog"
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
