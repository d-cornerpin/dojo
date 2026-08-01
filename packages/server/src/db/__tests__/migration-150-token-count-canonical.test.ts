// PHASE-3 T2 Step 3b — the permanent tripwire for `messages.token_count`'s ONE dialect.
//
// THE DEFECT THIS FILE EXISTS FOR. `token_count` is what `budgetFreshTail` spends as the
// INPUT cost of carrying a row, and three different things had been written into it:
// `ceil(len/4)` by the live writer, `MAX(1, len/4)` truncating by migration `127`'s backfill
// and `129b`'s stable-merge inserts, and — the one that matters — the provider's OUTPUT
// token count for the WHOLE TURN, handed over by `agent/v2/loop.ts:5381/:5436/:7550`.
// Measured readonly on a live `.24` body before the fix: 852,464 stored against a true
// 262,949 on the assistant lane (3.24x), +36.9% across the store. The assembler therefore
// believed the fresh tail cost 37% more than it did and dropped history the window did not
// require.
//
// WHY THE CHAIN IS REPLAYED RATHER THAN A FIXTURE HAND-ROLLED. The same reasoning as
// `migration-135-time-floor.test.ts`: the question is what the SHIPPED file does to a REAL
// body at the real schema, and a hand-built `messages` table drifts from the one `150`
// updates. This applies the real files in order to `149`, seeds the adversarial shapes the
// T2 rehearsal used, applies `150`, and reads the result.
//
// The strong proof is the two-body rehearsal in the T2 report (a `VACUUM INTO` copy of the
// live dev body, unplanted and planted, with per-branch row counts and 13 planted shapes).
// This file is the permanent guard that stops the dialect re-forking.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateStoredTokens, CHARS_PER_TOKEN } from '../../memory/budget.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, '..', 'migrations');
const FILES = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

const BEFORE = '149_cost_records_estimate.sql';
const SUBJECT = '150_token_count_canonical.sql';

function baseSchemaFromRunner(): string {
  const src = fs.readFileSync(path.join(HERE, '..', 'migrations.ts'), 'utf-8');
  const start = src.indexOf('db.exec(`');
  const end = src.indexOf('`);', start);
  if (start < 0 || end < 0) throw new Error('could not locate the base schema in migrations.ts');
  return src.slice(start + 'db.exec(`'.length, end);
}

function applyChainUpTo(db: Database.Database, upTo: string): void {
  db.pragma('foreign_keys = OFF');
  db.exec(baseSchemaFromRunner());
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  for (const f of FILES) {
    if (f > upTo) break;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8');
    db.transaction(() => {
      if (f !== '019_agent_sdk_auth.sql') db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
    })();
  }
}

function applyOne(db: Database.Database, file: string): void {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
  db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
  })();
}

/**
 * The adversarial shapes. Every one is a BRANCH: a zero-row branch is an untested branch
 * (the rehearsal-body rider, earned by the `.23` incident at `144`), so each is planted
 * rather than hoped for.
 */
const PLANTS: Array<{ tag: string; content: string; stored: number; role?: string }> = [
  { tag: 'empty-content', content: '', stored: 1 },
  { tag: 'one-char', content: 'x', stored: 1 },
  { tag: 'exact-multiple-of-4', content: 'y'.repeat(4000), stored: 1000 },
  { tag: 'multi-KB', content: 'z'.repeat(37_501), stored: 3 },
  { tag: 'already-correct', content: 'q'.repeat(400), stored: 100 },
  { tag: 'dialect-2-truncating', content: 'w'.repeat(502), stored: 125 },
  { tag: 'dialect-3-assistant', content: 'a'.repeat(1200), stored: 24_817, role: 'assistant' },
  { tag: 'trigger-127-stamped', content: 'e'.repeat(17), stored: 4 },
  { tag: 'token-count-zero', content: 'r'.repeat(80), stored: 0 },
  { tag: 'newline-heavy', content: '\n'.repeat(999), stored: 250 },
  { tag: 'absurdly-high', content: 's'.repeat(5), stored: 999_999 },
];

let db: Database.Database;

