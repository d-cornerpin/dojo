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

# ── Mutual exclusion (D-F) ──
# The menu-bar MANUAL rollback and the watchdog's AUTOMATIC rollback both shell
# THIS same script; they must never run at the same time (two concurrent platform
# moves would race and could lose the build). Putting the lock in the script
# itself means both callers inherit it. `mkdir` is an atomic lock on POSIX:
# exactly one caller can create the directory; a second caller fails fast. The
# lock is released on ANY exit (success, error, or signal) via the trap.
mkdir -p "$DOJO_DIR" 2>/dev/null || true
LOCK_DIR="$DOJO_DIR/rollback.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "ERROR: another rollback is already in progress ($LOCK_DIR). Aborting to avoid a concurrent restore."
    exit 1
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

# Emit a fixed-width, lexically-sortable key for a version string so a plain
# string comparison orders versions correctly. Mirrors the engine's
# compareVersions precedence: higher base wins; a stable release outranks any
# pre-release of the SAME base; two pre-releases compare by ordinal. Malformed
# segments clamp to 0 so a hand-made dir name can never crash the recovery path.
version_sort_key() {
    local v="$1" base pre maj min pat prerank pren
    base="${v%%-*}"
    if [ "$v" = "$base" ]; then
        prerank=1; pren=0            # stable: outranks any pre-release of this base
    else
        prerank=0
        pre="${v#*-}"
        pren="$(printf '%s' "$pre" | tr -cd '0-9')"   # trailing/embedded digits, e.g. preflight.2 -> 2
    fi
    IFS='.' read -r maj min pat _ <<< "$base"
    maj="$(printf '%s' "${maj:-0}" | tr -cd '0-9')"
    min="$(printf '%s' "${min:-0}" | tr -cd '0-9')"
    pat="$(printf '%s' "${pat:-0}" | tr -cd '0-9')"
    printf '%04d%04d%04d%d%04d' \
        "$((10#${maj:-0}))" "$((10#${min:-0}))" "$((10#${pat:-0}))" \
        "$prerank" "$((10#${pren:-0}))"
}

# 1. Find the backup to restore. Each update stamps platform.backup-<version>
#    with the OUTGOING version right before overwriting, so the HIGHEST-version
#    backup is the most recent good build we left, exactly the rollback target.
#    Order by the version parsed from the NAME, not the directory mtime (FA-D5):
#    a touched mtime, a Time-Machine-restored copy, or a prune interrupted
#    mid-run must not make us restore the wrong build. mtime only breaks ties
#    between two dirs that parse to the same version.
newest_backup=""
newest_key=""
newest_mtime=0
for d in "$DOJO_DIR/$BACKUP_PREFIX"*; do
    [ -d "$d" ] || continue
    ver="$(basename "$d" | sed "s/^${BACKUP_PREFIX}//")"
    key="$(version_sort_key "$ver")"
    m="$(stat -f %m "$d" 2>/dev/null || echo 0)"
    if [ -z "$newest_backup" ] \
       || [[ "$key" > "$newest_key" ]] \
       || { [ "$key" = "$newest_key" ] && [ "$m" -gt "$newest_mtime" ]; }; then
        newest_key="$key"
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
