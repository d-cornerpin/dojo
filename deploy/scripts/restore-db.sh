#!/bin/bash
# ════════════════════════════════════════
# DOJO database restore
# Puts your data back to how it was before an update.
#
# WHY THIS EXISTS. An update can change the DATA, not just the app, and the only thing
# that undoes that is the snapshot the platform takes just before it migrates. This puts
# one back. rollback.sh calls it when the data is ahead of the build it restores.
#
# Self-contained on purpose, like rollback.sh: this has to work when the platform server
# will NOT boot, which is the situation it exists for. No running server, no network, no
# node — just sqlite3, cp, and launchctl.
#
# THE RULES IT KEEPS, in order:
#   1. It never runs against a live server. Stop Dojo first, or it refuses and says so.
#   2. It never destroys the present to recover the past. Your CURRENT database is copied
#      aside first, and that copy is verified too.
#   3. It never installs a backup it has not checked. Integrity, foreign keys and a
#      readable migration chain, all BEFORE anything is overwritten.
#   4. If the result does not verify, it puts your current database back and says so.
#   5. It prints exactly what it did, with paths.
#
#   ~/.dojo/scripts/restore-db.sh              # show what can be restored
#   ~/.dojo/scripts/restore-db.sh --latest     # restore the newest restore point
#   ~/.dojo/scripts/restore-db.sh --from FILE  # restore a specific one
# ════════════════════════════════════════
set -uo pipefail

DOJO_DIR="$HOME/.dojo"
DATA_DIR="$DOJO_DIR/data"
DB="$DATA_DIR/dojo.db"
AUTO_BACKUPS="$DATA_DIR/backups"
MANUAL_BACKUPS="$DOJO_DIR/backups"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
PORT="${DOJO_PORT:-3001}"
STAMP="$(date +%Y-%m-%dT%H-%M-%S)"

# THE one way these scripts read a database: read-only, and whether or not its WAL side files exist.
# immutable=1 is safe only with no -wal file and nothing else holding the database open.
db_read() {
    if [ -e "$1-wal" ]; then sqlite3 -readonly "$1" "$2"; return; fi
    local p="${1//%/%25}"; p="${p//\?/%3F}"; p="${p//#/%23}"
    sqlite3 "file:$p?mode=ro&immutable=1" "$2"
}

FROM=""
ASSUME_YES=0
MODE="list"

while [ $# -gt 0 ]; do
    case "$1" in
        --list)   MODE="list"; shift ;;
        --latest) MODE="restore"; FROM="__latest__"; shift ;;
        --from)   MODE="restore"; FROM="${2:-}"; shift 2 ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        --read)   db_read "${2:-}" "${3:-}"; exit ;;   # rollback.sh reads through this one function
        -h|--help) MODE="list"; shift ;;
        -*)       echo "ERROR: unknown option '$1'"; exit 2 ;;
        *)        MODE="restore"; FROM="$1"; shift ;;
    esac
done

command -v sqlite3 >/dev/null 2>&1 || {
    echo "ERROR: sqlite3 is not on this machine, so a backup cannot be checked before it is used."
    echo "       Refusing rather than copying a file blind."
    exit 1
}

human() {
    local b="${1:-0}"
    if   [ "$b" -ge 1073741824 ]; then awk -v b="$b" 'BEGIN{printf "%.1f GB", b/1073741824}'
    elif [ "$b" -ge 1048576 ];    then awk -v b="$b" 'BEGIN{printf "%.0f MB", b/1048576}'
    elif [ "$b" -ge 1024 ];       then awk -v b="$b" 'BEGIN{printf "%.0f KB", b/1024}'
    else echo "${b} bytes"; fi
}

# ── Collect every restore point this box has ──
# Two sources, both real: the automatic pre-update snapshots the platform writes, and
# whatever backup.sh copied by hand. They are listed together because a person looking
# for their data should not have to know which mechanism made it.
collect() {
    { ls -1 "$AUTO_BACKUPS"/*.db 2>/dev/null
      ls -1 "$MANUAL_BACKUPS"/*/dojo.db 2>/dev/null
    } | while read -r f; do
        [ -f "$f" ] || continue
        printf '%s\t%s\n' "$(stat -f %m "$f")" "$f"
    done | sort -rn | cut -f2-
}

