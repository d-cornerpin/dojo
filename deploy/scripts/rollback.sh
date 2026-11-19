#!/bin/bash
# ════════════════════════════════════════
# DOJO local rollback
# Restores the most recent platform backup the updater made, then restarts. When
# the data is ahead of that build, it also puts back (through restore-db.sh) the
# data copy the update episode recorded before its first migration.
#
# Self-contained on purpose: this must work when the platform server will NOT
# boot (the exact situation it exists for). So no running server, no network,
# no node, no re-download: local files, sqlite3 and launchd only. The
# menu-bar app shells out to this; it is also safe to run by hand over SSH.
#
# --heal (v3.4, t197; the watchdog runs it when ~/.dojo/platform is MISSING):
# every install switches trees with two renames, so a crash between them leaves
# no platform folder. If the cut-off swap was an update whose staged tree is
# whole, finish it (the new version goes live); otherwise restore as below.
# With the platform folder in place, --heal does nothing at all. A missing
# program folder is the worst state, so --heal puts a build back whatever the data.
#
# --auto (the watchdog's run): the outcome is written as one line to
# ~/.dojo/rollback-result, `<restored-with-data|restored|unchanged|failed><TAB>sentence`;
# the watchdog acts on the word and texts the owner the sentence.
# ════════════════════════════════════════
set -uo pipefail
HEAL=0
[ "${1:-}" = "--heal" ] && HEAL=1
AUTO=0
[ "${1:-}" = "--auto" ] && AUTO=1
# --print-target: change nothing, take no lock, print the path of the backup a rollback would
# restore right now, and exit. This is THE one selection rule: the server's backup clean-up asks
# this mode so it never deletes the copy this script would restore. When the data would go back
# too, a second line says `data <date and time of the copy>`, or `data none` when there is no copy.
PRINT=0
[ "${1:-}" = "--print-target" ] && PRINT=1
# The owner's sentence for each outcome; the second argument of `unchanged` is what he can do instead.
unchanged() { RESULT="unchanged	Watchdog: a Dojo update did not start up correctly, and it could not be undone: $1. Nothing was changed, and Dojo may keep restarting. ${2:-Choose Roll Back in the Dojo menu bar, or see ~/.dojo/scripts/IF-AN-UPDATE-FAILS.md.}"; }
failed() { RESULT="failed	Watchdog: a Dojo update did not start up correctly, and undoing it went wrong: $1. Please get help before changing anything else."; }
unchanged "the rollback stopped before it changed anything"
in_restore=""

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
[ "$PRINT" = 1 ] || mkdir -p "$DOJO_DIR" 2>/dev/null || true
LOCK_DIR="$DOJO_DIR/rollback.lock"
# A holder that EXISTS but belongs to another user ("Operation not permitted") is alive.
lock_holder_alive() {
    local out
    out="$(kill -0 "$1" 2>&1)" && return 0
    case "$out" in *"not permitted"*) return 0 ;; esac
    return 1
}
# Taking the lock, and taking over a dead holder's, are both atomic: the only deleter of a stale
# lock is the one run that wins `mkdir "$LOCK_DIR.takeover"`, and it re-reads the holder inside that
# exclusive section. (Check-the-holder, delete, re-make let two or three runs through together.)
# A takeover marker a crashed run left behind goes after a minute, and the run that clears it goes on
# to try the takeover itself (it is not told "another run is working" when none is).
take_lock() {
    mkdir -p "$DOJO_DIR" 2>/dev/null
    local holder age tk="$LOCK_DIR.takeover" got=1 try
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        echo $$ > "$LOCK_DIR/pid"
        age=$(( $(date +%s) - $(stat -f %m "$tk" 2>/dev/null || date +%s) ))
        if [ -d "$tk" ] && [ "$age" -ge 60 ] && mv "$tk" "$tk.dead.$$" 2>/dev/null; then rm -rf "$tk.dead.$$"; fi
        return 0
    fi
    for try in 1 2; do
        holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
        if [ -n "$holder" ] && lock_holder_alive "$holder"; then return 1; fi
        age=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || date +%s) ))
        if [ -z "$holder" ] && [ "$age" -lt 60 ]; then return 1; fi
        if ! mkdir "$tk" 2>/dev/null; then
            age=$(( $(date +%s) - $(stat -f %m "$tk" 2>/dev/null || date +%s) ))
            if [ "$age" -ge 60 ] && mv "$tk" "$tk.dead.$$" 2>/dev/null; then rm -rf "$tk.dead.$$"; continue; fi
            return 1
        fi
        holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
        age=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || date +%s) ))
        if [ -d "$LOCK_DIR" ] && { { [ -n "$holder" ] && lock_holder_alive "$holder"; } || { [ -z "$holder" ] && [ "$age" -lt 60 ]; }; }; then
            rmdir "$tk" 2>/dev/null; return 1
        fi
        echo "   (Clearing a lock left by a process that is no longer running.)"
        rm -rf "$LOCK_DIR"
        if mkdir "$LOCK_DIR" 2>/dev/null; then echo $$ > "$LOCK_DIR/pid"; got=0; fi
        rmdir "$tk" 2>/dev/null
        return $got
    done
    return 1
}
if [ "$PRINT" != 1 ]; then
  if ! take_lock; then
      echo "ERROR: another install or rollback is already in progress ($LOCK_DIR). Aborting to avoid a concurrent restore."
      unchanged "another rollback or restore was already running" "If Dojo is still not running in a few minutes, choose Roll Back in the Dojo menu bar."
      [ "$AUTO" = 1 ] && printf '%s\n' "$RESULT" > "$DOJO_DIR/rollback-result"
      exit 1
  fi
  # The EXIT trap also runs on TERM, INT and HUP (a person, a shutdown or a hang-up): if the services
  # were stopped and not yet started again, it starts them, so a signal never leaves Dojo and the
  # watchdog both unloaded. SIGKILL cannot be trapped. Nothing in this script recovers from it: with
  # `platform/` in place `--heal` does nothing, and what brings the services back is launchd loading
  # the two agents at the next login.
  services_down=0
  # Every step below leaves a platform folder in place or says plainly why not, and every exit path
  # loads BOTH services again on whatever folder is there (the watchdog is what notices and tells the
  # owner if that build will not run; with no folder it runs this script with --heal).
  # ONE RULE for "is this service up": launchd's own list, not the exit status of `launchctl load`
  # (load's exit status says nothing reliable about whether the job is now running).
  # start.sh applies the same rule. The list is captured first and read from a here-string, so a
  # short-read `grep -q` can never turn into a false "missing" under pipefail.
  service_loaded() {
      local listing
      listing="$(launchctl list 2>/dev/null)"
      grep -Eq "(^|[[:space:]])com\.dojo\.$1\$" <<<"$listing"
  }
  # Returns 1 and names the service when launchd does not list it after the load.
  reload_services() {
      local rc=0 svc
      # Cleared only AFTER the loop: a signal that lands inside a load must still reload both.
      for svc in platform watchdog; do
          launchctl load "$LAUNCH_DIR/com.dojo.$svc.plist" 2>/dev/null
          if ! service_loaded "$svc"; then
              echo "   The $svc service did not start (launchd does not list com.dojo.$svc after the load)."
              rc=1
          fi
      done
      services_down=0
      return $rc
  }
  # A name that does not exist yet, so nothing is ever moved INTO an old folder.
  unique_path() {
      local p="$1" n=1
      while [ -e "$p" ]; do p="$1-$$-$n"; n=$((n + 1)); done
      printf '%s' "$p"
  }
  on_exit() {
      if [ "${services_down:-0}" = 1 ]; then reload_services; fi
      # Stopped during the data restore: say what state it left the data in.
      [ -n "$in_restore" ] && stopped "the rollback was stopped before it finished"
      [ "$AUTO" = 1 ] && printf '%s\n' "$RESULT" > "$DOJO_DIR/rollback-result"
      [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK_DIR"
  }
  # THE one answer to "what state is the data in now": before (the copy is in place), newer, or unreadable.
  data_state() {
      local last
      [ "$(db_read 'PRAGMA quick_check;' | head -1)" = ok ] \
          && last="$(db_read 'SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1;')" \
          || { echo unreadable; return; }
      if [ -f "$build_steps/$last" ]; then echo before; else echo newer; fi
  }
  # What a stop part-way did, from the data as it is now.
  stopped() {
      case "$([ -n "$data_copy" ] && data_state)" in
          before) failed "your data was put back to the copy from before the update, but $1, so the newer version is still installed" ;;
          unreadable) failed "your data could not be read after $1; the newer data is kept in the copy set aside (dojo-replaced-<date>.db in ~/.dojo/data/backups)" ;;
          *) unchanged "$1" ;;
      esac
  }
  trap on_exit EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  trap 'exit 129' HUP
