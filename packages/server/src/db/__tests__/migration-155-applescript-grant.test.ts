// ════════════════════════════════════════════════════════════════════════════
// MIGRATION 155 (applescript becomes an explicit grant) — THE REHEARSAL BODIES.
//
// Roadmap #16: every plan-supplied artefact is rehearsed against reality before
// it is trusted. For a migration that means bodies, and the THIRD one — the
// adversarial body with planted malformed / legacy / NULL manifests — is the one
// that earns its keep. `agents.permissions` is a free-text column with NO CHECK
// constraint, so a lived-in box carries every shape anybody ever wrote into it.
// SQLite's json functions RAISE on malformed input; a raise inside a migration
// aborts the chain, and an aborted chain aborts the BOOT. A migration that
// refuses a lived-in body is the `.23` / `135` incident class, and the whole
// point of driving it here is that the box in question is the OWNER'S.
//
// BODY A  clean/empty            — the DDL runs on a fresh install
// BODY B  the shapes that matter — '*' array, '*' scalar, already-explicit, none
// BODY C  ADVERSARIAL            — NULL, '', '{}', not-JSON-at-all, legacy shapes,
//                                  a nested object where an array belongs
// BODY D  COUNTERFACTUAL         — the same adversarial body with the CASE guard
//                                  removed, proving the guard is load-bearing
//                                  rather than decorative
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_155 = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '155_applescript_explicit_grant.sql'),
  'utf-8',
);

/** Apply the way `db/migrations.ts` applies: one `exec`, one transaction, FKs off. */
function apply(db: Database.Database, sql: string = MIGRATION_155): void {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => db.exec(sql))();
  db.pragma('foreign_keys = ON');
}

function body(rows: Array<[string, string | null]>): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY, permissions TEXT);');
  const insert = db.prepare('INSERT INTO agents (id, permissions) VALUES (?, ?)');
  for (const [id, permissions] of rows) insert.run(id, permissions);
  return db;
}

const control = (id: string, db: Database.Database): unknown => {
  const row = db.prepare('SELECT permissions FROM agents WHERE id = ?').get(id) as { permissions: string | null };
  if (row.permissions === null) return null;
  try { return JSON.parse(row.permissions).system_control; } catch { return '<not json>'; }
};

/** A manifest with the given `system_control`, in the shape a real row carries. */
const manifest = (system_control: unknown): string => JSON.stringify({
  file_read: '*', file_write: '*', file_delete: 'none',
  exec_allow: ['*'], exec_deny: [], network_domains: '*',
  max_processes: 10, can_spawn_agents: true, can_assign_permissions: true,
  system_control,
});

describe('BODY A — a clean body', () => {
  it('applies against an empty agents table and changes nothing', () => {
    const db = body([]);
    expect(() => apply(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 0 });
  });
});

describe('BODY B — the shapes this migration exists for', () => {
  const rows: Array<[string, string | null]> = [
    ['star-array', manifest(['*'])],
    ['star-scalar', manifest('*')],
    ['star-with-others', manifest(['*', 'mouse', 'keyboard'])],
    ['already-explicit', manifest(['*', 'applescript'])],
    ['already-explicit-run', manifest(['*', 'applescript_run'])],
    ['explicit-no-star', manifest(['applescript'])],
    ['healer-shaped', manifest([])],
    ['no-star', manifest(['mouse', 'keyboard', 'screen'])],
  ];

  it('appends `applescript` to every `\'*\'` holder and to nothing else', () => {
    const db = body(rows);
    apply(db);
    // THE PRESERVED SET. Each of these held AppleScript through the blanket and
    // keeps it through an explicit name.
    expect(control('star-array', db)).toEqual(['*', 'applescript']);
    expect(control('star-with-others', db)).toEqual(['*', 'mouse', 'keyboard', 'applescript']);
    // The scalar spelling normalises to the one-element array it already meant.
    expect(control('star-scalar', db)).toEqual(['*', 'applescript']);
    // ALREADY EXPLICIT — skipped, which is what makes this idempotent.
    expect(control('already-explicit', db)).toEqual(['*', 'applescript']);
    expect(control('already-explicit-run', db)).toEqual(['*', 'applescript_run']);
    // NO `'*'` — untouched. The Healer's real shape is in here by name, because
    // the plan's premise said it was a `'*'` holder and the live row says
    // otherwise; a migration that "fixed" it would have WIDENED a manifest.
    expect(control('explicit-no-star', db)).toEqual(['applescript']);
    expect(control('healer-shaped', db)).toEqual([]);
    expect(control('no-star', db)).toEqual(['mouse', 'keyboard', 'screen']);
  });

  it('is IDEMPOTENT — running it twice appends nothing the second time', () => {
    const db = body(rows);
    apply(db);
    const after1 = db.prepare('SELECT id, permissions FROM agents ORDER BY id').all();
    apply(db);
    const after2 = db.prepare('SELECT id, permissions FROM agents ORDER BY id').all();
    expect(after2).toEqual(after1);
  });

  it('changes NOTHING ELSE in a manifest it rewrites', () => {
    const db = body([['star-array', manifest(['*'])]]);
    const before = JSON.parse(
      (db.prepare("SELECT permissions FROM agents WHERE id='star-array'").get() as { permissions: string }).permissions,
    );
    apply(db);
    const after = JSON.parse(
      (db.prepare("SELECT permissions FROM agents WHERE id='star-array'").get() as { permissions: string }).permissions,
    );
    // Every other field byte-for-byte, and only `system_control` moved.
    expect({ ...after, system_control: null }).toEqual({ ...before, system_control: null });
  });
});