# Read a candidate and describe it. Sets DESC, CHAIN, HEAD, OKFILE.
describe() {
    local f="$1"
    local size mtime chain head
    size="$(stat -f %z "$f" 2>/dev/null || echo 0)"
    mtime="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$f" 2>/dev/null)"
    OKFILE=0; CHAIN=""; HEAD=""
    if [ "${size:-0}" -eq 0 ]; then
        DESC="$mtime   $(human "$size")   UNREADABLE — the file is empty"
        return
    fi
    chain="$(db_read "$f" 'SELECT COUNT(*) FROM _migrations;' 2>/dev/null)"
    if [ -z "$chain" ]; then
        DESC="$mtime   $(human "$size")   UNREADABLE — not a usable Dojo database (corrupt, or not a database)"
        return
    fi
    head="$(db_read "$f" "SELECT name FROM _migrations WHERE name NOT LIKE '9%' ORDER BY name DESC LIMIT 1;" 2>/dev/null)"
    OKFILE=1; CHAIN="$chain"; HEAD="$head"
    DESC="$mtime   $(human "$size")   chain $chain (up to ${head:-unknown})"
}

list_points() {
    echo ""
    echo "🥋 DOJO — what your data can be put back to"
    echo "════════════════════════════════════════"
    echo ""
    local any=0
    while read -r f; do
        [ -n "$f" ] || continue
        any=1
        describe "$f"
        echo "  $DESC"
        echo "      $f"
        echo ""
    done < <(collect)
    if [ "$any" -eq 0 ]; then
        echo "  There are no restore points on this machine."
        echo ""
        echo "  Dojo writes one automatically just before an update changes your data,"
        echo "  into $AUTO_BACKUPS."
        echo "  If that directory is empty, no update has changed your data on this box —"
        echo "  or the backup could not be written at the time. The Update tab in Settings"
        echo "  says which."
        echo ""
        return
    fi
    echo "  \"chain\" is how many database changes had been applied when the copy was made."
    echo "  A lower number is an older shape of your data."
    echo ""
    echo "  To put your data back:"
    echo "      1. Stop Dojo:   ~/.dojo/scripts/stop.sh"
    echo "      2. Restore:     ~/.dojo/scripts/restore-db.sh --latest"
    echo "         (or --from <one of the paths above>)"
    echo "      3. Start Dojo:  ~/.dojo/scripts/start.sh"
    echo ""
}

if [ "$MODE" = "list" ]; then
    list_points
    exit 0
fi

# ════════ RESTORE ════════

echo ""
echo "🥋 DOJO — restoring your data"
echo "════════════════════════════════════════"
echo ""

# ── 1. Never against a live server ──
# Two independent reads: the launchd job, and anything actually holding the port. Either
# one is enough to refuse. A restore under a running server would have the platform
# writing into a file being replaced underneath it, which is how a good backup becomes a
# broken database.
#
# THREE independent reads, because any one of them can be blind: launchd does not know
# about a server started by hand, `lsof` is not always permitted to see another process's
# sockets, and a wedged server can hold the port without answering health. Any single
# positive refuses. Being wrong in the cautious direction costs one `stop.sh`; being wrong
# the other way costs the database.
# Read launchd's list into a variable first: under pipefail a `launchctl list | grep -q` can be cut
# short by the early exit and report "not loaded" for a loaded service, the unsafe direction here.
live_reason() {
    local listing
    listing="$(launchctl list 2>/dev/null)"
    if grep -Eq '(^|[[:space:]])com\.dojo\.platform$' <<<"$listing"; then
        echo "the Dojo platform service is loaded in launchd"
    elif lsof -nP -iTCP:"$PORT" 2>/dev/null | grep -q LISTEN; then
        echo "something is already listening on port $PORT"
    elif command -v nc >/dev/null 2>&1 && nc -z -G 1 -w 1 127.0.0.1 "$PORT" >/dev/null 2>&1; then
        echo "something accepted a connection on port $PORT"
    elif curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
        echo "a Dojo server answered on port $PORT"
    fi
}
# DOJO_STOP_WAIT (seconds, rollback.sh sets it): a server just told to stop is given that long to go.
LIVE="$(live_reason)"
waited=0
while [ -n "$LIVE" ] && [ "$waited" -lt "${DOJO_STOP_WAIT:-0}" ]; do sleep 1; waited=$((waited + 1)); LIVE="$(live_reason)"; done
if [ -n "$LIVE" ]; then
    echo "REFUSING: Dojo appears to be running ($LIVE)."
    echo ""
    echo "Restoring your data while the server is running would corrupt it."
    echo "Stop Dojo first, then run this again:"
    echo ""
    echo "    ~/.dojo/scripts/stop.sh"
    echo "    ~/.dojo/scripts/restore-db.sh $*"
    echo ""
    exit 1
fi

