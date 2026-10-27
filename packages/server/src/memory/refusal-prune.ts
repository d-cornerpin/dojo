// ════════════════════════════════════════════════════════════════════════════════════════
// t269 fix round 3 (re-review 3) — PRUNING AN EARLIER SETTING'S REFUSALS, BY THE SETTING FIELD.
//
// Two code paths (`unwritable-span.ts`, `summary-check-ledger.ts`) pruned "an earlier setting's
// refusals" with `DELETE ... key NOT LIKE '%|' || ? || '|%'` — matching the setting ANYWHERE in the
// key. That is wrong in two ways:
//   · a stale key `a1|m0|m1|h` survives when the current setting is `m1`, because `|m1|` also appears
//     in the WRITER field of that old key;
//   · a `_` or `%` in the setting is a LIKE wildcard, so a current setting `m_1` keeps a stale key
//     `a1|mX1|id` (`_` matches the `X`). Stale rows pile up (storage only: readers match whole keys).
//
// The one rule, here: keep only the rows whose SETTING FIELD (index 1 of the pipe-delimited key)
// equals the current setting; delete every other key of that scope. No LIKE anywhere. A row in
// another scope is never touched, and a scope with no rows does nothing.
// ════════════════════════════════════════════════════════════════════════════════════════

import type Database from 'better-sqlite3';

/** Delete every `healer_state` row of `scope` whose key's setting field is not `setting`. The
 *  pipe-delimited keys are `agent|setting|…`, so the setting is ALWAYS the second field (index 1) —
 *  never a substring match, never a LIKE wildcard. Best effort: a caller that cannot read or write
 *  its database is wrapped by its own try/catch, and a missing record costs one more try. */
export function pruneRefusalsOtherThan(db: Database.Database, scope: string, setting: string): void {
  const rows = db.prepare('SELECT key FROM healer_state WHERE scope = ?').all(scope) as Array<{ key: string }>;
  for (const { key } of rows) {
    if (key.split('|')[1] !== setting) {
      db.prepare('DELETE FROM healer_state WHERE scope = ? AND key = ?').run(scope, key);
    }
  }
}
