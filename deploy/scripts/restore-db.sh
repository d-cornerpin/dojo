#!/bin/bash
# ════════════════════════════════════════
# DOJO database restore
# Puts your data back to how it was before an update.
#
# WHY THIS EXISTS, in one paragraph. An update can change the DATA, not just the app.
# Rolling back to the previous version — from the dashboard, from the menu bar, or with
# rollback.sh — restores the CODE ONLY; it does not undo a change to the database, which
# is exactly why the watchdog refuses to roll back automatically after a migration. The
# only thing that undoes THAT is the snapshot the platform takes just before it migrates,
# and until this script existed there was no supported way to use one: no route, no
# button, no menu item, no doc. The restore point that justifies the whole
# no-rollback-after-migrations policy was reachable only by someone who already knew it
# was there and could copy a file by hand.
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

FROM=""
ASSUME_YES=0
MODE="list"

while [ $# -gt 0 ]; do
    case "$1" in
        --list)   MODE="list"; shift ;;
        --latest) MODE="restore"; FROM="__latest__"; shift ;;
        --from)   MODE="restore"; FROM="${2:-}"; shift 2 ;;
        --yes|-y) ASSUME_YES=1; shift ;;
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
    chain="$(sqlite3 "$f" 'SELECT COUNT(*) FROM _migrations;' 2>/dev/null)"
    if [ -z "$chain" ]; then
        DESC="$mtime   $(human "$size")   UNREADABLE — not a usable Dojo database (corrupt, or not a database)"
        return
    fi
    head="$(sqlite3 "$f" "SELECT name FROM _migrations WHERE name NOT LIKE '9%' ORDER BY name DESC LIMIT 1;" 2>/dev/null)"
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
LIVE=""
if launchctl list 2>/dev/null | grep -q 'com\.dojo\.platform'; then
    LIVE="the Dojo platform service is loaded in launchd"
elif lsof -nP -iTCP:"$PORT" 2>/dev/null | grep -q LISTEN; then
    LIVE="something is already listening on port $PORT"
elif command -v nc >/dev/null 2>&1 && nc -z -G 1 -w 1 127.0.0.1 "$PORT" >/dev/null 2>&1; then
    LIVE="something accepted a connection on port $PORT"
elif curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
    LIVE="a Dojo server answered on port $PORT"
fi
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

# ── 2. Choose the candidate ──
if [ "$FROM" = "__latest__" ]; then
    FROM="$(collect | head -1)"
    [ -n "$FROM" ] || { echo "REFUSING: there are no restore points on this machine."; echo "Run this script with no arguments to see where they would be."; exit 1; }
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
CAND_INTEGRITY="$(sqlite3 "$FROM" 'PRAGMA integrity_check;' 2>&1 | head -1)"
CAND_FK="$(sqlite3 "$FROM" 'PRAGMA foreign_key_check;' 2>/dev/null | wc -l | tr -d ' ')"
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
# files with that prefix, and the copy of the state you are leaving must not be evicted
# by the next update's snapshot.
mkdir -p "$AUTO_BACKUPS"
SAFETY=""
if [ -f "$DB" ]; then
    SAFETY="$AUTO_BACKUPS/dojo-replaced-$STAMP.db"
    echo ""
    echo "Copying your CURRENT database aside first..."
    if ! sqlite3 "$DB" "VACUUM INTO '$SAFETY'" 2>/dev/null; then
        # A body too damaged to snapshot still deserves to be kept, byte for byte.
        cp -f "$DB" "$SAFETY" 2>/dev/null
        cp -f "$DB-wal" "$SAFETY-wal" 2>/dev/null
        cp -f "$DB-shm" "$SAFETY-shm" 2>/dev/null
        echo "  (plain copy — this database could not be snapshotted, which is itself worth knowing)"
    fi
    if [ ! -s "$SAFETY" ]; then
        echo ""
        echo "REFUSING: could not keep a copy of your current database, so it will not be replaced."
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
rm -f "$DB-wal" "$DB-shm"
if ! cp -f "$FROM" "$DB"; then
    echo "REFUSING: the copy failed. Your database is unchanged."
    exit 1
fi
# A manual backup.sh copy may have kept its own tail; bring it along if it is there.
if [ -f "$FROM-wal" ]; then cp -f "$FROM-wal" "$DB-wal" 2>/dev/null; fi

# ── 7. Verify the RESULT, and undo if it does not hold ──
echo ""
echo "Checking the restored database..."
NEW_INTEGRITY="$(sqlite3 "$DB" 'PRAGMA integrity_check;' 2>&1 | head -1)"
NEW_CHAIN="$(sqlite3 "$DB" 'SELECT COUNT(*) FROM _migrations;' 2>/dev/null)"
NEW_HEAD="$(sqlite3 "$DB" "SELECT name FROM _migrations WHERE name NOT LIKE '9%' ORDER BY name DESC LIMIT 1;" 2>/dev/null)"
NEW_FK="$(sqlite3 "$DB" 'PRAGMA foreign_key_check;' 2>/dev/null | wc -l | tr -d ' ')"
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
