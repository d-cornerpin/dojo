// ════════════════════════════════════════════════════════════════════════════════════════
// t155 A — 129b SECTION 4a: A PEER ROW WITH NO SENDER MUST NOT ABORT THE UPDATE.
//
// A box at v3.1.10..v3.1.17-preflight.22 that holds ONE `inter_agent_messages` row with
// role 'user', origin_kind NULL (a peer message) and source_agent_id NULL aborted the chain at
// 129b on every boot: section 4a copied the sender straight through into `messages`, whose
// CHECK refuses an a2a-lane row that is not assistant/tool and names no sender
// (`lane <> 'a2a' OR role IN ('assistant','tool') OR source_agent_id IS NOT NULL`).
// Migration 098 back-filled that table with no sender guard, and 126b repaired NULL senders
// only in `messages`, so such a row can exist. Section 4b already falls back to the
// `unrecorded-peer` token; 4a now does the same for exactly the rows the CHECK needs it for.
//
// THE BODY is the real chain replayed to migration 129 (the schema every affected box holds
// just before 129b), with a hostile `inter_agent_messages`:
//   1. a peer 'user' row, no sender      -> needs the fallback
//   2. a peer 'system' row, no sender    -> needs the fallback (the CHECK only exempts assistant/tool)
//   3. an 'assistant' row, no sender     -> CHECK-legal as NULL; must STAY NULL (no invented sender)
//   4. a 'tool' row, no sender           -> same
//   5. an engine row ('events' lane), no sender -> not a2a; must STAY NULL
//   6. a peer 'user' row with a sender   -> carried unchanged
// It goes through the real runner (`runMigrations`), so the boot is the thing under test.
//
// THE LEDGER: 129b is a released, applied migration, so amending it needs a KNOWN_DIVERGENCES
// entry or every box that already ran it logs MIGRATION DIVERGENCE at ERROR for ever. The
// clauses below rebuild the pre-amend bytes by reversing the edit, prove their checksum is the
// ledger's `appliedChecksum`, and read a box that applied them through the real audit.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, '..', 'migrations');
const FILES = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t155-129b');
const BEFORE_129B = '129_drop_messages_compat_columns.sql';
const FILE = '129b_stable_merge_messages.sql';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t155-129b');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t155-129b', 'dojo.db'),
  };
});

import { runMigrations } from '../migrations.js';
import { auditMigrationChecksums, KNOWN_DIVERGENCES, migrationChecksum } from '../migration-checksums.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

/** The runner's own first `db.exec()` — read, never copied, so the base cannot drift. */
function baseSchemaFromRunner(): string {
  const src = fs.readFileSync(path.join(HERE, '..', 'migrations.ts'), 'utf-8');
  const start = src.indexOf('db.exec(`');
  const end = src.indexOf('`);', start);
  return src.slice(start + 'db.exec(`'.length, end);
}

const IA_ROWS: ReadonlyArray<{ id: string; role: string; sender: string | null; origin: string | null }> = [
  { id: 'fx-ia-user-nosender', role: 'user', sender: null, origin: null },
  { id: 'fx-ia-system-nosender', role: 'system', sender: null, origin: null },
  { id: 'fx-ia-assistant-nosender', role: 'assistant', sender: null, origin: null },
  { id: 'fx-ia-tool-nosender', role: 'tool', sender: null, origin: null },
  { id: 'fx-ia-engine-nosender', role: 'user', sender: null, origin: 'engine' },
  { id: 'fx-ia-user-sender', role: 'user', sender: 'fx-peer', origin: null },
];

/** A box one step before 129b: the real chain to 129, carrying the hostile peer-message table. */
function bodyBefore129b(): Database.Database {
  const d = new Database(':memory:');
  mockDb.current = d;
  d.pragma('foreign_keys = OFF');
  d.exec(baseSchemaFromRunner());
  d.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  for (const f of FILES) {
    if (f > BEFORE_129B) break;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8');
    d.transaction(() => {
      if (f !== '019_agent_sdk_auth.sql') d.exec(sql);
      d.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
    })();
  }
  d.prepare(`INSERT INTO agents (id, name, status) VALUES ('fx-recipient', 'Recipient', 'idle'), ('fx-peer', 'Peer', 'idle')`).run();
  const ins = d.prepare(`INSERT INTO inter_agent_messages (id, agent_id, role, content, source_agent_id, origin_kind, created_at)
    VALUES (?, 'fx-recipient', ?, ?, ?, ?, '2026-01-01 00:00:00')`);
  for (const r of IA_ROWS) ins.run(r.id, r.role, `body of ${r.id}`, r.sender, r.origin);
  d.pragma('foreign_keys = ON');
  return d;
}

/** The pre-amend bytes, rebuilt by reversing the two edits to section 4a. */
function preAmendText(): string {
  const now = fs.readFileSync(path.join(MIGRATIONS_DIR, FILE), 'utf-8');
  const caseExpr = /  CASE WHEN ia\.source_agent_id IS NULL[\s\S]*?ELSE ia\.source_agent_id END,\n  ia\.a2a_thread_id,/;
  const note = /--   source_agent_id <- ia\.source_agent_id, EXCEPT[\s\S]*?every other NULL stays NULL\.\n/;
  expect(caseExpr.test(now), 'the CASE expression is in section 4a').toBe(true);
  expect(note.test(now), 'the explanatory note is in section 4a').toBe(true);
  return now.replace(caseExpr, '  ia.source_agent_id, ia.a2a_thread_id,').replace(note, '');
}

