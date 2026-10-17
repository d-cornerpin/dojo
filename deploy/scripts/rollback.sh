#!/bin/bash
# ════════════════════════════════════════
# DOJO local rollback
# Restores the most recent platform backup the updater made, then restarts.
#
# Self-contained on purpose: this must work when the platform server will NOT
# boot (the exact situation it exists for). So no running server, no network,
# no re-download — it only moves local directories and toggles launchd. The
# menu-bar app shells out to this; it is also safe to run by hand over SSH.
#
# --heal (v3.4, t197; the watchdog runs it when ~/.dojo/platform is MISSING):
# every install switches trees with two renames, so a crash between them leaves
# no platform folder. If the cut-off swap was an update whose staged tree is
# whole, finish it (the new version goes live); otherwise restore as below.
# With the platform folder in place, --heal does nothing at all.
# ════════════════════════════════════════
set -uo pipefail
HEAL=0
[ "${1:-}" = "--heal" ] && HEAL=1

DOJO_DIR="$HOME/.dojo"
PLATFORM_DIR="$DOJO_DIR/platform"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
BACKUP_PREFIX="platform.backup-"

# ── Mutual exclusion (D-F) ──
# The menu-bar MANUAL rollback and the watchdog's AUTOMATIC rollback both shell
# THIS same script; they must never run at the same time (two concurrent platform
# moves would race and could lose the build). Putting the lock in the script
# itself means both callers inherit it. `mkdir` is an atomic lock on POSIX:
# exactly one caller can create the directory; a second caller fails fast.
# v3.4 (t197): it is THE lock for anything that moves the platform folder (the
# installer takes it too), and it holds its holder's pid: a lock whose holder
# is dead (a SIGKILL skips the trap) is broken, not obeyed for ever. A lock
# with no pid is one being taken right now, or a pre-v3.4 leftover once old.
mkdir -p "$DOJO_DIR" 2>/dev/null || true
LOCK_DIR="$DOJO_DIR/rollback.lock"
take_lock() {
    if mkdir "$LOCK_DIR" 2>/dev/null; then echo $$ > "$LOCK_DIR/pid"; return 0; fi
    local holder age
    holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then return 1; fi
    age=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || date +%s) ))
    if [ -z "$holder" ] && [ "$age" -lt 60 ]; then return 1; fi
    echo "   (Clearing a lock left by a process that is no longer running.)"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null && echo $$ > "$LOCK_DIR/pid"
}
if ! take_lock; then
    echo "ERROR: another install or rollback is already in progress ($LOCK_DIR). Aborting to avoid a concurrent restore."
    exit 1
fi
trap '[ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK_DIR"' EXIT

# A field of the update-state marker, read with sed (node may be what is broken).
marker_field() {
    [ -f "$DOJO_DIR/update-state.json" ] || return 0
    sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$DOJO_DIR/update-state.json" | head -1
}
tree_version() {
    [ -f "$1/package.json" ] || return 0
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/package.json" | head -1
}

if [ "$HEAL" = 1 ]; then
    if [ -f "$PLATFORM_DIR/package.json" ]; then
        echo "Nothing to repair: the platform folder is in place."
        exit 0
    fi
    staging="$(marker_field stagingDir)"
    target="$(marker_field targetVersion)"
    if [ "$(marker_field phase)" = "pending-update" ] && [ -n "$staging" ] && [ -n "$target" ] \
       && [ "$(tree_version "$staging")" = "$target" ]; then
        echo "🥋 An update to $target was cut off at its last step. Finishing it."
        launchctl unload "$LAUNCH_DIR/com.dojo.platform.plist" 2>/dev/null
        [ -d "$PLATFORM_DIR" ] && mv "$PLATFORM_DIR" "$DOJO_DIR/platform.failed-unknown-$(date +%Y%m%d-%H%M%S)"
        if mv "$staging" "$PLATFORM_DIR"; then
            launchctl load "$LAUNCH_DIR/com.dojo.platform.plist" 2>/dev/null
            echo "✅ Finished installing $target. The server is restarting."
            exit 0
        fi
        echo "   Could not move the prepared $target into place; restoring the previous version instead."
    fi
    # Otherwise the ordinary restore below puts the newest whole backup back.
fi

