// ════════════════════════════════════════════════════════════════════════════
// MIGRATION 179 (the N-O-N-E sweep) — THE REHEARSAL BODIES.
//
// Roadmap #16: every plan-supplied artefact is rehearsed against reality before it is trusted.
// For a migration that means bodies, and the THIRD one — the adversarial body — is the one that
// earns its keep. `agents.permissions` is free text with NO CHECK constraint, so a lived-in box
// carries every shape anybody ever wrote into it. SQLite's json functions RAISE on malformed
// input; a raise inside a migration aborts the chain, and an aborted chain aborts the BOOT.
//
// BODY A  clean/empty      — the statements run on a fresh install and change nothing
// BODY B  the shapes this exists for — pass-1 corruption, the COMPOUNDED pass-2 shape, one-field
//                            corruption, and the no-ops ('none' already, '*', a real allowlist)
// BODY C  ADVERSARIAL      — NULL, '', '{}', not-JSON-at-all, missing keys, an object where an
//                            array belongs, AND the legitimate single-character lists that MUST
//                            survive (including the bare four-element array the sweep excludes)
// BODY D  COUNTERFACTUAL   — the adversarial body with the `json_valid` CASE guard stripped,
//                            proving the guard is load-bearing rather than decorative
//
// Plus: PER-STATEMENT ROW COUNTS (a branch that touches zero rows is an untested branch) and the
// IDEMPOTENCY clause (a second pass must touch nothing).
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_179 = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '179_deny_all_is_not_four_letters.sql'),
  'utf-8',
);

/** Apply the way `db/migrations.ts` applies: one `exec`, one transaction, FKs off. */
function apply(db: Database.Database, sql: string = MIGRATION_179): void {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => db.exec(sql))();
  db.pragma('foreign_keys = ON');
}

/**
 * The file's executable statements, comments stripped — so a row count can be attributed to the
 * statement that produced it. Splitting a commented file on `;` would otherwise split inside the
 * header's prose.
 */
function statements(sql: string = MIGRATION_179): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

function body(rows: Array<[string, string | null]>): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY, permissions TEXT);');
  const insert = db.prepare('INSERT INTO agents (id, permissions) VALUES (?, ?)');
  for (const [id, permissions] of rows) insert.run(id, permissions);
  return db;
}

/** The stored value of one path field, as a reader would parse it back. */
function field(db: Database.Database, id: string, key: 'file_read' | 'file_write'): unknown {
  const row = db.prepare('SELECT permissions FROM agents WHERE id = ?').get(id) as
    { permissions: string | null } | undefined;
  if (!row || row.permissions === null) return null;
  try { return (JSON.parse(row.permissions) as Record<string, unknown>)[key]; }
  catch { return '<not json>'; }
}

/** The whole blob, byte for byte — for the rows that must not be touched at all. */
function raw(db: Database.Database, id: string): string | null {
  const row = db.prepare('SELECT permissions FROM agents WHERE id = ?').get(id) as
    { permissions: string | null };
  return row.permissions;
}

// A FICTIONAL home, and fictional agent ids throughout (G1 — nothing here names a real agent).
const HOME = '/Users/a-user/.dojo/uploads';
const art = (id: string): string => `${HOME}/${id}/**`;

/** A manifest in the shape a real row carries, with the two path fields overridden. */
const manifest = (file_read: unknown, file_write: unknown): string => JSON.stringify({
  file_read, file_write, file_delete: 'none',
  exec_allow: [], exec_deny: [], network_domains: 'none',
  max_processes: 5, can_spawn_agents: false, can_assign_permissions: false,
  system_control: [],
});

/** The measured pass-1 corruption: the four letters plus the child's own artifact directory. */
const spread1 = (id: string): string[] => ['n', 'o', 'n', 'e', art(id)];
/** The measured pass-2 corruption: a corrupted row that spawned again. */
const spread2 = (a: string, b: string): string[] => ['n', 'o', 'n', 'e', art(a), art(b)];

// ── BODY A ───────────────────────────────────────────────────────────────────

describe('BODY A — a clean body', () => {
  it('applies against an empty agents table and changes nothing', () => {
    const db = body([]);
    expect(() => apply(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 0 });
  });
});

// ── BODY B ───────────────────────────────────────────────────────────────────