describe('the witness: the old file really does abort on this body', () => {
  it('the pre-amend 129b throws the CHECK on the peer row with no sender', () => {
    const d = bodyBefore129b();
    expect(() => d.exec(preAmendText())).toThrow(/CHECK constraint failed/);
  });
});

describe('the upgrade door: the real runner', () => {
  it('crosses 129b, folds every row, and gives a sender only to the rows the CHECK needs it for', () => {
    const d = bodyBefore129b();
    expect(() => runMigrations()).not.toThrow();
    expect(d.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(FILE)).toBeTruthy();
    expect(d.prepare("SELECT 1 FROM _migrations WHERE name LIKE '900_%'").get()).toBeTruthy(); // the whole chain landed

    const row = (id: string) => d.prepare('SELECT lane, role, source_agent_id AS s, content FROM messages WHERE id = ?').get(id) as
      { lane: string; role: string; s: string | null; content: string };
    expect(row('fx-ia-user-nosender')).toMatchObject({ lane: 'a2a', role: 'user', s: 'unrecorded-peer' });
    expect(row('fx-ia-system-nosender')).toMatchObject({ lane: 'a2a', role: 'system', s: 'unrecorded-peer' });
    expect(row('fx-ia-assistant-nosender')).toMatchObject({ lane: 'a2a', role: 'assistant', s: null });
    expect(row('fx-ia-tool-nosender')).toMatchObject({ lane: 'a2a', role: 'tool', s: null });
    expect(row('fx-ia-engine-nosender')).toMatchObject({ lane: 'events', s: null });
    expect(row('fx-ia-user-sender')).toMatchObject({ lane: 'a2a', s: 'fx-peer' });
    for (const r of IA_ROWS) expect(row(r.id).content, 'content is carried byte for byte').toBe(`body of ${r.id}`);
    expect(d.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('a later boot is a no-op', () => {
    const d = bodyBefore129b();
    runMigrations();
    const names = (): string[] => (d.prepare('SELECT name FROM _migrations ORDER BY name').all() as Array<{ name: string }>).map((r) => r.name);
    const rows = (): string => JSON.stringify(d.prepare('SELECT id, source_agent_id, lane FROM messages ORDER BY id').all());
    const [n1, r1] = [names(), rows()];
    runMigrations();
    expect(names()).toEqual(n1);
    expect(rows()).toBe(r1);
  });

  it('a body with no NULL sender folds exactly as before (the clean path is untouched)', () => {
    const d = bodyBefore129b();
    d.prepare("DELETE FROM inter_agent_messages WHERE source_agent_id IS NULL AND origin_kind IS NOT 'engine' AND role IN ('user','system')").run();
    runMigrations();
    expect(d.prepare("SELECT COUNT(*) AS n FROM messages WHERE source_agent_id = 'unrecorded-peer'").get()).toEqual({ n: 0 });
    expect(d.prepare("SELECT COUNT(*) AS n FROM messages WHERE id LIKE 'fx-ia-%'").get()).toEqual({ n: 4 });
  });
});

describe('the ledger: a box that already ran the old 129b reports no loud divergence', () => {
  it('the ledger entry\'s appliedChecksum is the checksum of the pre-amend bytes, and its fileChecksum is the file now', () => {
    const entry = KNOWN_DIVERGENCES.find((k) => k.file === FILE);
    expect(entry, '129b must carry an adjudication').toBeTruthy();
    expect(migrationChecksum(preAmendText())).toBe(entry!.appliedChecksum);
    expect(migrationChecksum(fs.readFileSync(path.join(MIGRATIONS_DIR, FILE), 'utf-8'))).toBe(entry!.fileChecksum);
  });

  it('the real audit reads such a box as adjudicated, not loud', () => {
    const d = new Database(':memory:');
    d.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT, checksum TEXT)');
    d.prepare('INSERT INTO _migrations (name, checksum) VALUES (?, ?)').run(FILE, migrationChecksum(preAmendText()));
    const audit = auditMigrationChecksums(d, (name) => {
      try { return fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf-8'); } catch { return null; }
    });
    expect(audit.adjudicated).toBe(1);
    expect(audit.findings.filter((f) => f.kind === 'diverged' && !f.adjudicated)).toEqual([]);
    d.close();
  });

  it('the ledger cannot pre-approve a further edit: a different applied hash is still loud', () => {
    const d = new Database(':memory:');
    d.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT, checksum TEXT)');
    d.prepare('INSERT INTO _migrations (name, checksum) VALUES (?, ?)').run(FILE, migrationChecksum('some other version'));
    const audit = auditMigrationChecksums(d, () => fs.readFileSync(path.join(MIGRATIONS_DIR, FILE), 'utf-8'));
    expect(audit.adjudicated).toBe(0);
    expect(audit.findings.filter((f) => f.kind === 'diverged' && !f.adjudicated)).toHaveLength(1);
    d.close();
  });
});
