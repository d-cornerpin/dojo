#!/bin/bash
LAUNCH_DIR="$HOME/Library/LaunchAgents"

echo "🥋 Starting Agent D.O.J.O..."

if [[ -f "$LAUNCH_DIR/com.dojo.platform.plist" ]]; then
    launchctl load "$LAUNCH_DIR/com.dojo.platform.plist" 2>/dev/null
    launchctl load "$LAUNCH_DIR/com.dojo.watchdog.plist" 2>/dev/null
    echo "✅ Services started"
    echo "   Dashboard: http://localhost:3001"
else
    echo "❌ Launchd plists not found. Run install.sh first."
    exit 1
fi