# Emit a fixed-width, lexically-sortable key for a version string so a plain
# string comparison orders versions correctly.
#
# STABILITY RANKS FIRST, and that is a DEPARTURE from the engine's compareVersions
# — deliberately, because this function answers a different question. 3.1.18,
# UPDATE-INTEGRITY U0. compareVersions asks "which version is NEWER" and correctly
# says 3.1.17-preflight.20 > 3.1.16. This script asks "which build do we put a
# person back onto when the current one will not run", and there the answer is
# never a pre-release while a stable copy is sitting on the same disk. W52 ran the
# old key against a real user's real backup set — {3.1.12, 3.1.16,
# 3.1.17-preflight.20} — and it chose the preflight, because the base version was
# compared first and the pre-release rank byte was only reached on a tie. That is
# how a stable box was automatically downgraded onto a pre-release build and left
# stranded there. So: stable outranks ANY pre-release; among stables the higher
# version wins; among pre-releases the higher base, then the higher ordinal.
# Malformed segments clamp to 0 so a hand-made dir name can never crash the
# recovery path.
version_sort_key() {
    local v="$1" base pre maj min pat prerank pren
    base="${v%%-*}"
    if [ "$v" = "$base" ]; then
        prerank=1; pren=0            # stable: outranks every pre-release, of any base
    else
        prerank=0
        pre="${v#*-}"
        pren="$(printf '%s' "$pre" | tr -cd '0-9')"   # trailing/embedded digits, e.g. preflight.2 -> 2
    fi
    IFS='.' read -r maj min pat _ <<< "$base"
    maj="$(printf '%s' "${maj:-0}" | tr -cd '0-9')"
    min="$(printf '%s' "${min:-0}" | tr -cd '0-9')"
    pat="$(printf '%s' "${pat:-0}" | tr -cd '0-9')"
    printf '%d%04d%04d%04d%04d' \
        "$prerank" "$((10#${maj:-0}))" "$((10#${min:-0}))" "$((10#${pat:-0}))" \
        "$((10#${pren:-0}))"
}

# 1. Find the backup to restore.
#
#    FIRST, THE EPISODE'S OWN RECORD. `~/.dojo/update-state.json` carries
#    `backupDir`: the absolute path of the copy the updater made immediately
#    before it swapped the tree, written by the episode we are now undoing. That
#    is not an inference about which build was good — it is the record of it, and
#    it is used whenever the directory is still there and still looks like a
#    build. Parsed with sed rather than node: this script must work on a box where
#    node is the very thing that is broken.
#
#    A backup that is missing (already consumed by an earlier rollback) or torn (a
#    `cp -R` that was cut short leaves no package.json) falls through to the name
#    scan below rather than being restored — a half-copied tree is the brick this
#    whole path exists to avoid.
newest_backup=""
selection_reason=""
marker_file="$DOJO_DIR/update-state.json"
if [ -f "$marker_file" ]; then
    episode_backup="$(sed -n 's/.*"backupDir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$marker_file" | head -1)"
    if [ -n "${episode_backup:-}" ] && [ -d "$episode_backup" ] && [ -f "$episode_backup/package.json" ]; then
        newest_backup="$episode_backup"
        selection_reason="recorded by this update episode"
    fi
fi

#    SECOND, THE NAME SCAN. For a box with no episode state — a hand-run rollback,
#    a marker from a build that predates the field, a backup already consumed —
#    rank the `platform.backup-*` directories by the version parsed from the NAME,
#    not the directory mtime (FA-D5): a touched mtime, a Time-Machine-restored
#    copy, or a prune interrupted mid-run must not make us restore the wrong
#    build. mtime only breaks ties between two dirs that parse to the same version.
if [ -z "$newest_backup" ]; then
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
    selection_reason="highest-ranked backup on disk (stable before pre-release)"
fi

if [ -z "$newest_backup" ]; then
    echo "ERROR: No ${BACKUP_PREFIX}* directory found in $DOJO_DIR — nothing to roll back to."
    exit 1
fi

# The version being restored, read from the build itself when it can be — the
# directory name is a label the updater wrote, the package.json is the build's own
# word for what it is, and an episode-recorded path need not carry the prefix.
target_ver="$(basename "$newest_backup" | sed "s/^${BACKUP_PREFIX}//")"
if [ -f "$newest_backup/package.json" ]; then
    parsed_target="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$newest_backup/package.json" | head -1)"
    [ -n "$parsed_target" ] && target_ver="$parsed_target"
fi

# Current version, best-effort and without a node dependency (node may be the
# very thing that's broken).
cur_ver="unknown"
if [ -f "$PLATFORM_DIR/package.json" ]; then
    parsed="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PLATFORM_DIR/package.json" | head -1)"
    [ -n "$parsed" ] && cur_ver="$parsed"
fi

echo "🥋 Rolling back DOJO: $cur_ver -> $target_ver"
echo "   Restoring $(basename "$newest_backup") — $selection_reason."

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
