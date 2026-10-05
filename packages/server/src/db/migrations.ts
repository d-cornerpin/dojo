import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './connection.js';
import { ensurePreChainBackup } from './migration-backup.js';
import { createLogger } from '../logger.js';
import {
  migrationChecksum, ensureMigrationChecksumColumn, reportMigrationChecksums,
} from './migration-checksums.js';

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

// ── A REPAIR FILE WHOSE SUBJECT MAY ALREADY BE GONE (UPDATE-INTEGRITY U0) ──
//
// A migration added to fix an OLD defect sorts into the chain where the damage happens, so
// a body that stopped short of that point gets the repair on its next boot. But a body that
// already ran past that point has the file PENDING too — and by then the thing the repair
// operates on can be gone. `135c_stable_close_open_parks.sql` is the case that forced this:
// it rewrites `messages.conv_key`, and `148` DROPS that column, so on every box that
// completed the 3.1.17 chain the file would be prepared against a column that no longer
// exists and throw `no such column: conv_key` — the same bricked boot the repair exists to
// end, moved thirteen files down the chain.
//
// The guard cannot live in the SQL. SQLite resolves column names when a statement is
// PREPARED, not when it runs, so `WHERE EXISTS (SELECT … FROM pragma_table_info(…))` never
// gets the chance to be false; measured, including the strongest form available (a TEMP
// TRIGGER body that is never fired still fails at prepare — the probe is kept as a test in
// `an-open-park-is-closed-by-the-chain.test.ts`).
//
// So a file may DECLARE what it needs, on one line the runner reads:
//
//     -- REQUIRES-COLUMN: <table>.<column>
//
// When the column is absent the file is RECORDED AS RUN WITHOUT EXECUTING. Recorded, not
// re-tried, because the condition is permanent: a dropped column does not come back, and a
// file retried every boot forever is a crash loop with extra steps. Its checksum is stored
// like any other, so the boot divergence audit still describes the exact text this database
// adjudicated. Deliberately ONE form and not a general expression language: the question a
// repair file needs to ask is "is my subject still here", and a directive that could ask
// anything would become a place to put logic that belongs in the file.
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
  // Ensure migration tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // RULING 7 rider (a). Must run BEFORE the chain: the rows this boot writes carry
  // their checksums, and the audit below reads the column on the same pass.
  ensureMigrationChecksumColumn(db);

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
  //
  // This CAN throw (MigrationBackupRequiredError), and that is the point: a chain
  // with no restore point is not run. See db/migration-backup.ts for the two scope
  // limits and the override. The throw is deliberately NOT caught here — it must
  // reach the boot, because a boot that fails before any migration applied is one
  // the watchdog's auto-rollback still covers, whereas a chain that ran without a
  // backup is not covered by anything.
  if (pending.length > 0) {
    ensurePreChainBackup(db, files, pending);
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
    // RULING 7 rider (a): record WHAT ran, not just that something by this name did.
    // Inside the same transaction as the apply, so the checksum can never describe a
    // file other than the one whose DDL just committed.
    db.prepare('INSERT INTO _migrations (name, checksum) VALUES (?, ?)')
      .run(fileName, migrationChecksum(sqlText));
  });

  // ── Chain timing (info-level, cheap Date.now diffs) ──
  const chainStart = Date.now();
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const missing = unmetRequirement(db, sql);
    if (missing) {
      // The subject of this file is already gone. Record it as run and move on — see
      // `unmetRequirement` for why this is a skip and not a failure.
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

  // RULING 7 rider (a): the boot divergence check. Report tier by construction — see
  // `migration-checksums.ts` for the refusal-tier argument and the Bridge author's story.
  reportMigrationChecksums(db, (name) => {
    try { return fs.readFileSync(path.join(migrationsDir, name), 'utf-8'); }
    catch { return null; }
  });

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

  // ── The search index's health is `memory/fts-health.ts`'s question now (t89 D3 / t98 D3) ──
  //
  // A region here used to compare `messages_fts_docsize` against `messages` and repair a mismatch
  // with fts5's `'rebuild'`. It asked the RIGHT question — it replaced an earlier probe that
  // compared `messages` against itself and whose repair structurally could not fire — and that
  // argument, with the measurement behind it, is carried in `fts-health.ts`'s header rather than
  // lost with the code.
  //
  // What it could not be, HERE, was non-blocking. `runMigrations()` is called hundreds of lines
  // ahead of the port bind, and `'rebuild'` on a 729 MB database is minutes of synchronous C++ on
  // the thread that is about to serve HTTP — so the box whose index is broken was exactly the box
  // that spent its whole boot window rebuilding before it answered anything. It also could not see
  // a MISSING table (`COUNT(*) FROM messages_fts_docsize` throws, the catch logs, nothing is
  // repaired) or a CORRUPT one (agreeing counts say the row COUNT is right and say nothing about
  // whether `MATCH` works).
  //
  // `scheduleFtsHealthCheck()` in `index.ts` answers all three, on another thread, 45 s after the
  // box is already serving. ⚠ DO NOT RE-ADD A REBUILD HERE: a clause
  // (`memory/__tests__/a-database-from-april-must-end-up-searchable.test.ts`) reads this file with
  // its comments stripped and reds on an fts5 `'rebuild'` call anywhere in it, because both
  // mechanisms shipping at once is how the background one quietly never repaired anything — the
  // synchronous one got there first, and the boot stayed blocked.
}

