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
echo "  • Back up ALL your data (database, uploaded files, the whole data folder, imported voice files, prompts, techniques, secrets) to ~/dojo-backup-{timestamp}"
echo "  • Remove only the DOJO app from your system; nothing is removed unless every copy succeeded"
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
# A refusal must leave the box running: the services were stopped above, so every "nothing was
# removed" exit starts both again first and says so.
# "Up" is decided by launchd's own list (the one rule start.sh and rollback.sh use), not by the exit
# status of `launchctl load`.
service_loaded() {
  local listing
  listing="$(launchctl list 2>/dev/null)"
  grep -Eq "(^|[[:space:]])com\.dojo\.$1\$" <<<"$listing"
}
restart_services() {
  local svc down=""
  for svc in platform watchdog; do
    launchctl load "$LAUNCH_DIR/com.dojo.$svc.plist" 2>/dev/null
  done
  # Final round (owner rule: the Dojo does the work): a service that did not load is started with Dojo's own start
  # script before anything is said; only what is still down after that is reported, as a fact.
  if { ! service_loaded platform || ! service_loaded watchdog; } && [ -f "$DOJO_DIR/scripts/start.sh" ]; then
    bash "$DOJO_DIR/scripts/start.sh" >/dev/null 2>&1 || true
  fi
  for svc in platform watchdog; do
    service_loaded "$svc" || down="${down:+$down and }the $svc"
  done
  if [ -n "$down" ]; then
    echo "   Nothing was changed, but $down did not start."
  else
    echo "   Dojo has been started again; nothing was changed."
  fi
}
copy_failed=""
mkdir -p "$BACKUP_DIR" || copy_failed="$copy_failed backup-folder"
if [ -f "$DOJO_DIR/data/dojo.db" ]; then
  # Every step's exit status counts: a copy cut short by a full disk leaves a non-empty, broken
  # file, so "the file exists" proves nothing. The saved database must also pass a check.
  db_ok=0
  if command -v sqlite3 >/dev/null 2>&1 && sqlite3 "$DOJO_DIR/data/dojo.db" ".backup '$BACKUP_DIR/dojo.db'" 2>/dev/null; then
    db_ok=1
  else
    rm -f "$BACKUP_DIR/dojo.db"
    if cp "$DOJO_DIR/data/dojo.db" "$BACKUP_DIR/" 2>/dev/null; then
      db_ok=1
      for ext in -wal -shm; do
        if [ -e "$DOJO_DIR/data/dojo.db$ext" ]; then
          cp "$DOJO_DIR/data/dojo.db$ext" "$BACKUP_DIR/" 2>/dev/null || db_ok=0
        fi
      done
      [ "$(wc -c < "$BACKUP_DIR/dojo.db" 2>/dev/null | tr -d ' ')" = "$(wc -c < "$DOJO_DIR/data/dojo.db" | tr -d ' ')" ] || db_ok=0
    fi
  fi
  if [ "$db_ok" = 1 ] && [ ! -s "$BACKUP_DIR/dojo.db" ]; then db_ok=0; fi
  if [ "$db_ok" = 1 ] && command -v sqlite3 >/dev/null 2>&1; then
    [ "$(sqlite3 "$BACKUP_DIR/dojo.db" 'PRAGMA quick_check' 2>/dev/null | head -1)" = "ok" ] || db_ok=0
  fi
  [ "$db_ok" = 1 ] || copy_failed="$copy_failed dojo.db"
fi
for item in secrets.yaml prompts techniques; do
  if [ -e "$DOJO_DIR/$item" ]; then
    cp -R "$DOJO_DIR/$item" "$BACKUP_DIR/" 2>/dev/null || copy_failed="$copy_failed $item"
  fi
done

# Everything else the person made lives under ~/.dojo too (uploads, the rest of data/, memory files,
# custom voice imports, loose technique scripts, ...). Copy every top-level entry except app code
# the installer puts back (platform, update backups and set-aside builds, watchdog, scripts, bin,
# logs, the icon, the lock) and what was saved above. A folder this list does not know about is
# copied, never skipped. If ANY copy fails, nothing is removed.
for entry in "$DOJO_DIR"/* "$DOJO_DIR"/.[!.]*; do
  [ -e "$entry" ] || continue
  name="$(basename "$entry")"
  case "$name" in
    platform|platform.backup-*|platform.failed-*|platform.partial-*|platform.staging*|watchdog|watchdog.staging-*|watchdog.old-*|scripts|bin|logs|dojologo.pdf|rollback.lock|rollback.lock.*|secrets.yaml|prompts|techniques|.DS_Store) continue ;;
    data)
      mkdir -p "$BACKUP_DIR/data" || { copy_failed="$copy_failed data"; continue; }
      for f in "$entry"/* "$entry"/.[!.]*; do
        [ -e "$f" ] || continue
        case "$(basename "$f")" in dojo.db|dojo.db-wal|dojo.db-shm|.DS_Store) continue ;; esac
        cp -R "$f" "$BACKUP_DIR/data/" 2>/dev/null || copy_failed="$copy_failed data/$(basename "$f")"
      done ;;
    voice)
      # Everything the person imported or made; only the downloaded models (they come back on first use) are left out.
      mkdir -p "$BACKUP_DIR/voice" || { copy_failed="$copy_failed voice"; continue; }
      for f in "$entry"/* "$entry"/.[!.]*; do
        [ -e "$f" ] || continue
        case "$(basename "$f")" in models|.DS_Store) continue ;; esac
        cp -R "$f" "$BACKUP_DIR/voice/" 2>/dev/null || copy_failed="$copy_failed voice/$(basename "$f")"
      done ;;
    *)
      cp -R "$entry" "$BACKUP_DIR/" 2>/dev/null || copy_failed="$copy_failed $name" ;;
  esac
done
if [ -n "$copy_failed" ]; then
  echo "❌ These parts of your data could not be copied to $BACKUP_DIR, so nothing was removed:$copy_failed"
  echo "   Free some disk space or fix the folder's permissions, then run the uninstaller again."
  restart_services
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
