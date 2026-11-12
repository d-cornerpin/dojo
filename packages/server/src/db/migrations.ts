import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './connection.js';
import { ensurePreChainBackup } from './migration-backup.js';
import { createLogger } from '../logger.js';

const logger = createLogger('migrations');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/** What `_migrations.checksum` records: sha256 of the file text with CRLF normalised. */
const migrationChecksum = (sqlText: string): string =>
  crypto.createHash('sha256').update(sqlText.replace(/\r\n/g, '\n'), 'utf-8').digest('hex');

/** The chain's files, in the order it applies them. Empty when the directory is absent. */
export function migrationFileNames(): string[] {
  return fs.existsSync(MIGRATIONS_DIR) ? fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort() : [];
}

/** One chain file's text, read from the bundled migrations directory. */
export function readMigrationFile(name: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf-8');
}

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

// A repair file may sort before a migration that drops its subject, so a body already past that point
// would fail to prepare it. SQLite resolves columns at prepare time, so the guard cannot live in the SQL:
// a file declares `-- REQUIRES-COLUMN: <table>.<column>` and, when the column is absent, is recorded as
// run without executing (a dropped column never returns, so retrying every boot would be a crash loop).
const REQUIRES_COLUMN = /^--[ \t]*REQUIRES-COLUMN:[ \t]*([A-Za-z_]\w*)\.([A-Za-z_]\w*)[ \t]*$/m;

/** The `<table>.<column>` a migration declared and this database does not have, or null. */
function unmetRequirement(db: ReturnType<typeof getDb>, sqlText: string): string | null {
  const declared = REQUIRES_COLUMN.exec(sqlText);
  if (!declared) return null;
  const [, table, column] = declared;
  const present = db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column);
  return present ? null : `${table}.${column}`;
}

function runSqlMigrations(db: ReturnType<typeof getDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      checksum TEXT
    );
  `);
  if (!(db.prepare('PRAGMA table_info(_migrations)').all() as { name: string }[]).some((c) => c.name === 'checksum')) {
    db.exec('ALTER TABLE _migrations ADD COLUMN checksum TEXT');
  }

  if (!fs.existsSync(MIGRATIONS_DIR)) return;
  const files = migrationFileNames();

  // Read-only probe of the pending set so the backup sees it whole; each file is recorded in applyOne.
  const pending = files.filter(
    f => !db.prepare('SELECT name FROM _migrations WHERE name = ?').get(f),
  );

  // Snapshot before any pending migration (see migration-backup.ts). Its throw is deliberately not caught:
  // a boot that fails before any migration applied is still covered by the watchdog's auto-rollback.
  if (pending.length > 0) {
    ensurePreChainBackup(db, files, pending);
  }

  // FK checks off for the whole chain (migrations drop and recreate cross-referenced tables). Set outside
  // the per-file transactions, where a `PRAGMA foreign_keys` change would be a no-op.
  db.pragma('foreign_keys = OFF');

  // Each file is applied AND recorded in one transaction: both commit or neither. So no migration may
  // self-BEGIN or run VACUUM, an FTS 'rebuild' or a foreign_keys PRAGMA.
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
    db.prepare('INSERT INTO _migrations (name, checksum) VALUES (?, ?)')
      .run(fileName, migrationChecksum(sqlText));
  });

  const chainStart = Date.now();
  for (const file of pending) {
    const sql = readMigrationFile(file);
    const missing = unmetRequirement(db, sql);
    if (missing) {
      // The file's subject is already gone: record it as run (see REQUIRES_COLUMN above).
      logger.info(`Migration not applicable to this database; recording as run: ${file}`, { missing });
      db.prepare('INSERT INTO _migrations (name, checksum) VALUES (?, ?)')
        .run(file, migrationChecksum(sql));
      continue;
    }
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
    // The one-path upgrade reports what it mapped, per class, on the line that says it ran.
    const mapped = file === '901_task_done_one_path.sql'
      ? (db.prepare("SELECT value FROM config WHERE key = 'task_done_upgrade_last'").get() as { value: string } | undefined)?.value : undefined;
    logger.info(`Migration applied: ${file}`, { ms: Date.now() - started, ...(mapped ? { mapped: JSON.parse(mapped) } : {}) });
  }
  if (pending.length > 0) {
    logger.info('Migration chain complete', {
      applied: pending.length,
      totalMs: Date.now() - chainStart,
    });
  }

  db.pragma('foreign_keys = ON');

  // A released file never changes under a box (the release gate holds that). One that did is said
  // once per boot and is never re-run: its effect is what this database already holds.
  const changed = (db.prepare('SELECT name, checksum FROM _migrations WHERE checksum IS NOT NULL').all() as { name: string; checksum: string }[])
    .filter((r) => { try { return migrationChecksum(readMigrationFile(r.name)) !== r.checksum; } catch { return false; } })
    .map((r) => r.name);
  if (changed.length > 0) logger.warn('Migration files differ from the ones this database applied; they are not re-run', { files: changed });

  // When 075 just ran, log how many owner-lane user rows still start with '[': an unrecognised legacy
  // engine prefix would otherwise render silently as the user speaking.
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

  // Search-index health belongs to memory/fts-health.ts, run off-thread once the box serves (index.ts).
  // Never add an fts5 'rebuild' here: on a large database it blocks the boot for minutes.
}

