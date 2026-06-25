#!/bin/bash
# ════════════════════════════════════════
# DOJO local rollback
# Restores the most recent platform backup the updater made, then restarts.
#
# Self-contained on purpose: this must work when the platform server will NOT
# boot (the exact situation it exists for). So no running server, no network,
# no re-download — it only moves local directories and toggles launchd. The
# menu-bar app shells out to this; it is also safe to run by hand over SSH.
# ════════════════════════════════════════
set -uo pipefail

DOJO_DIR="$HOME/.dojo"
PLATFORM_DIR="$DOJO_DIR/platform"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
BACKUP_PREFIX="platform.backup-"

# 1. Find the newest platform.backup-* directory. The updater stamps one with
#    the outgoing version right before each update, so newest == the version we
#    were on before the update that just broke things — exactly the target.
newest_backup=""
newest_mtime=0
for d in "$DOJO_DIR/$BACKUP_PREFIX"*; do
    [ -d "$d" ] || continue
    m="$(stat -f %m "$d" 2>/dev/null || echo 0)"
    if [ "$m" -gt "$newest_mtime" ]; then
        newest_mtime="$m"
        newest_backup="$d"
    fi
done

if [ -z "$newest_backup" ]; then
    echo "ERROR: No ${BACKUP_PREFIX}* directory found in $DOJO_DIR — nothing to roll back to."
    exit 1
fi

target_ver="$(basename "$newest_backup" | sed "s/^${BACKUP_PREFIX}//")"

# Current version, best-effort and without a node dependency (node may be the
# very thing that's broken).
cur_ver="unknown"
if [ -f "$PLATFORM_DIR/package.json" ]; then
    parsed="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PLATFORM_DIR/package.json" | head -1)"
    [ -n "$parsed" ] && cur_ver="$parsed"
fi

echo "🥋 Rolling back DOJO: $cur_ver -> $target_ver"

# 2. Stop services.
echo "   Stopping services..."
launchctl unload "$LAUNCH_DIR/com.dojo.platform.plist" 2>/dev/null
launchctl unload "$LAUNCH_DIR/com.dojo.watchdog.plist" 2>/dev/null

# 3. Set the current (failed) build aside for diagnosis, then move the backup
#    into place. Moves (not copies) so the swap is fast and uses no extra disk;
#    older backups remain for a deeper rollback if needed.
ts="$(date +%Y%m%d-%H%M%S)"
if [ -d "$PLATFORM_DIR" ]; then
    failed_dir="$DOJO_DIR/platform.failed-${cur_ver}-${ts}"
    echo "   Preserving current build -> $(basename "$failed_dir")"
    if ! mv "$PLATFORM_DIR" "$failed_dir"; then
        echo "ERROR: could not move the current platform aside; aborting before any data loss."
        launchctl load "$LAUNCH_DIR/com.dojo.platform.plist" 2>/dev/null
        exit 1
    fi
fi

echo "   Restoring $target_ver..."
if ! mv "$newest_backup" "$PLATFORM_DIR"; then
    echo "ERROR: could not move the backup into place. The previous build is at:"
    echo "       ${failed_dir:-<unchanged>}"
    echo "       Restore it manually with: mv \"$failed_dir\" \"$PLATFORM_DIR\""
    exit 1
fi

# 4. Restart.
echo "   Starting services..."
launchctl load "$LAUNCH_DIR/com.dojo.platform.plist" 2>/dev/null
launchctl load "$LAUNCH_DIR/com.dojo.watchdog.plist" 2>/dev/null

echo "✅ Rolled back to $target_ver. The server is restarting."
if [ -n "${failed_dir:-}" ]; then
    echo "   The failed build was kept at $(basename "$failed_dir") for diagnosis; delete it once you no longer need it."
fi
