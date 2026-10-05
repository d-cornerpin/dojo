// ════════════════════════════════════════════════════════════════════════════════════════
// THE FIVE DIVERGENCES: WHAT IS DONE, AND WHY THE LAST ONE CANNOT BE DONE HERE (W2-B item F).
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
// those four no longer log at ERROR; they log at info with a reason and a date. That half of
// the item landed before this lane opened, and the clauses below hold it landed.
//
// ── WHAT THIS FILE ADDS: THE STALENESS CHECK NOBODY WAS RUNNING ──
// A warrant is bound to a PAIR of hashes, so it stops matching the moment the file moves —
// and when it stops matching, the ERROR comes back silently. The sibling ledger test checks
// each entry against the file on disk, which catches an edit. This file asks the question
// the other way round and makes it a census: EVERY entry, re-measured, with non-vacuity —
// so an entry that is dropped, or a ledger that is emptied, fails here too.
//
// Measured at this head: all seven warrants are live, not one has gone stale.
//
// ── THE FIFTH: 165, AND WHY NO WARRANT IS AVAILABLE FOR IT ──
// `165_work_effort_meter.sql` is deliberately absent from the ledger, and the sibling test
// pins that absence: its applied checksum matches no version of the file in this repository's
// history, so a hash entry would be a fabricated warrant. Re-derived here, and the clause
// below is the load-bearing fact — THE FILE HAS EXACTLY ONE COMMIT IN THE ENTIRE HISTORY of
// this repository. There is no second version to diff against, so the bytes that ran were an
// uncommitted working-tree draft that exists nowhere: the same shape as the `139` incident
// `migration-checksums.ts` was written for. The refusal is correct and it stands.
//
// ── WHAT IS HANDED UP, AND WHY IT IS NOT HERE ──
// The disposition 165 wants is a SECOND KIND of warrant: adjudication by EFFECT. 165's whole
// executable body is two `ALTER TABLE work ADD COLUMN … INTEGER NOT NULL DEFAULT 0`
// statements, so the question a reader of the ERROR line actually has — "is this database's
// schema the one the repo describes" — is fully expressible as a schema check run against the
// live database on every boot. That is a STRONGER warrant than a hash argument, and it cannot
// become a silencer: it approves an effect rather than a file, and when it fails it is louder
// and more actionable than the checksum complaint it replaces.
//
// It was built and proven on this branch and then REVERTED, because it cannot land green:
//
//   * the mechanism is ~+50 lines in `migration-checksums.ts`, and it cannot be moved out of
//     that file. THREE gates pin its contents there: `check-migration-freeze.mjs` parses
//     `migrationChecksum` out of it by name and self-checks that it found it; the SQL-prepares
//     gate declares it a runtime-DDL source and fails if it yields zero DDL statements; and
//     the freeze gate also parses `KNOWN_DIVERGENCES` out of it. Each of those was measured by
//     moving the thing and watching the gate refuse — which is the gates working.
//   * its growth baseline is STALE and that is the actual blocker: `growth-baseline.json`
//     records 277 lines on 2026-09-22, main already ships 317 (+14.4%), so the +25% rule
//     leaves 29 lines of headroom for ANY lane that touches this file. The gate's own remedy
//     is to re-record the baseline in a gate-side commit — and that file is in the diffs of
//     two live lanes, so this lane may not write it.
//
// Paying for the mechanism out of the file's existing prose would be comment-stripping to beat
// a pin, which the house rules forbid. So the honest outcome is this file plus a hand-up.
//
// All migration names are real; the one fabricated checksum below is obviously fictional.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  auditMigrationChecksums, migrationChecksum, ensureMigrationChecksumColumn,
  KNOWN_DIVERGENCES,
} from '../migration-checksums.js';
import Database from 'better-sqlite3';

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

const THE_FOUR_ADJUDICATED = [
  '135b_stable_work_spine.sql',
  '144_task_runs_absorbed.sql',
  '146_task_log_absorbed.sql',
  '168_work_tracker_default_grant.sql',
];

/** A checksum that is no real file's — the shape of "this box applied other bytes". */
const FICTIONAL_APPLIED = 'f'.repeat(64);

// ── THE PREMISE, RE-MEASURED RATHER THAN TRUSTED ─────────────────────────────────────────

