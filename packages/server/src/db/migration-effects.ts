// ── THE EFFECT LEDGER: DIVERGENCES ADJUDICATED BY WHAT THE FILE DID (W2-B item F) ─────────
//
// `migration-checksums.ts` is the detector — it compares what a database recorded against
// what the file says now. This file is one of the two LEDGERS it consults, and it is here
// rather than there because the data and its predicates are a different kind of thing from
// the comparison, and that module sits at its size pin for a reason.
//
// Read `EffectVerification` below for why a second kind of warrant exists at all, and why it
// cannot be used to quiet a divergence that matters.

import type { getDb } from './connection.js';

type Db = ReturnType<typeof getDb>;

/**
 * A divergence adjudicated by CHECKING WHAT THE FILE DID, for the class where the applied
 * bytes cannot be traced and a hash warrant would therefore be a fabrication.
 *
 * ── WHY A SECOND MECHANISM EXISTS AT ALL (W2-B item F) ──
 * `KNOWN_DIVERGENCES` adjudicates by PROVENANCE: it names the two hashes and argues the
 * delta between them was harmless. That warrant is only available when both versions of the
 * file can be found. `165_work_effort_meter.sql` has exactly ONE commit in this repository's
 * entire history and the dev box's recorded checksum matches it and no other, so the bytes
 * that ran were a pre-commit working-tree draft that exists nowhere — the same shape as the
 * `139` incident the detector was written for. There is nothing to diff, so
 * `db/__tests__/migration-checksums.test.ts`'s ledger clause is RIGHT to refuse a hash entry
 * for this file, and that refusal stands — 165 is not in `KNOWN_DIVERGENCES` and a clause in
 * `db/__tests__/a-divergence-nobody-acts-on-hides-a-real-one.test.ts` pins that it stays out.
 *
 * But the question a reader of the ERROR line actually has is not "which bytes ran"; it is
 * "is this database's schema the one the repo describes". For a file whose entire executable
 * body is expressible as a statement ABOUT THE SCHEMA, that question can be answered
 * directly, and more strongly than any hash argument answers it.
 *
 * ── WHY THIS CANNOT BECOME A SILENCER, WHICH IS THE BAR THE HASH LEDGER SET ──
 * An entry here is not a recorded promise — it is a PREDICATE RUN AGAINST THE LIVE DATABASE
 * ON EVERY BOOT. It cannot pre-approve a future edit, because what it approves is the effect,
 * and an edit that changes the effect makes `verify` return false and the alarm come back
 * LOUDER than the checksum complaint it replaced (it names the effect that failed, which is
 * actionable, where "two hashes differ" is not). An entry whose predicate passes is saying
 * something true today, re-measured, rather than something a human asserted once.
 */
export type EffectVerification = {
  file: string;
  /** ISO date the effect check was written. */
  since: string;
  /** What the file's whole executable body does, as a claim about the schema. */
  effect: string;
  /** Why provenance is unavailable, so this is never mistaken for the easier road. */
  whyNotHashed: string;
  /** Measured against the live database. Must not throw; a throw is treated as a failure. */
  verify: (db: Db) => boolean;
};


/** One column of a table, as the schema reports it. */
function columnOf(db: Db, table: string, column: string):
{ type: string; notnull: number; dflt_value: string | null } | undefined {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as
    Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
  return cols.find(c => c.name === column);
}

/**
 * Divergences adjudicated by their EFFECT. One entry today; see `EffectVerification` for why
 * this mechanism exists and why it cannot be used to quiet a divergence that matters.
 */
export const EFFECT_VERIFIED: readonly EffectVerification[] = [
  {
    file: '165_work_effort_meter.sql',
    since: '2026-10-05',
    effect: '`work.effort_calls` and `work.effort_reviewed_calls` both exist, INTEGER, '
      + 'NOT NULL, DEFAULT 0 — which is the whole of what this file executes.',
    whyNotHashed: 'The file has ONE commit in this repository\'s entire history, and the '
      + 'recorded checksum matches neither it nor any other version — so the bytes that ran '
      + 'were an uncommitted working-tree draft that exists nowhere and cannot be diffed. A '
      + 'hash entry would be a fabricated warrant, which the ledger test explicitly refuses, '
      + 'and that refusal stands: this file is NOT in KNOWN_DIVERGENCES. Its executable body '
      + 'is two ALTER TABLE ADD COLUMN statements and nothing else, so what the divergence '
      + 'could possibly mean for this database is fully expressible as a schema check — and '
      + 'checking the schema is a stronger answer than arguing about bytes, because it is '
      + 're-measured on every boot instead of asserted once by a human.',
    verify: (db: Db): boolean => {
      try {
        for (const name of ['effort_calls', 'effort_reviewed_calls']) {
          const col = columnOf(db, 'work', name);
          if (!col) return false;
          if (col.type.toUpperCase() !== 'INTEGER') return false;
          if (col.notnull !== 1) return false;
          if ((col.dflt_value ?? '').trim() !== '0') return false;
        }
        return true;
      } catch {
        // A throw is NOT a pass. The loud direction is the safe one.
        return false;
      }
    },
  },
];
