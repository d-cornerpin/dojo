import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, getDbPath } from './connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('migrations');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function runMigrations(): void {
  const db = getDb();

  logger.info('Running database migrations');

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('anthropic', 'openai', 'openai-compatible', 'ollama')),
      base_url TEXT,
      auth_type TEXT NOT NULL CHECK(auth_type IN ('api_key', 'oauth')),
      is_validated INTEGER NOT NULL DEFAULT 0,
      validated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      name TEXT NOT NULL,
      api_model_id TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      context_window INTEGER,
      input_cost_per_m REAL,
      output_cost_per_m REAL,
      is_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model_id TEXT,
      system_prompt_path TEXT,
      status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'working', 'paused', 'error', 'terminated')),
      config TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      token_count INTEGER,
      model_id TEXT,
      cost REAL,
      latency_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      action_type TEXT NOT NULL CHECK(action_type IN ('tool_call', 'file_read', 'file_write', 'exec', 'model_call', 'error')),
      target TEXT,
      result TEXT NOT NULL CHECK(result IN ('success', 'denied', 'error')),
      detail TEXT,
      cost REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_messages_agent_id ON messages(agent_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_agent_created ON messages(agent_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_agent_id ON audit_log(agent_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_models_provider_id ON models(provider_id);
  `);

  // Run SQL file migrations
  runSqlMigrations(db);

  // Ensure the 'auto' sentinel model exists for auto-routing FK compliance
  db.exec(`
    INSERT OR IGNORE INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('__system__', 'System', 'anthropic', NULL, 'none', 1, datetime('now'), datetime('now'));
    INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
    VALUES ('auto', '__system__', 'Auto (Smart Router)', 'auto', '[]', 200000, 64000, 0, 0, 1, datetime('now'), datetime('now'));
  `);

  logger.info('Database migrations completed');
}

function runSqlMigrations(db: ReturnType<typeof getDb>): void {
  // Ensure migration tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  // Snapshot the pending set up front so the pre-chain backup and the chain
  // timing both see the whole set. This is a read-only probe; each file is still
  // RECORDED atomically alongside its apply inside applyOne below.
  const pending = files.filter(
    f => !db.prepare('SELECT name FROM _migrations WHERE name = ?').get(f),
  );

  // ── Pre-chain online DB backup (owner decision D-F restore point) ──
  // D-F is a deliberate NO-rollback-after-migrations policy; that policy needs an
  // actual restore point. Before applying ANY pending migration, snapshot the live
  // DB so a bad upgrade can be recovered by copying the snapshot back. Only when
  // there is real work to do.
  if (pending.length > 0) {
    backupBeforeMigrationChain(db, files, pending);
  }

  // Disable FK checks for the entire migration run.
  // Migrations may drop/recreate tables or insert into tables with cross-references.
  // FK checks are re-enabled after all migrations complete. This is set OUTSIDE the
  // per-migration transactions below (a `PRAGMA foreign_keys` change is a no-op
  // while a transaction is open), so the OFF state holds across the whole chain.
  db.pragma('foreign_keys = OFF');

  // ── Atomic apply+record ──
  // Each migration file is applied AND recorded into _migrations inside ONE
  // transaction, so a mid-file crash can no longer leave partial DDL committed
  // (a re-run would otherwise die on a bare ALTER/CREATE), and the old
  // crash-between-exec-and-record double-run window is closed: either both the
  // schema change and its _migrations row commit, or neither does. Verified safe
  // to wrap every file: no migration self-BEGINs, none runs a transaction-hostile
  // statement (VACUUM / FTS 'rebuild' / a foreign_keys PRAGMA), and FK enforcement
  // is toggled outside this loop.
  const applyOne = db.transaction((fileName: string, sqlText: string) => {
    // Migration 019 needs special inline SQL (the .sql file is a no-op marker).
    if (fileName === '019_agent_sdk_auth.sql') {
      db.exec(`
        CREATE TABLE IF NOT EXISTS providers_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('anthropic', 'openai', 'openai-compatible', 'ollama')),
          base_url TEXT,
          auth_type TEXT NOT NULL CHECK(auth_type IN ('api_key', 'oauth', 'none', 'agent-sdk')),
          is_validated INTEGER NOT NULL DEFAULT 0,
          validated_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO providers_new SELECT * FROM providers;
        DROP TABLE IF EXISTS providers;
        ALTER TABLE providers_new RENAME TO providers;
      `);
    } else {
      db.exec(sqlText);
    }
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(fileName);
  });

  // ── Chain timing (info-level, cheap Date.now diffs) ──
  const chainStart = Date.now();
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    logger.info(`Running migration: ${file}`);
    const started = Date.now();
    try {
      applyOne(file, sql);
    } catch (err) {
      logger.error(`Migration failed: ${file}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      db.pragma('foreign_keys = ON');
      throw err;
    }
    logger.info(`Migration applied: ${file}`, { ms: Date.now() - started });
  }
  if (pending.length > 0) {
    logger.info('Migration chain complete', {
      applied: pending.length,
      totalMs: Date.now() - chainStart,
    });
  }

  // Re-enable FK checks after all migrations
  db.pragma('foreign_keys = ON');

  // ── 075 visibility ──
  // When migration 075 was just applied, surface how many role='user' rows are still
  // UNCLASSIFIED yet carry content that starts with '[', a bracketed prefix 075's
  // backfill did not recognise. A novel legacy engine prefix would otherwise render
  // silently as the user speaking; this count makes it visible so it can be classified
  // instead of leaking as user speech.
  // T6: "unclassified" was `origin_kind IS NULL`; it is `lane = 'owner'` now (migration
  // 127 derived the lane FROM origin_kind for every migrated row, so the two select the
  // same rows). The probe only ever runs on a database old enough for 075 to be pending,
  // which reaches this code path with the unified table already in place.
  if (pending.includes('075_message_origin_kind.sql')) {
    try {
      const unmatched = (db.prepare(
        `SELECT COUNT(*) AS c FROM messages
          WHERE role = 'user' AND lane = 'owner' AND content LIKE '[%'`,
      ).get() as { c: number }).c;
      logger.info(
        'Migration 075 applied: user rows with a bracketed prefix still unclassified (potential unmatched engine prefixes)',
        { count: unmatched },
      );
    } catch { /* visibility only; a probe failure must never fail the boot */ }
  }

  // Backfill FTS index for existing messages that predate the trigger
  const ftsCount = (db.prepare('SELECT COUNT(*) as count FROM messages_fts').get() as { count: number }).count;
  const msgCount = (db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count;
  if (ftsCount < msgCount) {
    logger.info(`Backfilling FTS index: ${msgCount - ftsCount} messages`);
    db.exec(`INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages WHERE rowid NOT IN (SELECT rowid FROM messages_fts)`);
  }
}