fi

# The live database, read through restore-db.sh's one reader (it works whether or not Dojo stopped cleanly).
db_read() { bash "$(dirname "$0")/restore-db.sh" --read "$DOJO_DIR/data/dojo.db" "$1" 2>/dev/null; }

# A field of the update-state marker, read with sed (node may be what is broken).
marker_field() {
    [ -f "$DOJO_DIR/update-state.json" ] || return 0
    sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$DOJO_DIR/update-state.json" | head -1
}
tree_version() {
    [ -f "$1/package.json" ] || return 0
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/package.json" | head -1
}

if [ "$HEAL" = 1 ] && [ "$PRINT" != 1 ]; then
    if [ -f "$PLATFORM_DIR/package.json" ]; then
        echo "Nothing to repair: the platform folder is in place."
        exit 0
    fi
    staging="$(marker_field stagingDir)"
    target="$(marker_field targetVersion)"
    if [ "$(marker_field phase)" = "pending-update" ] && [ -n "$staging" ] && [ -n "$target" ] \
       && [ "$(tree_version "$staging")" = "$target" ]; then
        echo "🥋 An update to $target was cut off at its last step. Finishing it."
        services_down=1
        launchctl unload "$LAUNCH_DIR/com.dojo.platform.plist" 2>/dev/null
        [ -d "$PLATFORM_DIR" ] && mv "$PLATFORM_DIR" "$DOJO_DIR/platform.failed-unknown-$(date +%Y%m%d-%H%M%S)"
        if mv "$staging" "$PLATFORM_DIR"; then
            if reload_services; then
                echo "✅ Finished installing $target. The server is restarting."
                exit 0
            fi
            echo "❌ $target is in place, but a service above did not start. Run this again or restart Dojo from the menu bar."
            exit 1
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

