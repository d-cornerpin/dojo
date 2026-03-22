#!/bin/bash
LAUNCH_DIR="$HOME/Library/LaunchAgents"

echo "🥋 Stopping Agent D.O.J.O..."

launchctl unload "$LAUNCH_DIR/com.dojo.platform.plist" 2>/dev/null
launchctl unload "$LAUNCH_DIR/com.dojo.watchdog.plist" 2>/dev/null

echo "✅ Services stopped"
