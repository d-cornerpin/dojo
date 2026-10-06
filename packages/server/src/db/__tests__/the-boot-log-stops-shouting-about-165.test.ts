// ════════════════════════════════════════════════════════════════════════════════════════
// THE BOOT LOG ITSELF, DRIVEN — BOTH DIRECTIONS (t112, 2026-10-05).
//
// ── WHAT THIS ADDS THAT THE SIBLING FILES DO NOT ──
// `a-divergence-nobody-acts-on-hides-a-real-one.test.ts` proves the AUDIT: which findings
// come back, which are adjudicated, which carry a passing effect check. Its report-tier
// clauses are a SOURCE CENSUS, and its own comment says why — the module binds its logger at
// import, so a clause that mocked it would be "asserting on the mock".
//
// That is right about a mock you hand the function. It is not right about mocking the LOGGER
// MODULE: `vi.mock` is hoisted above the import, so `createLogger('migrations')` returns the
// recorder and the thing under test is the real `reportMigrationChecksums` deciding, on real
// findings, WHICH LEVEL to speak at. That decision is the entire user-visible subject of the
// backlog line — *"MIGRATION DIVERGENCE logged at error level on every dev-box boot"* — and a
// source census cannot answer "is the boot log clean on the body the dev box actually has".
// Both ways are worth having and neither replaces the other: the census catches an arm that
// is deleted or reworded, this catches an arm that is never reached.
//
// ── THE THREE DIRECTIONS ──
//   1. THE RECORDED BODY       five known divergences, 165's columns present
//                              => ZERO error lines, and `diverged: 0` in the summary.
//   2. A NEW DIVERGENCE        a sixth file nobody has examined
//                              => exactly one MIGRATION DIVERGENCE error. The quiet in (1) is
//                                 the mechanism working, not the alarm being disconnected.
//   3. 165 WITH ITS EFFECT GONE  the same recorded body, columns dropped
//                              => a MIGRATION EFFECT CHECK FAILED error. The effect warrant
//                                 is a check, not a rubber stamp.
//
// All migration names are real; every fabricated checksum is obviously fictional.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/** Every line the reporter spoke, with the level it chose. */
const spoken: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> = [];

vi.mock('../../logger.js', () => {
  const at = (level: string) => (msg: string, meta?: Record<string, unknown>) => {
    spoken.push({ level, msg, meta });
  };
  return {
    createLogger: () => ({ debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }),
    setLogLevel: (): void => {}, setLogBroadcast: (): void => {}, readLogEntries: () => [],
  };
});

import {
  reportMigrationChecksums, ensureMigrationChecksumColumn, KNOWN_DIVERGENCES, EFFECT_VERIFIED,
} from '../migration-checksums.js';

const MIG_DIR = path.resolve(__dirname, '../migrations');
const read = (name: string): string | null => {
  const p = path.join(MIG_DIR, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
};

/** A checksum that is no real file's — the shape of "this box applied other bytes". */
const FICTIONAL_APPLIED = 'f'.repeat(64);

let db: Database.Database;

beforeEach(() => {
  spoken.length = 0;
  db = new Database(':memory:');
  // The dev box's shape: 165's two columns PRESENT, because 165 did run — that is exactly
  // why its divergence is unactionable and why the ERROR line was noise.
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

/** The body a dev box carries: each hash-adjudicated file at exactly its ledger's
 *  `appliedChecksum`, and 165 at bytes that match nothing. */
const recordTheRecordedDivergences = (): void => {
  for (const d of KNOWN_DIVERGENCES) record(d.file, d.appliedChecksum);
  record('165_work_effort_meter.sql', FICTIONAL_APPLIED);
};

const errors = (): typeof spoken => spoken.filter(l => l.level === 'error');
const summary = (): Record<string, unknown> =>
  (spoken.find(l => l.msg === 'Migration checksum audit')?.meta ?? {}) as Record<string, unknown>;

describe('1. the body the dev box actually has', () => {
  it('⚠ speaks NOT ONE error line — the ERROR-every-boot line is gone', () => {
    recordTheRecordedDivergences();
    reportMigrationChecksums(db, read);
    expect(errors().map(l => `${l.msg} ${JSON.stringify(l.meta)}`), 'every one of these is a line the owner sees on every boot').toEqual([]);
  });

  it('⚠ and the summary agrees: `diverged` is 0, with both kinds of examination counted', () => {
    recordTheRecordedDivergences();
    reportMigrationChecksums(db, read);
    const s = summary();
    expect(s.diverged, 'the count a reader is told to act on').toBe(0);
    expect(s.divergedExamined, 'the hash-adjudicated ones').toBe(KNOWN_DIVERGENCES.length);
    expect(s.divergedEffectVerified, '165, by effect').toBe(1);
  });

  it('165 is still SAID, at info, naming the effect that was checked — quiet is not silent', () => {
    recordTheRecordedDivergences();
    reportMigrationChecksums(db, read);
    const line = spoken.find(l => l.level === 'info' && l.meta?.file === '165_work_effort_meter.sql');
    expect(line, 'a fact that stops being an alarm must not stop being a fact').toBeTruthy();
  });

  it('the fixture is not vacuous: every recorded divergence IS a finding', () => {
    recordTheRecordedDivergences();
    const audit = reportMigrationChecksums(db, read);
    expect(audit?.findings.length).toBe(KNOWN_DIVERGENCES.length + 1);
  });
});

describe('2. a NEW divergence nobody has examined', () => {
  it('⚠ is still ONE loud error line — the alarm is not disconnected', () => {
    recordTheRecordedDivergences();
    // A real file with no warrant of either kind, recorded as having applied other bytes.
    const unexamined = fs.readdirSync(MIG_DIR)
      .filter(n => n.endsWith('.sql'))
      .find(n => !KNOWN_DIVERGENCES.some(d => d.file === n)
        && !EFFECT_VERIFIED.some(e => e.file === n))!;
    expect(unexamined, 'a migration with neither warrant must exist for this to mean anything').toBeTruthy();
    record(unexamined, FICTIONAL_APPLIED);
    reportMigrationChecksums(db, read);
    const loud = errors();
    expect(loud.length, loud.map(l => l.msg).join(' | ')).toBe(1);
    expect(loud[0].msg).toMatch(/^MIGRATION DIVERGENCE:/);
    expect(loud[0].meta?.file).toBe(unexamined);
    expect(summary().diverged).toBe(1);
  });
});

describe('3. 165 with its effect MISSING', () => {
  it('⚠ is loud again, and says the SCHEMA is wrong rather than that two hashes differ', () => {
    db.exec('DROP TABLE work; CREATE TABLE work (id TEXT PRIMARY KEY)');
    recordTheRecordedDivergences();
    reportMigrationChecksums(db, read);
    const loud = errors();
    expect(loud.length, loud.map(l => l.msg).join(' | ')).toBe(1);
    expect(loud[0].msg).toMatch(/^MIGRATION EFFECT CHECK FAILED:/);
    expect(loud[0].meta?.file).toBe('165_work_effort_meter.sql');
    // The whole point of the second warrant: the complaint is about the schema.
    expect(loud[0].msg).toMatch(/schema is not the one the repo describes/);
    expect(summary().diverged).toBe(1);
    expect(summary().divergedEffectVerified).toBe(0);
  });
});
