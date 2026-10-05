// ════════════════════════════════════════════════════════════════════════════════════════
// THE FIVE DIVERGENCES, AND THE ONE THAT HAD NO WARRANT AVAILABLE (W2-B item F).
//
// ── THE ITEM ──
// Two backlog lines: "LEAD E: MIGRATION DIVERGENCE logged at error level on every dev-box
// boot for 3 old migration files" and "migrations 165/168 carry pre-existing unadjudicated
// divergences logging at ERROR every dev boot". Five files between them — 144, 146, 135b,
// 165, 168 — and the instruction is to adjudicate or repair each BY EVIDENCE, because an
// ERROR line nobody acts on is noise that hides a real divergence.
//
// ── RE-DERIVED AT THIS HEAD: FOUR OF THE FIVE ARE ALREADY DONE ──
// `KNOWN_DIVERGENCES` carries seven entries, and 144, 146, 135b and 168 are four of them. So
// those four no longer log at ERROR; they log at info with a reason and a date. Re-measured
// here rather than trusted: every one of the seven entries' `fileChecksum` still equals the
// checksum of the file on disk today, so not one warrant has gone stale — which matters,
// because a stale entry silently stops matching and the ERROR comes back.
//
// That leaves ONE: `165_work_effort_meter.sql`, and the ledger test beside this file records
// why it is deliberately absent — its applied checksum matches no version of the file in this
// repository's history, so a hash entry would be a fabricated warrant. That refusal is right
// and it stands. 165 is still not in `KNOWN_DIVERGENCES`, and a clause below pins that.
//
// ── SO 165 GOT THE OTHER KIND OF WARRANT ──
// The question a reader of the ERROR line actually has is not "which bytes ran" — it is "is
// this database's schema the one the repo describes". 165's entire executable body is two
// `ALTER TABLE work ADD COLUMN … INTEGER NOT NULL DEFAULT 0` statements, so that question is
// fully expressible as a schema check. `EFFECT_VERIFIED` does exactly that, and the check runs
// against the live database on every boot rather than being asserted once by a human.
//
// Which makes it a STRONGER warrant than the hash entries, not a weaker one — and it cannot
// become a silencer, which is the bar the hash ledger set:
//
//   * it approves an EFFECT, not a file, so an edit that changes the effect breaks it
//   * when it fails the alarm is LOUDER and more actionable than the checksum complaint —
//     "the schema is not the one the repo describes, and here is the claim that failed",
//     rather than "two hashes differ"
//   * a verifier that throws counts as a FAILURE, so the loud direction is the safe one
//
// Both directions are driven below: the five recorded divergences produce ZERO actionable
// errors, and a NEW divergence — or 165 with its effect actually missing — still does.
//
// All migration names are real; every fabricated checksum below is obviously fictional.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import {
  auditMigrationChecksums, migrationChecksum, ensureMigrationChecksumColumn,
  KNOWN_DIVERGENCES, EFFECT_VERIFIED,
  type EffectVerification, type MigrationChecksumFinding,
} from '../migration-checksums.js';

