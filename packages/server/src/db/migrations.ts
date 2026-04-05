import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './connection.js';
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

  for (const file of files) {
    const applied = db.prepare('SELECT name FROM _migrations WHERE name = ?').get(file);
    if (applied) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    logger.info(`Running migration: ${file}`);

    try {
      // Special handling for migrations that need FK checks disabled
      // (e.g., table recreation with FK references from other tables)
      if (file === '019_agent_sdk_auth.sql') {
        db.pragma('foreign_keys = OFF');
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
        db.pragma('foreign_keys = ON');
      } else {
        db.exec(sql);
      }
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      logger.info(`Migration applied: ${file}`);
    } catch (err) {
      logger.error(`Migration failed: ${file}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // Backfill FTS index for existing messages that predate the trigger
  const ftsCount = (db.prepare('SELECT COUNT(*) as count FROM messages_fts').get() as { count: number }).count;
  const msgCount = (db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count;
  if (ftsCount < msgCount) {
    logger.info(`Backfilling FTS index: ${msgCount - ftsCount} messages`);
    db.exec(`INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages WHERE rowid NOT IN (SELECT rowid FROM messages_fts)`);
  }
}
