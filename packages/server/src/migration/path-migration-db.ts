import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../logger.js';
import { swapHome } from './path-migration.js';

const logger = createLogger('path-migration');

export function migrateDatabase(oldHome: string, newHome: string, dojoDir: string): void {
  const dbPath = path.join(dojoDir, 'data', 'dojo.db');
  if (!fs.existsSync(dbPath)) return;

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // ONE transaction for every rewrite: a failure partway (a full disk, a locked file) rolls
  // the whole lot back and throws out of migratePaths, so the import fails and puts the
  // previous data back. Only a table or column that does not exist (an older database) is
  // skipped; any other error is real and must not be swallowed.
  const has = (table: string, ...cols: string[]): boolean => {
    const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
    return cols.every((c) => have.has(c));
  };

  try {
    db.transaction(() => {
    // Technique directory paths
    if (has('techniques', 'id', 'directory_path')) {
      const techniques = db.prepare("SELECT id, directory_path FROM techniques WHERE directory_path LIKE ?").all(`${oldHome}%`) as Array<{ id: string; directory_path: string }>;
      const updateTech = db.prepare('UPDATE techniques SET directory_path = ? WHERE id = ?');
      for (const t of techniques) {
        updateTech.run(swapHome(t.directory_path, oldHome, newHome), t.id);
      }
      if (techniques.length > 0) {
        logger.info('Updated technique paths', { count: techniques.length });
      }
    }

    // Platform config paths
    if (has('config', 'key', 'value')) {
      const configs = db.prepare("SELECT key, value FROM config WHERE value LIKE ?").all(`%${oldHome}%`) as Array<{ key: string; value: string }>;
      const updateConfig = db.prepare('UPDATE config SET value = ? WHERE key = ?');
      for (const c of configs) {
        updateConfig.run(swapHome(c.value, oldHome, newHome), c.key);
      }
      if (configs.length > 0) {
        logger.info('Updated config paths', { count: configs.length });
      }
    }

    // Agent system_prompt_path and any config JSON that might contain paths
    if (has('agents', 'id', 'system_prompt_path', 'config')) {
      const agents = db.prepare("SELECT id, system_prompt_path, config FROM agents WHERE system_prompt_path LIKE ? OR config LIKE ?").all(`${oldHome}%`, `%${oldHome}%`) as Array<{ id: string; system_prompt_path: string | null; config: string | null }>;
      const updateAgent = db.prepare('UPDATE agents SET system_prompt_path = ?, config = ? WHERE id = ?');
      for (const a of agents) {
        const newPromptPath = a.system_prompt_path ? swapHome(a.system_prompt_path, oldHome, newHome) : null;
        const newConfig = a.config ? swapHome(a.config, oldHome, newHome) : null;
        updateAgent.run(newPromptPath, newConfig, a.id);
      }
      if (agents.length > 0) {
        logger.info('Updated agent paths', { count: agents.length });
      }
    }

    // Upload file paths in messages (attachments JSON)
    //
    // PHASE-1 T4 (2026-07-27): this is the ONE write against `messages` that does NOT go
    // through memory/message-store.ts, and the exemption is deliberate — it is named in
    // OFFLINE_DB_TOOLS in memory/__tests__/single-writer-conformance.test.ts, with a test
    // that only lets a file sit there if it really does open its own connection.
    //
    // The reason: this function rewrites $HOME references inside a database file taken
    // from ANOTHER MACHINE, and it opens that file itself (`new Database(dbPath)` above,
    // closed in the finally). The writer module writes through the app singleton. Routing
    // this through it would open a SECOND connection to a database the import path is
    // about to move, and would silently target the wrong file the day `dojoDir` is ever
    // passed anything other than the live one — a correctness risk taken to satisfy a rule
    // about the RUNNING platform's store, which this is not.
    if (has('messages', 'id', 'attachments')) {
      const msgs = db.prepare("SELECT id, attachments FROM messages WHERE attachments LIKE ?").all(`%${oldHome}%`) as Array<{ id: string; attachments: string }>;
      const updateMsg = db.prepare('UPDATE messages SET attachments = ? WHERE id = ?');
      for (const m of msgs) {
        updateMsg.run(swapHome(m.attachments, oldHome, newHome), m.id);
      }
      if (msgs.length > 0) {
        logger.info('Updated message attachment paths', { count: msgs.length });
      }
    }
    })();
  } finally {
    db.close();
  }
}