describe('the premise at this head', () => {
  it('four of the five carry a warrant, and the fifth is 165', () => {
    const adjudicated = THE_FIVE.filter(f => KNOWN_DIVERGENCES.some(d => d.file === f));
    expect(adjudicated.sort()).toEqual(THE_FOUR_ADJUDICATED);
    expect(THE_FIVE.filter(f => !adjudicated.includes(f))).toEqual(['165_work_effort_meter.sql']);
  });

  it('⚠ not ONE warrant has gone stale — every entry still describes its file on disk', () => {
    // Non-vacuity first: an emptied or truncated ledger would pass the loop below trivially,
    // and an emptied ledger is exactly how every divergence goes quiet at once.
    expect(KNOWN_DIVERGENCES.length).toBeGreaterThanOrEqual(THE_FOUR_ADJUDICATED.length);
    for (const d of KNOWN_DIVERGENCES) {
      const text = read(d.file);
      expect(text, `${d.file} is named in the ledger and gone from the tree`).not.toBeNull();
      expect(migrationChecksum(text!), `${d.file}'s warrant no longer matches the file — the `
        + 'ERROR line is back on every boot of every box this entry covered').toBe(d.fileChecksum);
      // A warrant with no argument is a silencer, whatever its hashes say.
      expect(d.reason.length, `${d.file}'s entry states no reason`).toBeGreaterThan(80);
      expect(d.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

// ── WHY 165 CANNOT BE ADJUDICATED BY PROVENANCE ──────────────────────────────────────────

describe('165 — the load-bearing fact behind the ledger’s refusal', () => {
  it('⚠ has exactly ONE commit in this repository’s entire history, so there is nothing to diff', () => {
    const out = execFileSync('git', [
      'log', '--all', '--format=%H', '--', 'packages/server/src/db/migrations/165_work_effort_meter.sql',
    ], { cwd: path.resolve(__dirname, '../../../../..'), encoding: 'utf-8' }).trim();
    const commits = out ? out.split('\n') : [];
    expect(commits.length,
      'if 165 ever gains a second commit, a HASH warrant becomes possible and the hand-up in '
      + 'this file\'s header should be revisited').toBe(1);
  });

  it('is STILL not in the ledger — a log line is not a reason to fabricate a warrant', () => {
    expect(KNOWN_DIVERGENCES.map(d => d.file)).not.toContain('165_work_effort_meter.sql');
  });

  it('its whole executable body is two ALTER TABLE statements — which is what makes an '
    + 'EFFECT check a complete answer, and is the hand-up', () => {
    const body = read('165_work_effort_meter.sql')!
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('--'));
    expect(body).toEqual([
      'ALTER TABLE work ADD COLUMN effort_calls INTEGER NOT NULL DEFAULT 0;',
      'ALTER TABLE work ADD COLUMN effort_reviewed_calls INTEGER NOT NULL DEFAULT 0;',
    ]);
  });
});

// ── THE DETECTOR STILL BEHAVES: BOTH DIRECTIONS ──────────────────────────────────────────

describe('the detector, driven on a fixture body', () => {
  const freshDb = (): Database.Database => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT)');
    ensureMigrationChecksumColumn(db);
    return db;
  };
  const record = (db: Database.Database, name: string, checksum: string | null): void => {
    db.prepare('INSERT INTO _migrations (name, applied_at, checksum) VALUES (?, ?, ?)')
      .run(name, '2026-01-01', checksum);
  };

  it('⚠ the four warranted divergences are findings, and every one is ADJUDICATED', () => {
    const db = freshDb();
    try {
      for (const file of THE_FOUR_ADJUDICATED) {
        record(db, file, KNOWN_DIVERGENCES.find(d => d.file === file)!.appliedChecksum);
      }
      const audit = auditMigrationChecksums(db, read);
      expect(audit.findings.map(f => f.file).sort()).toEqual(THE_FOUR_ADJUDICATED);
      expect(audit.adjudicated).toBe(4);
      expect(audit.findings.filter(f => !f.adjudicated)).toEqual([]);
    } finally { db.close(); }
  });

  it('⚠ 165 is still LOUD — no warrant, so it is a finding a reader must act on', () => {
    const db = freshDb();
    try {
      record(db, '165_work_effort_meter.sql', FICTIONAL_APPLIED);
      const audit = auditMigrationChecksums(db, read);
      expect(audit.findings).toHaveLength(1);
      expect(audit.findings[0].adjudicated).toBeUndefined();
      expect(audit.findings[0].kind).toBe('diverged');
      // This is the ERROR line the item is about, and it is still there — stated plainly
      // rather than quietly made to pass.
      expect(audit.adjudicated).toBe(0);
    } finally { db.close(); }
  });

  it('a warrant is bound to the PAIR — it cannot pre-approve a second edit of the same file', () => {
    const db = freshDb();
    try {
      const d = KNOWN_DIVERGENCES.find(x => x.file === '144_task_runs_absorbed.sql')!;
      record(db, d.file, d.appliedChecksum);
      // Same file, same applied bytes, but the tree has moved on since it was examined.
      const audit = auditMigrationChecksums(db, read, [{ ...d, fileChecksum: 'a'.repeat(64) }]);
      expect(audit.findings.map(f => f.file)).toEqual([d.file]);
      expect(audit.findings[0].adjudicated).toBeUndefined();
    } finally { db.close(); }
  });

  it('a verified migration is not a finding at all, which keeps the count honest', () => {
    const db = freshDb();
    try {
      const name = '171_report_read_indexes.sql';
      record(db, name, migrationChecksum(read(name)!));
      const audit = auditMigrationChecksums(db, read);
      expect(audit.verified).toBe(1);
      expect(audit.findings).toEqual([]);
    } finally { db.close(); }
  });
});