function seed(): void {
  db.prepare(`INSERT OR IGNORE INTO agents (id, name) VALUES ('a1', 'A1')`).run();
  const ins = db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, token_count, lane, display_kind, display_tier, provenance)
     VALUES (?, 'a1', ?, ?, ?, 'owner', 'user-text', 'user-visible', 'live')`,
  );
  for (const p of PLANTS) ins.run(`plant-${p.tag}`, p.role ?? 'user', p.content, p.stored);
}

beforeEach(() => {
  db = new Database(':memory:');
  applyChainUpTo(db, BEFORE);
  seed();
});
afterEach(() => db.close());

describe('migration 150 — one dialect in messages.token_count', () => {
  it('is RED before it runs: the planted body violates the invariant it establishes', () => {
    const bad = db.prepare(
      'SELECT COUNT(*) n FROM messages WHERE token_count <> MAX(1,(LENGTH(content)+3)/4)',
    ).get() as { n: number };
    expect(bad.n).toBeGreaterThan(0);
  });

  it('leaves EVERY row at the canonical estimate, and the astral case is the only residue', () => {
    applyOne(db, SUBJECT);
    const rows = db.prepare('SELECT id, content, token_count FROM messages').all() as
      Array<{ id: string; content: string; token_count: number }>;
    expect(rows.length).toBe(PLANTS.length);
    for (const r of rows) {
      expect(r.token_count, `${r.id} must equal the ONE estimator`).toBe(estimateStoredTokens(r.content));
    }
  });

  it('exercises every planted branch — none of these is a zero-row branch', () => {
    const before = db.prepare('SELECT id, token_count FROM messages').all() as Array<{ id: string; token_count: number }>;
    applyOne(db, SUBJECT);
    const after = new Map((db.prepare('SELECT id, token_count FROM messages').all() as Array<{ id: string; token_count: number }>).map((r) => [r.id, r.token_count]));
    // Each of these three classes must have at least one member, or the test proves nothing.
    const rose = before.filter((r) => after.get(r.id)! > r.token_count).length;
    const fell = before.filter((r) => after.get(r.id)! < r.token_count).length;
    const same = before.filter((r) => after.get(r.id)! === r.token_count).length;
    expect(rose, 'the too-low dialects (truncating, zero) must be corrected UPWARD').toBeGreaterThan(0);
    expect(fell, 'the provider-OUTPUT dialect must be corrected DOWNWARD').toBeGreaterThan(0);
    expect(same, 'rows already canonical must be left alone').toBeGreaterThan(0);
    expect(rose + fell + same).toBe(before.length);
  });

  it('NEVER touches content, ordering or time — the cache law (OR7 / roadmap #10)', () => {
    const before = db.prepare('SELECT id, content, seq, created_at, sent_at FROM messages ORDER BY seq').all();
    applyOne(db, SUBJECT);
    const after = db.prepare('SELECT id, content, seq, created_at, sent_at FROM messages ORDER BY seq').all();
    expect(after).toEqual(before);
  });

  it('is idempotent: applying it twice changes nothing the second time', () => {
    applyOne(db, SUBJECT);
    const once = db.prepare('SELECT id, token_count FROM messages ORDER BY id').all();
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, SUBJECT), 'utf-8'));
    expect(db.prepare('SELECT id, token_count FROM messages ORDER BY id').all()).toEqual(once);
  });

  it('holds the floor: no row may cost nothing to carry, and none may be NULL', () => {
    applyOne(db, SUBJECT);
    expect((db.prepare('SELECT COUNT(*) n FROM messages WHERE token_count < 1').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM messages WHERE token_count IS NULL').get() as { n: number }).n).toBe(0);
  });

  it('its own asserts BITE — a body that cannot reach one dialect aborts the file', () => {
    // Negative control. A CHECK-constrained assert that never fails is decoration; this
    // proves the file refuses rather than half-converting. The trigger writes a wrong value
    // AFTER the UPDATE, exactly as a re-introduced compat trigger would.
    db.exec(`CREATE TRIGGER _sabotage AFTER UPDATE OF token_count ON messages
             BEGIN UPDATE messages SET token_count = 424242 WHERE id = new.id AND new.token_count <> 424242; END`);
    expect(() => applyOne(db, SUBJECT)).toThrow(/CHECK constraint failed/i);
    db.exec('DROP TRIGGER _sabotage');
  });

  it('leaves NO trigger writing token_count — 133 removed 127s and none may return', () => {
    applyOne(db, SUBJECT);
    // Positive enumeration, not an absence: list the triggers and read their SQL (#15).
    const triggers = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='messages'",
    ).all() as Array<{ name: string; sql: string }>;
    expect(triggers.length).toBeGreaterThan(0);            // the FTS four must still be here
    for (const t of triggers) {
      expect(t.sql.includes('token_count'), `${t.name} writes token_count — the fork is back`).toBe(false);
    }
  });
});

describe('migration 149 — the estimate stands beside what the provider charged', () => {
  it('adds both columns and backfills NEITHER', () => {
    const cols = (db.prepare("SELECT name FROM pragma_table_info('cost_records')").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('estimated_input_tokens');
    expect(cols).toContain('estimator_chars_per_token');
    // An estimate manufactured for a call that never computed one would fabricate exactly
    // the agreement these columns exist to measure.
    const n = (db.prepare('SELECT COUNT(*) n FROM cost_records WHERE estimated_input_tokens IS NOT NULL').get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('records the divisor with the estimate so history cannot be re-interpreted', () => {
    db.prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens,
                cost_usd, estimated_input_tokens, estimator_chars_per_token, created_at)
                VALUES ('c1','a1','m1','p1', 1000, 10, 0.0, 1100, ?, datetime('now'))`).run(CHARS_PER_TOKEN);
    const r = db.prepare('SELECT input_tokens, estimated_input_tokens, estimator_chars_per_token FROM cost_records WHERE id=?').get('c1') as
      { input_tokens: number; estimated_input_tokens: number; estimator_chars_per_token: number };
    expect(r.estimator_chars_per_token).toBe(CHARS_PER_TOKEN);
    // and the error is now a subtraction anybody can run, which is the entire point
    expect(r.estimated_input_tokens - r.input_tokens).toBe(100);
  });
});
