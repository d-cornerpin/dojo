#!/bin/bash

# ════════════════════════════════════════
# Agent D.O.J.O. — Uninstaller
# ════════════════════════════════════════

DOJO_DIR="$HOME/.dojo"
LAUNCH_DIR="$HOME/Library/LaunchAgents"

echo ""
echo "🥋 Agent D.O.J.O. Uninstaller"
echo ""
echo "This will:"
echo "  • Stop all DOJO services"
echo "  • Back up your data to ~/dojo-backup-{timestamp}"
echo "  • Remove DOJO from your system"
echo ""
read -p "Are you sure? (y/N) " -n 1 -r
echo
[[ ! $REPLY =~ ^[Yy]$ ]] && echo "Cancelled." && exit 0

echo ""

# Stop services
echo "🛑 Stopping services..."
launchctl unload "$LAUNCH_DIR/com.dojo.platform.plist" 2>/dev/null
launchctl unload "$LAUNCH_DIR/com.dojo.watchdog.plist" 2>/dev/null

# Backup data
BACKUP_DIR="$HOME/dojo-backup-$(date +%Y%m%d-%H%M%S)"
echo "💾 Backing up data to $BACKUP_DIR..."
mkdir -p "$BACKUP_DIR"
cp "$DOJO_DIR/data/dojo.db" "$BACKUP_DIR/" 2>/dev/null || true
cp "$DOJO_DIR/secrets.yaml" "$BACKUP_DIR/" 2>/dev/null || true
cp -r "$DOJO_DIR/prompts" "$BACKUP_DIR/" 2>/dev/null || true
cp -r "$DOJO_DIR/techniques" "$BACKUP_DIR/" 2>/dev/null || true

# Remove launchd plists
echo "🗑  Removing system services..."
rm -f "$LAUNCH_DIR/com.dojo.platform.plist"
rm -f "$LAUNCH_DIR/com.dojo.watchdog.plist"

# Remove menu bar app
echo "🗑  Removing menu bar app..."
osascript -e 'tell application "DOJO" to quit' 2>/dev/null || true
sleep 1
rm -rf /Applications/DOJO.app
osascript -e 'tell application "System Events" to delete login item "DOJO"' 2>/dev/null || true

# Remove DOJO directory
echo "🗑  Removing DOJO files..."
rm -rf "$DOJO_DIR"

echo ""
echo "════════════════════════════════════════"
echo "  🥋 Agent D.O.J.O. uninstalled"
echo "════════════════════════════════════════"
echo ""
echo "  Your data was backed up to:"
echo "  $BACKUP_DIR"
echo ""
echo "  To fully clean up, you can also remove:"
echo "  • Homebrew packages: brew uninstall node@22 cliclick cloudflared"
echo "  • Ollama: brew uninstall ollama"
echo ""
