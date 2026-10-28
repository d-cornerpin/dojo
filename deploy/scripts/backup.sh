#!/bin/bash

DOJO_DIR="$HOME/.dojo"
BACKUP_DIR="$DOJO_DIR/backups/$(date +%Y%m%d-%H%M%S)"

echo "🥋 Backing up DOJO data..."

mkdir -p "$BACKUP_DIR"

# Database. SQLite's online backup writes ONE consistent file even while the server is running.
DB="$DOJO_DIR/data/dojo.db"
if [ ! -f "$DB" ]; then
    echo "❌ No database found at $DB, so nothing was backed up."
    rmdir "$BACKUP_DIR" 2>/dev/null
    exit 1
fi
if command -v sqlite3 >/dev/null 2>&1 && sqlite3 "$DB" ".backup '$BACKUP_DIR/dojo.db'" 2>/dev/null; then
    :
else
    # No sqlite3, or it failed: fall back to copying the three pieces, and say so.
    echo "⚠️  Could not use SQLite's online backup; copying the database files instead."
    rm -f "$BACKUP_DIR/dojo.db"
    cp "$DB" "$BACKUP_DIR/" 2>/dev/null
    cp "$DB-wal" "$BACKUP_DIR/" 2>/dev/null
    cp "$DB-shm" "$BACKUP_DIR/" 2>/dev/null
fi
if [ ! -s "$BACKUP_DIR/dojo.db" ]; then
    echo "❌ The database could not be copied (is the disk full?). Nothing usable was saved in $BACKUP_DIR."
    exit 1
fi

# Secrets
cp "$DOJO_DIR/secrets.yaml" "$BACKUP_DIR/" 2>/dev/null

# Prompts
cp -r "$DOJO_DIR/prompts" "$BACKUP_DIR/" 2>/dev/null

# Techniques
cp -r "$DOJO_DIR/techniques" "$BACKUP_DIR/" 2>/dev/null

# Clean old backups (keep 10)
cd "$DOJO_DIR/backups"
ls -dt */ 2>/dev/null | tail -n +11 | xargs rm -rf 2>/dev/null

BACKUP_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
echo "✅ Backup complete: $BACKUP_DIR ($BACKUP_SIZE)"
