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
echo "  • Back up your data (database, uploads, prompts, techniques, secrets) to ~/dojo-backup-{timestamp}"
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
if [ -f "$DOJO_DIR/data/dojo.db" ]; then
  command -v sqlite3 >/dev/null 2>&1 && sqlite3 "$DOJO_DIR/data/dojo.db" ".backup '$BACKUP_DIR/dojo.db'" 2>/dev/null || {
    rm -f "$BACKUP_DIR/dojo.db"
    cp "$DOJO_DIR/data/dojo.db" "$BACKUP_DIR/" 2>/dev/null || true
    cp "$DOJO_DIR/data/dojo.db-wal" "$BACKUP_DIR/" 2>/dev/null || true
    cp "$DOJO_DIR/data/dojo.db-shm" "$BACKUP_DIR/" 2>/dev/null || true
  }
fi
cp "$DOJO_DIR/secrets.yaml" "$BACKUP_DIR/" 2>/dev/null || true
cp -r "$DOJO_DIR/prompts" "$BACKUP_DIR/" 2>/dev/null || true
cp -r "$DOJO_DIR/techniques" "$BACKUP_DIR/" 2>/dev/null || true
if [ -f "$DOJO_DIR/data/dojo.db" ] && [ ! -s "$BACKUP_DIR/dojo.db" ]; then
  echo "❌ Your database could not be copied to $BACKUP_DIR, so nothing was removed."
  echo "   Free some disk space or fix the folder's permissions, then run the uninstaller again."
  exit 1
fi
if [ -f "$DOJO_DIR/secrets.yaml" ] && [ ! -s "$BACKUP_DIR/secrets.yaml" ]; then
  echo "❌ Your secrets file could not be copied to $BACKUP_DIR, so nothing was removed."
  exit 1
fi

# Everything else the person made lives under ~/.dojo too (uploads, the rest of data/, memory files,
# custom voice imports, loose technique scripts, ...). Copy every top-level entry except app code
# the installer puts back (platform, update backups and set-aside builds, watchdog, scripts, bin,
# logs, the icon, the lock) and what was saved above. A folder this list does not know about is
# copied, never skipped. If ANY copy fails, nothing is removed.
copy_failed=""
for entry in "$DOJO_DIR"/* "$DOJO_DIR"/.[!.]*; do
  [ -e "$entry" ] || continue
  name="$(basename "$entry")"
  case "$name" in
    platform|platform.backup-*|platform.failed-*|platform.staging*|watchdog|scripts|bin|logs|dojologo.pdf|rollback.lock|secrets.yaml|prompts|techniques|.DS_Store) continue ;;
    data)
      mkdir -p "$BACKUP_DIR/data" || { copy_failed="$copy_failed data"; continue; }
      for f in "$entry"/* "$entry"/.[!.]*; do
        [ -e "$f" ] || continue
        case "$(basename "$f")" in dojo.db|dojo.db-wal|dojo.db-shm|dojo.sqlite|.DS_Store) continue ;; esac
        cp -R "$f" "$BACKUP_DIR/data/" 2>/dev/null || copy_failed="$copy_failed data/$(basename "$f")"
      done ;;
    voice)
      # Only the person's own imports; the downloaded models come back on first use.
      if [ -d "$entry/custom" ]; then
        mkdir -p "$BACKUP_DIR/voice" && cp -R "$entry/custom" "$BACKUP_DIR/voice/" 2>/dev/null || copy_failed="$copy_failed voice/custom"
      fi ;;
    tools)
      # Tool docs regenerate; scripts a technique left loose in tools/ do not.
      for f in "$entry"/*; do
        [ -f "$f" ] || continue
        case "$f" in *.md) continue ;; esac
        mkdir -p "$BACKUP_DIR/tools" && cp -R "$f" "$BACKUP_DIR/tools/" 2>/dev/null || copy_failed="$copy_failed tools/$(basename "$f")"
      done ;;
    *)
      cp -R "$entry" "$BACKUP_DIR/" 2>/dev/null || copy_failed="$copy_failed $name" ;;
  esac
done
if [ -n "$copy_failed" ]; then
  echo "❌ These parts of your data could not be copied to $BACKUP_DIR, so nothing was removed:$copy_failed"
  echo "   Free some disk space or fix the folder's permissions, then run the uninstaller again."
  exit 1
fi

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