describe('BODY B — the shapes this migration exists for', () => {
  const rows: Array<[string, string | null]> = [
    ['both-corrupt', manifest(spread1('both-corrupt'), spread1('both-corrupt'))],
    ['compounded', manifest(spread2('parent-x', 'child-y'), spread2('parent-x', 'child-y'))],
    // The live PM shape: a real read allowlist, deny-all on write — only one field corrupted.
    ['write-only-corrupt', manifest(['/tmp/**'], spread1('write-only-corrupt'))],
    ['read-only-corrupt', manifest(spread1('read-only-corrupt'), ['/tmp/**'])],
    // No-ops.
    ['already-none', manifest('none', 'none')],
    ['star', manifest('*', '*')],
    ['real-allowlist', manifest(['/tmp/**', art('real-allowlist')], ['/tmp/**'])],
  ];

  it('rewrites every corrupted field to the scalar `none` and touches nothing else', () => {
    const db = body(rows);
    const before = { star: raw(db, 'star'), allow: raw(db, 'real-allowlist'), none: raw(db, 'already-none') };
    apply(db);

    // THE REPAIRED SET — the scalar, not an empty array (see the file header: `[]` would WIDEN).
    expect(field(db, 'both-corrupt', 'file_read')).toBe('none');
    expect(field(db, 'both-corrupt', 'file_write')).toBe('none');
    expect(field(db, 'compounded', 'file_read')).toBe('none');
    expect(field(db, 'compounded', 'file_write')).toBe('none');
    expect(field(db, 'write-only-corrupt', 'file_write')).toBe('none');
    expect(field(db, 'read-only-corrupt', 'file_read')).toBe('none');

    // The UNCORRUPTED half of a half-corrupted row is left exactly as it was.
    expect(field(db, 'write-only-corrupt', 'file_read')).toEqual(['/tmp/**']);
    expect(field(db, 'read-only-corrupt', 'file_write')).toEqual(['/tmp/**']);

    // The no-ops are byte-identical, not merely equivalent — `json_replace` never ran on them.
    expect(raw(db, 'star')).toBe(before.star);
    expect(raw(db, 'real-allowlist')).toBe(before.allow);
    expect(raw(db, 'already-none')).toBe(before.none);
  });

  it('the repaired value is the one the FIXED helper produces, and it round-trips', () => {
    const db = body(rows);
    apply(db);
    // Said the other way round too, because "is it the scalar" and "is it no longer an array"
    // fail for different reasons and the second is the regression.
    for (const id of ['both-corrupt', 'compounded']) {
      for (const key of ['file_read', 'file_write'] as const) {
        expect(Array.isArray(field(db, id, key)), `${id}.${key}`).toBe(false);
        // The specific garbage this defect minted, named so a partial sweep cannot pass.
        expect(field(db, id, key)).not.toEqual(expect.arrayContaining(['n', 'o', 'e']));
      }
    }
    // And the rest of the manifest survived the rewrite intact.
    const doc = JSON.parse(raw(db, 'both-corrupt') as string) as Record<string, unknown>;
    expect(doc.max_processes).toBe(5);
    expect(doc.file_delete).toBe('none');
    expect(doc.network_domains).toBe('none');
  });

  it('PER-STATEMENT ROW COUNTS — each branch touches the rows it exists for, and no more', () => {
    const db = body(rows);
    const stmts = statements();
    expect(stmts).toHaveLength(2);

    const counts = stmts.map((s) => db.prepare(s).run().changes);
    // (1) file_read: both-corrupt, compounded, read-only-corrupt.
    expect(counts[0]).toBe(3);
    // (2) file_write: both-corrupt, compounded, write-only-corrupt.
    expect(counts[1]).toBe(3);
    // Neither branch is untested — a zero here would mean the body never exercised it.
    for (const [i, n] of counts.entries()) expect(n, `statement ${i + 1}`).toBeGreaterThan(0);
  });

  it('IDEMPOTENT — a second pass touches zero rows', () => {
    const db = body(rows);
    const stmts = statements();

    const first = stmts.map((s) => db.prepare(s).run().changes);
    expect(first).toEqual([3, 3]);

    const second = stmts.map((s) => db.prepare(s).run().changes);
    expect(second).toEqual([0, 0]);

    // And the whole file applied a third time is still a no-op on the resulting state.
    const afterTwo = raw(db, 'both-corrupt');
    apply(db);
    expect(raw(db, 'both-corrupt')).toBe(afterTwo);
  });
});

// ── BODY C ───────────────────────────────────────────────────────────────────