// ── Pre-migration-chain online backup ──
// Snapshots the live DB to ~/.dojo/data/backups/ BEFORE the pending chain runs,
// giving the deliberate no-rollback-after-migrations policy (owner decision D-F)
// a concrete restore point. Uses SQLite's VACUUM INTO (an ONLINE snapshot that
// folds committed WAL frames into a consistent copy), NOT fs.copyFile, which on a
// live WAL database would copy the main file without the un-checkpointed WAL and
// yield a torn/stale backup. Best-effort: a backup problem is logged but NEVER
// blocks a needed migration (the migrations are themselves transaction-atomic).
function backupBeforeMigrationChain(
  db: ReturnType<typeof getDb>,
  allFiles: string[],
  pending: string[],
): void {
  try {
    const dbPath = getDbPath();
    const dataDir = path.dirname(dbPath);
    const backupsDir = path.join(dataDir, 'backups');

    const fileSize = (p: string): number => {
      try { return fs.statSync(p).size; } catch { return 0; }
    };
    // Live footprint = main file + WAL + SHM (a busy box carries recent writes in
    // the WAL until the next checkpoint).
    const dbSize = fileSize(dbPath) + fileSize(`${dbPath}-wal`) + fileSize(`${dbPath}-shm`);

    // Disk guard: skip (warn, do NOT fail the boot) when free space cannot hold
    // ~2x the DB. VACUUM INTO writes a full compacted copy; 2x is safe headroom.
    try {
      const stat = fs.statfsSync(dataDir);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      if (freeBytes < dbSize * 2) {
        logger.warn('Skipping pre-migration DB backup: insufficient free disk for a safe snapshot', {
          freeBytes, dbBytes: dbSize, neededBytes: dbSize * 2,
        });
        return;
      }
    } catch (err) {
      // statfs unavailable on this platform: proceed. A truly full disk makes the
      // VACUUM INTO below fail, which is caught and logged without blocking boot.
      logger.debug('Free-disk check unavailable for pre-migration backup; proceeding', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    fs.mkdirSync(backupsDir, { recursive: true });

    const migNumber = (f: string): number => {
      const n = parseInt(f.slice(0, f.indexOf('_')), 10);
      return Number.isFinite(n) ? n : 0;
    };
    const lastApplied = allFiles
      .filter(f => !pending.includes(f))
      .reduce((max, f) => Math.max(max, migNumber(f)), 0);
    const target = allFiles.reduce((max, f) => Math.max(max, migNumber(f)), 0);
    // Timestamped so same-day re-runs never collide (VACUUM INTO refuses to
    // overwrite an existing file).
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(backupsDir, `dojo-pre-${lastApplied}-to-${target}-${stamp}.db`);
    try { fs.rmSync(backupPath, { force: true }); } catch { /* nothing to remove */ }

    const started = Date.now();
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    logger.info('Pre-migration DB backup written', {
      path: backupPath,
      bytes: fileSize(backupPath),
      durationMs: Date.now() - started,
      pendingMigrations: pending.length,
    });

    // Prune: keep only the newest 2 backups.
    const backups = fs.readdirSync(backupsDir)
      .filter(f => f.startsWith('dojo-pre-') && f.endsWith('.db'))
      .map(f => {
        const full = path.join(backupsDir, f);
        return { full, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of backups.slice(2)) {
      try { fs.rmSync(stale.full, { force: true }); }
      catch (err) {
        logger.debug('Failed to prune old pre-migration backup', {
          file: stale.full, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.error('Pre-migration DB backup failed; proceeding without it (migrations are transaction-atomic)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