# ── 1b. One restore, install or rollback at a time ──
# The same lock rollback.sh and the installer take (mkdir is atomic; it holds its holder's pid, and
# a holder that is dead is cleared). Two restores at once once shared a safety-copy name and one
# deleted the other's good copy of the current data.
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
    # Called by rollback.sh, which already holds the lock and names itself in DOJO_LOCK_HOLDER.
    [ -n "${DOJO_LOCK_HOLDER:-}" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$DOJO_LOCK_HOLDER" ] && return 0
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
if ! take_lock; then
    echo "REFUSING: another restore, install or rollback is running ($LOCK_DIR)."
    echo "Wait for it to finish, then run this again. Nothing has been changed."
    exit 1
fi
release_lock() { [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK_DIR"; }
trap release_lock EXIT

# ── 2. Choose the candidate ──
if [ "$FROM" = "__latest__" ]; then
    FROM="$(collect | grep -v '/dojo-replaced-[^/]*$' | head -1)"
    [ -n "$FROM" ] || { echo "REFUSING: there are no pre-update restore points on this machine."; echo "Run this script with no arguments to see where they would be."; echo "Copies this script set aside (dojo-replaced-*) are listed by running it with no arguments; restore one on purpose with --from <file>."; exit 1; }
    echo "Newest restore point: $FROM"
fi
[ -n "$FROM" ] || { echo "ERROR: no backup given. Run with no arguments to see the list."; exit 2; }
[ -f "$FROM" ] || { echo "REFUSING: no such file: $FROM"; exit 1; }

# ── 3. Check the candidate BEFORE anything is overwritten ──
echo ""
echo "Checking the backup before using it..."
describe "$FROM"
echo "  $DESC"
if [ "$OKFILE" -ne 1 ]; then
    echo ""
    echo "REFUSING: that file is not a usable Dojo database, so it will not be installed."
    echo "Nothing has been changed. Run this script with no arguments to see the others."
    exit 1
fi
CAND_INTEGRITY="$(db_read "$FROM" 'PRAGMA integrity_check;' 2>&1 | head -1)"
CAND_FK="$(db_read "$FROM" 'PRAGMA foreign_key_check;' 2>/dev/null | wc -l | tr -d ' ')"
echo "  integrity_check    : $CAND_INTEGRITY"
echo "  foreign_key_check  : $CAND_FK row(s)"
if [ "$CAND_INTEGRITY" != "ok" ]; then
    echo ""
    echo "REFUSING: that backup does not pass SQLite's own integrity check."
    echo "Nothing has been changed."
    exit 1
fi

# ── 4. Confirm ──
if [ "$ASSUME_YES" -ne 1 ]; then
    if [ ! -t 0 ]; then
        echo ""
        echo "REFUSING: this replaces your database and nothing confirmed it."
        echo "Re-run with --yes if you are sure."
        exit 1
    fi
    echo ""
    echo "This will REPLACE your current database with that copy."
    echo "Anything that happened after $(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$FROM") will be gone from Dojo's memory."
    printf "Type yes to continue: "
    read -r ANSWER
    [ "$ANSWER" = "yes" ] || { echo "Stopped. Nothing has been changed."; exit 1; }
fi

# ── 5. Copy the PRESENT aside before recovering the past ──
# Deliberately NOT named dojo-pre-*: the platform's own prune keeps only the newest two
# files with that prefix (plus the pinned episode baseline, 3.1.18), and the copy of the
# state you are leaving must not be evicted by the next update's snapshot.
mkdir -p "$AUTO_BACKUPS"
SAFETY=""
if [ -f "$DB" ]; then
    SAFETY="$AUTO_BACKUPS/dojo-replaced-$STAMP-$$.db"
    # Two restores inside one second must not share a name: the second would overwrite the
    # first safety copy, which may be the only copy of the data that restore replaced.
    n=1; while [ -e "$SAFETY" ]; do n=$((n+1)); SAFETY="$AUTO_BACKUPS/dojo-replaced-$STAMP-$$-$n.db"; done
    echo ""
    echo "Copying your CURRENT database aside first..."
    # The copy counts only when it is WHOLE. A snapshot must exit 0 and pass quick_check. A plain
    # copy (a database too damaged to snapshot) must have every cp succeed and match the original's
    # size; a full disk cuts a copy short, and an ignored exit status once let the restore replace
    # the only good copy of the owner's data with a cut-off file.
    KEPT=0
    if db_read "$DB" "VACUUM INTO '$SAFETY'" 2>/dev/null \
       && [ "$(db_read "$SAFETY" 'PRAGMA quick_check;' 2>/dev/null | head -1)" = "ok" ]; then
        KEPT=1
    else
        rm -f "$SAFETY" "$SAFETY-wal" "$SAFETY-shm"
        # A body too damaged to snapshot still deserves to be kept, byte for byte.
        KEPT=1
        cp -f "$DB" "$SAFETY" 2>/dev/null || KEPT=0
        [ "$(stat -f %z "$SAFETY" 2>/dev/null || echo -1)" = "$(stat -f %z "$DB" 2>/dev/null || echo -2)" ] || KEPT=0
        if [ -e "$DB-wal" ]; then cp -f "$DB-wal" "$SAFETY-wal" 2>/dev/null || KEPT=0; fi
        if [ -e "$DB-shm" ]; then cp -f "$DB-shm" "$SAFETY-shm" 2>/dev/null || KEPT=0; fi
        [ "$KEPT" = 1 ] && echo "  (plain copy — this database could not be snapshotted, which is itself worth knowing)"
    fi
    if [ "$KEPT" != 1 ] || [ ! -s "$SAFETY" ]; then
        rm -f "$SAFETY" "$SAFETY-wal" "$SAFETY-shm"
        echo ""
        echo "REFUSING: could not keep a whole copy of your current database (is the disk full?), so it will not be replaced."
        echo "Nothing has been changed."
        exit 1
    fi
    echo "  $SAFETY  ($(human "$(stat -f %z "$SAFETY")"))"
else
    echo ""
    echo "There is no current database at $DB — nothing to copy aside."
fi

# ── 6. Replace ──
# The -wal and -shm are the tail of the OLD database. Leaving them beside a restored file
# is how a restore silently half-fails: SQLite would try to replay them into a body they
# do not belong to.
echo ""
echo "Putting the backup in place..."
# A copy that fails or is stopped part-way (a shutdown sends TERM) puts the set-aside database back.
put_back() {
    echo "REFUSING: the copy failed or was stopped part-way, so the database file may be cut off."
    rm -f "$DB-wal" "$DB-shm"
    if [ -n "$SAFETY" ] && [ -s "$SAFETY" ] && cp -f "$SAFETY" "$DB"; then
        echo "  Your previous database has been put back from $SAFETY"
    elif [ -z "$SAFETY" ]; then
        rm -f "$DB"
        echo "  There was no database before this run, so the cut-off file was removed."
    else
        echo "  COULD NOT PUT IT BACK. Your previous database is at:"
        echo "      $SAFETY"
        echo "  Copy it to $DB by hand before starting Dojo."
    fi
    exit 1
}
trap put_back TERM INT HUP
rm -f "$DB-wal" "$DB-shm"
cp -f "$FROM" "$DB" || put_back
# A manual backup.sh copy may have kept its own tail; bring it along if it is there.
if [ -f "$FROM-wal" ]; then cp -f "$FROM-wal" "$DB-wal" 2>/dev/null; fi
trap - TERM INT HUP

# ── 7. Verify the RESULT, and undo if it does not hold ──
echo ""
echo "Checking the restored database..."
NEW_INTEGRITY="$(db_read "$DB" 'PRAGMA integrity_check;' 2>&1 | head -1)"
NEW_CHAIN="$(db_read "$DB" 'SELECT COUNT(*) FROM _migrations;' 2>/dev/null)"
NEW_HEAD="$(db_read "$DB" "SELECT name FROM _migrations WHERE name NOT LIKE '9%' ORDER BY name DESC LIMIT 1;" 2>/dev/null)"
NEW_FK="$(db_read "$DB" 'PRAGMA foreign_key_check;' 2>/dev/null | wc -l | tr -d ' ')"
echo "  integrity_check    : $NEW_INTEGRITY"
echo "  migrations applied : ${NEW_CHAIN:-unreadable} (up to ${NEW_HEAD:-unknown})"
echo "  foreign_key_check  : $NEW_FK row(s)"

if [ "$NEW_INTEGRITY" != "ok" ] || [ -z "$NEW_CHAIN" ]; then
    echo ""
    echo "THE RESTORE DID NOT VERIFY — putting your database back as it was."
    rm -f "$DB-wal" "$DB-shm"
    if [ -n "$SAFETY" ] && [ -s "$SAFETY" ] && cp -f "$SAFETY" "$DB"; then
        echo "  Your previous database has been put back from $SAFETY"
    else
        echo "  COULD NOT PUT IT BACK. Your previous database is at:"
        echo "      $SAFETY"
        echo "  Copy it to $DB by hand before starting Dojo."
    fi
    exit 1
fi

# ── 8. Say exactly what happened ──
echo ""
echo "════════════════════════════════════════"
echo "DONE. Here is exactly what changed:"
echo ""
echo "  Restored from : $FROM"
echo "  Into          : $DB"
echo "  Now at        : ${NEW_CHAIN} database changes applied (up to ${NEW_HEAD:-unknown})"
if [ -n "$SAFETY" ]; then
echo "  Your previous database was NOT deleted. It is at:"
echo "                  $SAFETY"
echo "                  (to undo this restore, run: ~/.dojo/scripts/restore-db.sh --from $SAFETY)"
fi
echo ""
echo "  Start Dojo again:  ~/.dojo/scripts/start.sh"
echo ""
if [ -d "$LAUNCH_DIR" ] && [ -f "$LAUNCH_DIR/com.dojo.platform.plist" ]; then
echo "  If Dojo was updated to a newer version and you have gone back to older data,"
echo "  put the matching older app back too:  ~/.dojo/scripts/rollback.sh"
echo ""
fi
exit 0
