// ════════════════════════════════════════════════════════════════════════════
// MIGRATION 154 (`grant_rule` gains `proc` / `applescript`) — THE REHEARSAL
// BODIES AS A TEST, INCLUDING THE ONE EVERY REAL BOX WILL BE.
//
// `153`'s rehearsal caught a `CREATE TABLE IF NOT EXISTS` that was a no-op
// against a loose table. `154` faces the SAME hazard from a different angle and
// it is worse, because this time the pre-existing table is not a hypothetical: a
// box that upgraded through `153` has a `grant_rule` with the SEVEN-kind CHECK,
// so an `IF NOT EXISTS` here would either abort the chain on the duplicate index
// or silently leave the old CHECK — and the first `INSERT … effect_kind='proc'`
// (the first tool call any agent makes after the upgrade) would throw inside
// `authorize()`. BODY D drives that counterfactual so it is a measurement.
//
// The last clause is the capability one, and it is why this file is not only
// about DDL: `exec_allow` must project to BOTH `proc` and `shell` rows. Before
// PHASE-5 T3 there was one exec door and it WAS a shell, so an agent's
// `exec_allow` has always been its shell reach. Projecting it to `proc` alone
// would delete a capability every agent on every box has today.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { projectManifestToRules } from '../../agent/brokers/grants.js';
import type { PermissionManifest } from '@dojo/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_153 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '153_grant_rule.sql'), 'utf-8');
const MIGRATION_154 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '154_grant_rule_exec_doors.sql'), 'utf-8');

/** Apply the way `db/migrations.ts` applies: one `exec`, one transaction, FKs off. */
function apply(db: Database.Database, sql: string): void {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => db.exec(sql))();
  db.pragma('foreign_keys = ON');
}

function bodyControl(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY, permissions TEXT);');
  // One agent even in the "empty" body: every probe below inserts a grant row,
  // and the table's FK means an orphan probe would fail with a FOREIGN KEY error
  // instead of the CHECK / UNIQUE error the clause is actually about.
  db.prepare('INSERT INTO agents (id, permissions) VALUES (?, ?)').run('primary', '{}');
  return db;
}

function bodyWornIn(): Database.Database {
  const db = bodyControl();
  const insert = db.prepare('INSERT INTO agents (id, permissions) VALUES (?, ?)');
  insert.run('worker-primary', '{"file_read":"*","file_write":"*","exec_allow":["*"]}');
  for (let i = 0; i < 20; i++) {
    insert.run(`worker-${i}`, i % 3 === 0 ? '{}' : '{"exec_allow":["ls","git *"]}');
  }
  return db;
}

/** BODY C: a LOOSE `grant_rule` — no CHECKs, no NOT NULLs, no unique index —
 *  carrying duplicates, a NULL-everything row, orphans, and a stale escalation
 *  row bearing a T2-era fingerprint. */
function bodyAdversarial(): Database.Database {
  const db = bodyWornIn();
  db.exec(`
    CREATE TABLE grant_rule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT, effect_kind TEXT, mode TEXT, pattern TEXT,
      source TEXT DEFAULT 'manifest', manifest_fingerprint TEXT, created_at TEXT
    );
    INSERT INTO grant_rule (agent_id, effect_kind, mode, pattern, manifest_fingerprint) VALUES
      ('primary','shell','allow','*','deadbeef'),
      ('primary','shell','allow','*','deadbeef'),
      ('primary','shell','allow','*','deadbeef'),
      (NULL, NULL, NULL, NULL, NULL),
      ('ghost-1','fs_read','allow','/tmp/**','cafe'),
      ('ghost-2','fs_read','allow','/tmp/**','cafe'),
      ('worker-1','shell','allow','*','stale-escalation');
  `);
  return db;
}

/** BODY D: what every upgraded box actually is — `153` already applied. */
function body153Applied(): Database.Database {
  const db = bodyWornIn();
  apply(db, MIGRATION_153);
  return db;
}