const MIG_DIR = path.resolve(__dirname, '../migrations');
const read = (name: string): string | null => {
  const p = path.join(MIG_DIR, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
};

/** The five files the two backlog lines name. */
const THE_FIVE = [
  '144_task_runs_absorbed.sql',
  '146_task_log_absorbed.sql',
  '135b_stable_work_spine.sql',
  '165_work_effort_meter.sql',
  '168_work_tracker_default_grant.sql',
];

/** A checksum that is not any real file's — the shape of "this box applied other bytes". */
const FICTIONAL_APPLIED = 'f'.repeat(64);

/** What a reader must act on: diverged, with NEITHER a provenance warrant nor a passing
 *  effect check. This is the number the boot log calls `diverged`. */
const actionable = (findings: MigrationChecksumFinding[]): MigrationChecksumFinding[] =>
  findings.filter(f => f.kind === 'diverged' && !f.adjudicated && f.effectVerified !== true);

let db: Database.Database;

/** A body with the `work` columns 165 creates, and a `_migrations` table to populate. */
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT);
    CREATE TABLE work (
      id TEXT PRIMARY KEY,
      effort_calls INTEGER NOT NULL DEFAULT 0,
      effort_reviewed_calls INTEGER NOT NULL DEFAULT 0
    );
  `);
  ensureMigrationChecksumColumn(db);
});
afterEach(() => db.close());

const record = (name: string, checksum: string | null): void => {
  db.prepare('INSERT INTO _migrations (name, applied_at, checksum) VALUES (?, ?, ?)')
    .run(name, '2026-01-01', checksum);
};

/** Record each of the five as the dev box has it: the four hash-adjudicated ones at exactly
 *  their ledger's `appliedChecksum`, and 165 at bytes that match nothing. */
const recordTheFive = (): void => {
  for (const file of THE_FIVE) {
    const entry = KNOWN_DIVERGENCES.find(d => d.file === file);
    record(file, entry ? entry.appliedChecksum : FICTIONAL_APPLIED);
  }
};

// ── THE PREMISE, RE-MEASURED RATHER THAN TRUSTED ─────────────────────────────────────────

describe('the premise at this head', () => {
  it('four of the five are hash-adjudicated, and the fifth is 165', () => {
    const adjudicated = THE_FIVE.filter(f => KNOWN_DIVERGENCES.some(d => d.file === f));
    expect(adjudicated.sort()).toEqual([
      '135b_stable_work_spine.sql', '144_task_runs_absorbed.sql',
      '146_task_log_absorbed.sql', '168_work_tracker_default_grant.sql',
    ]);
    expect(THE_FIVE.filter(f => !adjudicated.includes(f))).toEqual(['165_work_effort_meter.sql']);
  });

  it('⚠ not one warrant has gone stale — every entry still describes the file on disk', () => {
    expect(KNOWN_DIVERGENCES.length).toBeGreaterThan(0);
    for (const d of KNOWN_DIVERGENCES) {
      const text = read(d.file);
      expect(text, `${d.file} is named in the ledger and gone from the tree`).not.toBeNull();
      expect(migrationChecksum(text!), `${d.file}'s warrant no longer matches the file`)
        .toBe(d.fileChecksum);
    }
  });

  it('165 is STILL not hash-adjudicated — the ledger test’s refusal stands', () => {
    expect(KNOWN_DIVERGENCES.map(d => d.file)).not.toContain('165_work_effort_meter.sql');
    // It carries the other kind of warrant instead, and that warrant states its own reason.
    const e = EFFECT_VERIFIED.find(x => x.file === '165_work_effort_meter.sql');
    expect(e).toBeDefined();
    expect(e!.whyNotHashed.length, 'an effect entry with no stated reason is a silencer')
      .toBeGreaterThan(120);
    expect(e!.effect.length).toBeGreaterThan(40);
    expect(e!.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── DIRECTION 1: THE FIVE RECORDED DIVERGENCES PRODUCE ZERO ACTIONABLE ERRORS ────────────

describe('⚠ a body carrying the five recorded divergences has nothing left to act on', () => {
  it('all five are findings, and NONE of them is actionable', () => {
    recordTheFive();

    const audit = auditMigrationChecksums(db, read);

    expect(audit.findings.map(f => f.file).sort()).toEqual([...THE_FIVE].sort());
    expect(actionable(audit.findings)).toEqual([]);
    // Four by provenance, one by effect — and the counts say which is which.
    expect(audit.adjudicated).toBe(4);
    expect(audit.effectConfirmed).toBe(1);
  });

  it('a verified migration is not a finding at all, which keeps the count honest', () => {
    const text = read('171_report_read_indexes.sql')!;
    record('171_report_read_indexes.sql', migrationChecksum(text));

    const audit = auditMigrationChecksums(db, read);

    expect(audit.verified).toBe(1);
    expect(audit.findings).toEqual([]);
  });
});

// ── DIRECTION 2: A NEW DIVERGENCE IS STILL LOUD ──────────────────────────────────────────

describe('⚠ the alarm still fires on anything that has not been examined', () => {
  it('a NEW divergence on a file with neither warrant is actionable', () => {
    recordTheFive();
    // A real file, recorded at bytes nobody has examined — the next 139 incident's shape.
    record('172_orphaned_work_rows.sql', FICTIONAL_APPLIED);

    const audit = auditMigrationChecksums(db, read);

    const loud = actionable(audit.findings);
    expect(loud.map(f => f.file)).toEqual(['172_orphaned_work_rows.sql']);
    expect(loud[0].adjudicated).toBeUndefined();
    expect(loud[0].effectVerified).toBeUndefined();
  });

  it('⚠ 165 with its effect MISSING is actionable again — the check is not a rubber stamp', () => {
    db.exec('DROP TABLE work; CREATE TABLE work (id TEXT PRIMARY KEY)');
    recordTheFive();

    const audit = auditMigrationChecksums(db, read);

    const loud = actionable(audit.findings);
    expect(loud.map(f => f.file)).toEqual(['165_work_effort_meter.sql']);
    // And it is the EFFECT arm, not the generic one — the log line names what failed.
    expect(loud[0].effectVerified).toBe(false);
    expect(loud[0].effect!.file).toBe('165_work_effort_meter.sql');
    expect(audit.effectConfirmed).toBe(0);
  });

  it('a hash entry cannot pre-approve a SECOND edit of the same file', () => {
    // The triple, not the file: record the right applied hash but pretend the file moved on.
    const d = KNOWN_DIVERGENCES.find(x => x.file === '144_task_runs_absorbed.sql')!;
    record(d.file, d.appliedChecksum);
    const audit = auditMigrationChecksums(db, read, [{ ...d, fileChecksum: 'a'.repeat(64) }]);
    expect(actionable(audit.findings).map(f => f.file)).toEqual([d.file]);
  });
});

// ── THE EFFECT CHECK ITSELF: STRICT, AND LOUD WHEN IT CANNOT TELL ────────────────────────

describe('the effect check is strict on every attribute it claims', () => {
  const verify = (): boolean =>
    EFFECT_VERIFIED.find(e => e.file === '165_work_effort_meter.sql')!.verify(db);

  it('passes on the shape 165 actually produces', () => {
    expect(verify()).toBe(true);
  });

  it.each([
    ['a missing column', 'CREATE TABLE work (id TEXT PRIMARY KEY, effort_calls INTEGER NOT NULL DEFAULT 0)'],
    ['the wrong type', 'CREATE TABLE work (id TEXT, effort_calls TEXT NOT NULL DEFAULT 0, effort_reviewed_calls INTEGER NOT NULL DEFAULT 0)'],
    ['a nullable column', 'CREATE TABLE work (id TEXT, effort_calls INTEGER DEFAULT 0, effort_reviewed_calls INTEGER NOT NULL DEFAULT 0)'],
    ['the wrong default', 'CREATE TABLE work (id TEXT, effort_calls INTEGER NOT NULL DEFAULT 7, effort_reviewed_calls INTEGER NOT NULL DEFAULT 0)'],
    ['no `work` table at all', 'CREATE TABLE unrelated (id TEXT)'],
  ])('⚠ fails on %s', (_label, ddl) => {
    db.exec('DROP TABLE work');
    db.exec(ddl);
    expect(verify()).toBe(false);
  });

  it('⚠ a verifier that THROWS counts as a failure, never as a pass', () => {
    const exploding: EffectVerification = {
      file: '165_work_effort_meter.sql',
      since: '2026-10-05',
      effect: 'a claim that cannot be evaluated',
      whyNotHashed: 'a fictional entry used only to prove the loud direction is the safe one',
      verify: () => { throw new Error('the schema could not be read'); },
    };
    recordTheFive();

    // The audit must not propagate the throw, and must not count it as confirmed.
    const audit = auditMigrationChecksums(db, read, KNOWN_DIVERGENCES, [exploding]);

    const loud = actionable(audit.findings);
    expect(loud.map(f => f.file)).toEqual(['165_work_effort_meter.sql']);
    expect(audit.effectConfirmed).toBe(0);
  });
});

// ── THE TIERS STAY DISTINCT ──────────────────────────────────────────────────────────────

describe('the report tier — three arms, and only the unexamined ones are loud', () => {
  // A source census for the same reason the sibling file gives: the module binds its logger
  // at import, so a clause that mocked it would be asserting on the mock.
  const src = fs.readFileSync(path.resolve(__dirname, '../migration-checksums.ts'), 'utf-8');
  const body = /export function reportMigrationChecksums[\s\S]*?\n}/.exec(src)![0];

  it('the EFFECT-VERIFIED arm exists, is separate, and is quiet', () => {
    const arm = /f\.effectVerified === true[\s\S]*?else if/.exec(body)?.[0] ?? '';
    expect(arm, 'the effect-verified arm must exist and be its own branch').not.toBe('');
    expect(arm).toMatch(/logger\.info/);
    expect(arm).not.toMatch(/logger\.error/);
  });

  it('the EFFECT-FAILED arm exists, is separate, and is loud', () => {
    const arm = /f\.effectVerified === false[\s\S]*?else if/.exec(body)?.[0] ?? '';
    expect(arm, 'a failing effect check must have its own branch').not.toBe('');
    expect(arm).toMatch(/logger\.error/);
    expect(arm).toMatch(/MIGRATION EFFECT CHECK FAILED/);
  });

  it('the summary line’s `diverged` count excludes BOTH kinds of examined finding', () => {
    const summary = /logger\.info\('Migration checksum audit'[\s\S]*?\}\);/.exec(body)?.[0] ?? '';
    expect(summary).not.toBe('');
    expect(summary).toMatch(/!f\.adjudicated/);
    expect(summary).toMatch(/effectVerified !== true/);
    expect(summary).toMatch(/divergedEffectVerified/);
  });
});