describe('BODY C — the adversarial body a lived-in box actually carries', () => {
  const rows: Array<[string, string | null]> = [
    ['null-perms', null],
    ['empty-string', ''],
    ['empty-object', '{}'],
    ['not-json-at-all', 'this is not json, it is a sentence'],
    ['truncated-json', '{"file_read":["n","o","n"'],
    ['no-path-keys', JSON.stringify({ max_processes: 1, exec_allow: [] })],
    // An OBJECT where an array belongs.
    ['object-not-array', manifest({ nested: true }, { nested: true })],
    ['number-not-array', manifest(42, 42)],
    // ⚠ THE LEGITIMATE SINGLE-CHARACTER LISTS. These are real allowlists and MUST SURVIVE.
    ['legit-three-chars', manifest(['n', 'o', 'n'], ['a', 'b', 'c'])],
    ['legit-five-chars', manifest(['n', 'o', 'n', 'e', 'f'], ['n', 'o', 'n', 'e', 'f'])],
    ['legit-offset', manifest(['x', 'n', 'o', 'n', 'e'], ['x', 'n', 'o', 'n', 'e'])],
    // The bare four — not producible by the defect, and excluded on purpose (see the header).
    ['bare-four', manifest(['n', 'o', 'n', 'e'], ['n', 'o', 'n', 'e'])],
    // A real corrupted row IN THE SAME BODY, so the sweep is proven to still work here.
    ['corrupt-among-them', manifest(spread1('corrupt-among-them'), spread1('corrupt-among-them'))],
  ];

  it('does not raise, and does not abort the chain', () => {
    const db = body(rows);
    expect(() => apply(db)).not.toThrow();
  });

  it('leaves every malformed and legitimate row BYTE-IDENTICAL', () => {
    const db = body(rows);
    const before = new Map(rows.map(([id]) => [id, raw(db, id)]));
    apply(db);
    for (const [id] of rows) {
      if (id === 'corrupt-among-them') continue;
      expect(raw(db, id), `row ${id} must be untouched`).toBe(before.get(id) ?? null);
    }
  });

  it('⚠ THE SURVIVAL CLAUSE — a legitimate one-character allowlist is not rewritten', () => {
    const db = body(rows);
    apply(db);
    expect(field(db, 'legit-three-chars', 'file_read')).toEqual(['n', 'o', 'n']);
    expect(field(db, 'legit-three-chars', 'file_write')).toEqual(['a', 'b', 'c']);
    // Five elements, first four ARE the letters — but the fifth is not an artifact directory,
    // so this is somebody's real list and the predicate must leave it alone.
    expect(field(db, 'legit-five-chars', 'file_read')).toEqual(['n', 'o', 'n', 'e', 'f']);
    // The letters present but not at position 0.
    expect(field(db, 'legit-offset', 'file_read')).toEqual(['x', 'n', 'o', 'n', 'e']);
    // The bare four, excluded by the fifth-element requirement.
    expect(field(db, 'bare-four', 'file_read')).toEqual(['n', 'o', 'n', 'e']);
  });

  it('and still sweeps the genuinely corrupted row sitting beside them', () => {
    const db = body(rows);
    apply(db);
    expect(field(db, 'corrupt-among-them', 'file_read')).toBe('none');
    expect(field(db, 'corrupt-among-them', 'file_write')).toBe('none');
  });

  it('PER-STATEMENT ROW COUNTS on the adversarial body — exactly one row each', () => {
    const db = body(rows);
    const counts = statements().map((s) => db.prepare(s).run().changes);
    expect(counts).toEqual([1, 1]);
  });
});

// ── BODY D ───────────────────────────────────────────────────────────────────

describe('BODY D — COUNTERFACTUAL: the json_valid CASE guard is load-bearing', () => {
  /** The same statements with every `CASE WHEN json_valid(...) ... END` collapsed to the column. */
  const UNGUARDED = MIGRATION_179.replace(
    /CASE WHEN json_valid\(permissions\) THEN permissions ELSE '\{\}' END/g,
    'permissions',
  );

  it('the swap really did strip the guard (and nothing else)', () => {
    // COMMENTS STRIPPED FIRST, both ways: the file's own header discusses `json_valid` in prose,
    // so a whole-file match here would be testing the comment rather than the statements.
    const guarded = statements().join(';\n');
    const unguarded = statements(UNGUARDED).join(';\n');
    expect(guarded).toContain("CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END");
    expect(unguarded).not.toContain('json_valid');
    // Fourteen guarded call sites in the executable SQL — SEVEN per statement, which is every
    // json call it makes: json_type, json_array_length, and one json_extract per index 0..4.
    // The count is asserted so a guard dropped from a single call site cannot pass unnoticed.
    expect(guarded.match(/json_valid/g)).toHaveLength(14);
    // Same number of statements — the counterfactual differs only in the guard.
    expect(statements(UNGUARDED)).toHaveLength(statements().length);
  });

  it('RAISES on the adversarial body without it — which would abort the boot', () => {
    const db = body([
      ['not-json-at-all', 'this is not json, it is a sentence'],
      ['corrupt', manifest(spread1('corrupt'), spread1('corrupt'))],
    ]);
    expect(() => apply(db, UNGUARDED)).toThrow(/malformed JSON/i);
  });

  it('CONTROL — the guarded file applies to that very same body without raising', () => {
    const db = body([
      ['not-json-at-all', 'this is not json, it is a sentence'],
      ['corrupt', manifest(spread1('corrupt'), spread1('corrupt'))],
    ]);
    expect(() => apply(db)).not.toThrow();
    expect(field(db, 'corrupt', 'file_read')).toBe('none');
  });
});
