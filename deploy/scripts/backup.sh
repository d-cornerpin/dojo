#!/bin/bash

DOJO_DIR="$HOME/.dojo"
BACKUP_DIR="$DOJO_DIR/backups/$(date +%Y%m%d-%H%M%S)"

echo "🥋 Backing up DOJO data..."

mkdir -p "$BACKUP_DIR"

# Database + WAL
cp "$DOJO_DIR/data/dojo.db" "$BACKUP_DIR/" 2>/dev/null
cp "$DOJO_DIR/data/dojo.db-wal" "$BACKUP_DIR/" 2>/dev/null
cp "$DOJO_DIR/data/dojo.db-shm" "$BACKUP_DIR/" 2>/dev/null

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