describe('BODY C — THE ADVERSARIAL BODY (the one that decides the guard)', () => {
  // Every shape a free-text column with no CHECK actually accumulates. Each of
  // these was a live possibility BEFORE this task, so each must survive the
  // migration untouched rather than abort it.
  const adversarial: Array<[string, string | null]> = [
    ['null-permissions', null],
    ['empty-string', ''],
    ['empty-object', '{}'],
    ['not-json-at-all', 'permissions: none, ask kevin'],
    ['truncated-json', '{"file_read":"*","system_control":["*"'],
    ['legacy-no-system-control', '{"file_read":"*","file_write":"none","exec_allow":[]}'],
    ['system-control-object', '{"system_control":{"applescript":true}}'],
    ['system-control-number', '{"system_control":7}'],
    ['system-control-null', '{"system_control":null}'],
    ['json-array-at-root', '["not","a","manifest"]'],
    // …and one real target mixed in, so the clause proves the migration still
    // DOES its job on a body that also contains junk.
    ['real-star-holder', manifest(['*'])],
  ];

  it('⚠ APPLIES WITHOUT RAISING — a migration that refuses a lived-in body aborts the BOOT', () => {
    const db = body(adversarial);
    expect(() => apply(db)).not.toThrow();
  });

  it('leaves every malformed / legacy / NULL row EXACTLY as it found it', () => {
    const db = body(adversarial);
    const before = db.prepare('SELECT id, permissions FROM agents ORDER BY id').all() as Array<{ id: string; permissions: string | null }>;
    apply(db);
    const after = db.prepare('SELECT id, permissions FROM agents ORDER BY id').all() as Array<{ id: string; permissions: string | null }>;
    for (const row of before) {
      if (row.id === 'real-star-holder') continue;
      const now = after.find((r) => r.id === row.id);
      expect(now?.permissions, `${row.id} must be untouched`).toBe(row.permissions);
    }
  });

  it('and STILL does its job on the one real holder in that body', () => {
    // The half that stops "guard everything" from becoming "do nothing".
    const db = body(adversarial);
    apply(db);
    expect(control('real-star-holder', db)).toEqual(['*', 'applescript']);
  });
});

describe('BODY D — the COUNTERFACTUAL, which is what makes the guard a measurement', () => {
  it('WITHOUT the CASE guard the same body ABORTS — malformed JSON raises', () => {
    // The guard is not decoration. Strip it back to the `json_valid()`-only form
    // a reasonable person would write first, run the identical adversarial body,
    // and the migration throws — which in the real chain is a box that will not
    // boot. This clause is why the CASE is in the file.
    const naive = MIGRATION_155
      .replace(/CASE WHEN json_valid\(permissions\) THEN permissions ELSE '\{\}' END/g, 'permissions')
      .replace(/CASE WHEN json_valid\(agents\.permissions\) THEN agents\.permissions ELSE '\{\}' END/g, 'agents.permissions');
    // Sanity: the substitution actually removed the guard, so a silent regex
    // miss cannot make this clause pass for the wrong reason.
    expect(naive).not.toContain('CASE WHEN json_valid');
    expect(naive).not.toBe(MIGRATION_155);

    const db = body([
      ['not-json-at-all', 'permissions: none, ask kevin'],
      ['real-star-holder', manifest(['*'])],
    ]);
    expect(() => apply(db, naive)).toThrow(/malformed|JSON/i);
  });

  it('and with the guard, that identical body applies clean', () => {
    const db = body([
      ['not-json-at-all', 'permissions: none, ask kevin'],
      ['real-star-holder', manifest(['*'])],
    ]);
    expect(() => apply(db)).not.toThrow();
    expect(control('real-star-holder', db)).toEqual(['*', 'applescript']);
  });
});