function schemaOf(db: Database.Database): string {
  return (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'grant_rule'`).get() as { sql: string }).sql;
}

const NEW_KINDS = ['proc', 'shell', 'applescript'] as const;
const CARRIED_KINDS = ['fs_read', 'fs_write', 'fs_delete', 'net', 'spawn', 'system_control'] as const;

describe('migration 154 — the exec doors reach the grant rows', () => {
  const bodies: Array<[string, () => Database.Database]> = [
    ['BODY B — control (empty)', bodyControl],
    ['BODY A — worn-in', bodyWornIn],
    ['BODY C — adversarial (LOOSE table, 7 planted rows)', bodyAdversarial],
    ['BODY D — a 153-shaped body, i.e. every real upgraded box', body153Applied],
  ];

  for (const [label, make] of bodies) {
    it(`${label}: applies, starts EMPTY, and carries both indexes`, () => {
      const db = make();
      expect(() => apply(db, MIGRATION_154)).not.toThrow();
      expect((db.prepare('SELECT COUNT(*) AS n FROM grant_rule').get() as { n: number }).n).toBe(0);
      const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='grant_rule' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>;
      expect(indexes.map((i) => i.name).sort()).toEqual(['grant_rule_lookup', 'grant_rule_unique']);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      db.close();
    });

    it(`${label}: the widened CHECK accepts all nine kinds and refuses anything else`, () => {
      const db = make();
      apply(db, MIGRATION_154);
      const insert = db.prepare(`INSERT INTO grant_rule (agent_id, effect_kind, mode, pattern, manifest_fingerprint) VALUES ('primary', ?, 'allow', '*', 'f')`);
      for (const kind of [...NEW_KINDS, ...CARRIED_KINDS]) {
        expect(() => insert.run(kind), `${kind} must be a legal effect_kind`).not.toThrow();
      }
      for (const bogus of ['exec', 'applescript_run', 'SHELL', '', 'fs']) {
        expect(() => insert.run(bogus), `${bogus} must be refused by the CHECK`).toThrow(/CHECK constraint/);
      }
      db.close();
    });

    it(`${label}: a duplicated rule is still unrepresentable`, () => {
      const db = make();
      apply(db, MIGRATION_154);
      const insert = db.prepare(`INSERT INTO grant_rule (agent_id, effect_kind, mode, pattern, manifest_fingerprint) VALUES ('primary', 'proc', 'allow', '*', 'f')`);
      insert.run();
      expect(() => insert.run()).toThrow(/UNIQUE/);
      db.close();
    });
  }

  // ── THE COUNTERFACTUAL, DRIVEN ──
  it('BODY D + `CREATE TABLE IF NOT EXISTS` = the incident: the chain aborts, or the old CHECK survives', () => {
    // (a) verbatim IF-NOT-EXISTS rewrite → the duplicate index aborts the file,
    //     and on a real box an aborting migration aborts the chain and the BOOT.
    const naive = MIGRATION_154
      .replace('DROP TABLE IF EXISTS grant_rule;', '')
      .replace('CREATE TABLE grant_rule (', 'CREATE TABLE IF NOT EXISTS grant_rule (');
    const dbA = body153Applied();
    expect(() => apply(dbA, naive)).toThrow(/already exists/);
    dbA.close();

    // (b) and dodging THAT with `IF NOT EXISTS` on the indexes too is worse,
    //     because it succeeds: the CREATE is a no-op, the seven-kind CHECK
    //     survives, and the FIRST authorize after the upgrade throws.
    const naiveQuiet = naive.replace(/CREATE (UNIQUE )?INDEX /g, (m) => `${m.trim()} IF NOT EXISTS `);
    const dbB = body153Applied();
    expect(() => apply(dbB, naiveQuiet)).not.toThrow();
    expect(schemaOf(dbB)).not.toMatch(/'proc'/);
    expect(() =>
      dbB.prepare(`INSERT INTO grant_rule (agent_id, effect_kind, mode, pattern, manifest_fingerprint) VALUES ('primary','proc','allow','*','f')`).run(),
    ).toThrow(/CHECK constraint/);
    dbB.close();

    // (c) the file as written: applies, and `proc` is legal.
    const dbC = body153Applied();
    apply(dbC, MIGRATION_154);
    expect(schemaOf(dbC)).toMatch(/'proc'/);
    dbC.close();
  });

  // ── THE CAPABILITY CLAUSE ──
  it('`exec_allow` projects to BOTH doors, so splitting exec costs no agent its reach', () => {
    const manifest = {
      file_read: '*', file_write: '*', file_delete: 'none',
      exec_allow: ['ls', 'git *'], exec_deny: ['git push *'],
      network_domains: 'none', max_processes: 3,
      can_spawn_agents: false, can_assign_permissions: false, system_control: [],
    } as unknown as PermissionManifest;
    const rules = projectManifestToRules(manifest);
    const of = (kind: string, mode: string) =>
      rules.filter((r) => r.effectKind === kind && r.mode === mode).map((r) => r.pattern).sort();

    expect(of('proc', 'allow')).toEqual(['git *', 'ls']);
    expect(of('shell', 'allow')).toEqual(['git *', 'ls']);
    expect(of('proc', 'deny')).toEqual(['git push *']);
    expect(of('shell', 'deny')).toEqual(['git push *']);
  });

  it('an EXPLICIT `shell_allow` replaces the shell side — that is how the class is withheld', () => {
    const withheld = {
      file_read: '*', file_write: 'none', file_delete: 'none',
      exec_allow: ['ls', 'git *'], exec_deny: [], shell_allow: [], shell_deny: [],
      network_domains: 'none', max_processes: 1,
      can_spawn_agents: false, can_assign_permissions: false, system_control: [],
    } as unknown as PermissionManifest;
    const rules = projectManifestToRules(withheld);
    expect(rules.filter((r) => r.effectKind === 'proc' && r.mode === 'allow')).toHaveLength(2);
    expect(rules.filter((r) => r.effectKind === 'shell')).toHaveLength(0);
  });

  it('`applescript` rows come from `system_control`: `*` covers it, a LIST must name it', () => {
    const base = {
      file_read: '*', file_write: '*', file_delete: 'none', exec_allow: [], exec_deny: [],
      network_domains: 'none', max_processes: 1,
      can_spawn_agents: false, can_assign_permissions: false,
    };
    const kindsFor = (system_control: unknown) =>
      projectManifestToRules({ ...base, system_control } as unknown as PermissionManifest)
        .filter((r) => r.effectKind === 'applescript').length;

    // ⚠ FLIPPED BY PHASE-5 T5, DELIBERATELY AND VISIBLY. At T3 these two read
    // `.toBe(1)`: `'*'` still covered AppleScript, because narrowing a wildcard
    // manifest was a capability loss T3 had no licence to take. T5 took it the
    // preserving way — every `'*'` holder gained an EXPLICIT `'applescript'`
    // grant first (`PRIMARY_AGENT_PERMISSIONS` in code, migration 155 in the
    // stored rows), and only then did the blanket stop meaning it. The clause
    // that proves nothing was lost lives in
    // `brokers/__tests__/applescript-grant.test.ts`; this one records that the
    // blanket's meaning changed on purpose.
    expect(kindsFor('*')).toBe(0);
    expect(kindsFor(['*'])).toBe(0);
    expect(kindsFor(['*', 'applescript'])).toBe(1);
    expect(kindsFor(['applescript'])).toBe(1);
    expect(kindsFor(['applescript_run'])).toBe(1);
    // A list that does NOT name it grants no AppleScript — which is exactly what
    // the ladder's category compare already required, so nothing live moves.
    expect(kindsFor(['mouse', 'keyboard', 'screen'])).toBe(0);
    expect(kindsFor([])).toBe(0);
  });
});