# The data was changed by a newer program when the last step applied to it (rowid order is apply
# order) is a migration file the build being restored does not have. A level that cannot be read
# counts as ahead: putting the pre-update copy back keeps the newer data aside, the reverse can lose it.
data_ahead=0
data_copy=""
last_step=""
if [ -f "$DOJO_DIR/data/dojo.db" ]; then
    last_step="$(db_read 'SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1;')" || last_step="(unreadable)"
fi
build_steps="$newest_backup/packages/server/dist/db/migrations"
if [ -n "$newest_backup" ] && [ -n "$last_step" ] && [ -d "$build_steps" ] && [ ! -f "$build_steps/$last_step" ]; then
    data_ahead=1
    data_copy="$(marker_field dataBackup)"
    [ -f "$data_copy" ] || data_copy=""
fi
copy_time() { stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$1" 2>/dev/null; }

# --print-target: the answer is the path, or nothing at all when there is no backup.
if [ "$PRINT" = 1 ]; then
    printf '%s\n' "$newest_backup"
    if [ -n "$newest_backup" ] && [ "$data_ahead" = 1 ]; then printf 'data %s\n' "$( [ -n "$data_copy" ] && copy_time "$data_copy" || echo none)"; fi
    exit 0
fi

if [ -z "$newest_backup" ]; then
    echo "ERROR: No ${BACKUP_PREFIX}* directory found in $DOJO_DIR — nothing to roll back to."
    unchanged "there is no earlier version of Dojo on this Mac to go back to" "See ~/.dojo/scripts/IF-AN-UPDATE-FAILS.md."
    exit 1
fi

# The version being restored, read from the build itself when it can be — the
# directory name is a label the updater wrote, the package.json is the build's own
# word for what it is, and an episode-recorded path need not carry the prefix.
target_ver="$(basename "$newest_backup" | sed "s/^${BACKUP_PREFIX}//")"
parsed_target=""
had_pkg=0
if [ -f "$newest_backup/package.json" ]; then
    had_pkg=1
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
data_why="your data was changed by a version newer than $target_ver"
[ "$last_step" = "(unreadable)" ] && data_why="the step your data is at could not be read"
if [ "$data_ahead" = 1 ] && [ "$HEAL" = 1 ]; then
    echo "   NOTE: $data_why; the program is put back anyway, because a missing program folder is worse."
    data_copy=""
elif [ "$data_ahead" = 1 ]; then
    if [ -z "$data_copy" ]; then
        echo "ERROR: $data_why, and there is no copy of your data from before the update to put back."
        echo "   Nothing was changed. See ~/.dojo/scripts/IF-AN-UPDATE-FAILS.md."
        unchanged "$([ "$last_step" = "(unreadable)" ] && echo 'your data could not be read' || echo 'the update changed your data') and there is no copy of it from before the update" 'See "What if there is no backup?" in ~/.dojo/scripts/IF-AN-UPDATE-FAILS.md.'
        exit 1
    fi
    echo "   Your data goes back to the copy taken $(copy_time "$data_copy"); everything since then is kept in a dated copy, not deleted."
    if [ -t 0 ]; then
        printf "   Type yes to continue: "
        read -r answer
        [ "$answer" = "yes" ] || { echo "Stopped. Nothing has been changed."; unchanged "the rollback was not confirmed"; exit 1; }
    fi
fi

# 2. Stop services.
echo "   Stopping services..."
services_down=1   # BEFORE the first unload: a signal during the unloads must still reload both
launchctl unload "$LAUNCH_DIR/com.dojo.platform.plist" 2>/dev/null
launchctl unload "$LAUNCH_DIR/com.dojo.watchdog.plist" 2>/dev/null

# restore-db.sh waits (bounded) for the server to have really stopped, and refuses if it has not.
if [ -n "$data_copy" ]; then
    in_restore=1   # a stop from here on is judged by the data's state at exit
    if ! DOJO_LOCK_HOLDER=$$ DOJO_STOP_WAIT="${DOJO_STOP_WAIT:-30}" bash "$(dirname "$0")/restore-db.sh" --from "$data_copy" --yes; then
        echo "ERROR: your data could not be put back (see above), so the build was not changed either."
        in_restore=""
        stopped "restoring your data from before the update did not finish (Dojo did not stop in time, or the copy did not pass its check)"
        reload_services
        exit 1
    fi
    in_restore=""
fi

# 3. Set the current (failed) build aside for diagnosis, then move the backup
#    into place. Moves (not copies) so the swap is fast and uses no extra disk;
#    older backups remain for a deeper rollback if needed.
ts="$(date +%Y%m%d-%H%M%S)"
failed_dir=""
failed "the rollback was stopped while it was swapping the program$([ -n "$data_copy" ] && echo ' (your data had already been put back to the copy from before the update)'), so Dojo may have no program to run until the watchdog repairs it"
if [ -d "$PLATFORM_DIR" ]; then
    failed_dir="$(unique_path "$DOJO_DIR/platform.failed-${cur_ver}-${ts}")"
    echo "   Preserving current build -> $(basename "$failed_dir")"
    if ! mv "$PLATFORM_DIR" "$failed_dir"; then
        echo "ERROR: could not move the current platform aside; aborting before any data loss."
        stopped "the current version could not be moved aside"
        failed_dir=""
        reload_services
        exit 1
    fi
fi

echo "   Restoring $target_ver..."
# The restore counts only when the move worked AND the folder in place is the build we meant: by the
# build's own markers (its package.json, and its version when that file states one). A backup whose
# package.json carries no version line is accepted on the package.json alone, as it always was.
restore_ok=0
if mv "$newest_backup" "$PLATFORM_DIR"; then
    restore_ok=1
    if [ "$had_pkg" = 1 ]; then
        [ -f "$PLATFORM_DIR/package.json" ] || restore_ok=0
        if [ -n "$parsed_target" ] && [ "$(tree_version "$PLATFORM_DIR")" != "$target_ver" ]; then restore_ok=0; fi
    fi
    if [ "$restore_ok" = 0 ] && [ ! -e "$newest_backup" ]; then
        # The move worked but the build is not the one meant: send it back to the name later
        # rollbacks (and --print-target) look for, rather than hiding it under another name.
        mv "$PLATFORM_DIR" "$newest_backup" 2>/dev/null || true
    fi
fi
if [ "$restore_ok" = 1 ]; then
    :
else
    echo "ERROR: could not move the backup into place."
    # A partial or wrong folder left at platform/ must not swallow the running build.
    put_back_ok=1
    if [ -e "$PLATFORM_DIR" ]; then
        partial_dir="$(unique_path "$DOJO_DIR/platform.partial-${ts}")"
        if mv "$PLATFORM_DIR" "$partial_dir"; then
            echo "   A partly restored folder was set aside at $(basename "$partial_dir")."
        else
            put_back_ok=0
        fi
    fi
    if [ -n "${failed_dir:-}" ] && [ -d "${failed_dir:-}" ]; then
        if [ "$put_back_ok" = 1 ] && mv "$failed_dir" "$PLATFORM_DIR" && [ -f "$PLATFORM_DIR/package.json" ]; then
            echo "   The previous build was put back, so Dojo is as it was."
            stopped "the earlier version could not be moved into place"
            if [ -d "$newest_backup" ]; then echo "   The backup is still at $(basename "$newest_backup")."; fi
        else
            # Field fix 3 audit round: facts, never a chore for the owner (no "restore it with mv").
            echo "   The previous build could not be put back either. It is at:"
            failed "neither the earlier version nor the current one could be put in place, so Dojo has no program to run"
            echo "       $failed_dir"
            if [ -e "$PLATFORM_DIR" ]; then
                echo "   $PLATFORM_DIR is still in its place."
            else
                echo "   $PLATFORM_DIR is empty."
            fi
        fi
    else
        echo "   There was no previous build to put back."
        failed "the earlier version could not be moved into place, so Dojo has no program to run"
    fi
    reload_services
    exit 1
fi

# 4. Restart.
if [ -n "$data_copy" ]; then RESULT="restored-with-data	Watchdog: a Dojo update did not start up correctly, so Dojo $target_ver was put back, together with your data as it was just before the update. Messages that arrived since then are kept in a copy set aside, not lost."
else RESULT="restored	Watchdog: a Dojo update did not start up correctly, so Dojo $target_ver was put back. Your data did not need to change."; fi
echo "   Starting services..."
if ! reload_services; then
    echo "❌ The build was rolled back to $target_ver, but a service above did not start."
    exit 1
fi

echo "✅ Rolled back to $target_ver. The server is restarting."
if [ -n "${failed_dir:-}" ]; then
    echo "   The failed build was kept at $(basename "$failed_dir") for diagnosis. Dojo removes it by itself once newer ones replace it."
fi
