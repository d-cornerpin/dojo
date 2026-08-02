// db/unit.ts — the platform's transaction primitive, and the effect queue that
// makes commit-then-emit the law rather than a habit.
//
// ── WHY IT IS SYNCHRONOUS BY TYPE ──────────────────────────────────────────
// A SQLite transaction is a property of the CONNECTION, and this process opens
// exactly one (`db/connection.ts`). An `await` inside a transaction therefore
// hands that connection to whatever else the event loop is holding — mid
// transaction — and the next thing to write does so INSIDE a unit it knows
// nothing about, committing or rolling back with it. That is not a style
// preference, it is the only failure mode a transaction has in this runtime,
// so the SIGNATURE refuses it: `fn` may not return a Promise.
//
//   withUnit(async () => { ... })   ->  does not compile
//   withUnit(() => fetchThing())    ->  does not compile (returns a Promise)
//   withUnit(() => { insert(); })   ->  compiles
//
// The refusal is proven, not asserted, and it is a COMPILE fact so no test can
// hold it — a file that does not compile cannot also run assertions. To re-prove
// it, plant the three async shapes and read the compiler:
//
//   cat > packages/server/src/db/PLANT-sync-by-type.ts <<'EOF'
//   import { withUnit } from './unit.js';
//   export const p1 = withUnit(async () => { return 1; });
//   export const p2 = withUnit(() => Promise.resolve('x'));
//   export const p3 = withUnit(async () => { await Promise.resolve(); });
//   export const ok = withUnit(() => 42);          // the negative control
//   EOF
//   npx tsc --noEmit -p packages/server/tsconfig.json ; rm packages/server/src/db/PLANT-sync-by-type.ts
//
// Read 2026-08-02: three errors, one per async shape ("Property
// 'ERROR_withUnit_is_synchronous' is missing in type 'Promise<number>'…"), and
// SILENCE on `ok`.
//
// That same constraint is what makes the module-level queue below safe. Node is
// single-threaded and a unit cannot span an await, so no second unit can begin
// while one is open — the state that would be a race in an async primitive is
// simply unreachable here. (`withLock` is the async sibling and pays for its
// asynchrony with a promise chain; this one does not need one.)
//
// ── WHAT afterCommit IS FOR ────────────────────────────────────────────────
// Research 22's largest omission: the platform had no concurrency primitive at
// all, and 137 mutation sites sat within 15 lines of a broadcast (53 at this
// phase's HEAD — the rest moved behind single-writer functions in Phases 1–3).
// A broadcast emitted before the commit is a claim about a write that may still
// roll back; every listener then believes something the database never agreed
// to. `afterCommit` holds the emission until the OUTERMOST unit has committed,
// and **a thrown unit runs no effects at all**.
//
// Scope, stated so nobody mistakes it for more: this is IN-PROCESS. The queue
// belongs to this Node process and its one connection. A second process holds
// its own.

import { getDb } from './connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('unit');

/** A queued post-commit effect: a broadcast, a wake, a cache poke. Synchronous
 *  for the same reason the unit is — an effect that awaits is running after the
 *  queue has moved on, which makes its ordering a lie. */
export type CommitEffect = () => void;

/** The compile-time refusal. When `T` is a Promise the parameter type becomes a
 *  shape a Promise cannot satisfy, so the call site fails to typecheck with the
 *  reason spelled out in the property name. When `T` is anything else this is
 *  the identity, so inference is unaffected. */
type SyncOnly<T> = T extends PromiseLike<unknown>
  ? { readonly ERROR_withUnit_is_synchronous: 'a transaction cannot span an await' }
  : T;

/** How deep we are in nested units. 0 = autocommit. */
let depth = 0;
/** Effects queued by the CURRENT outermost unit. Cleared on commit and on throw. */
let pending: CommitEffect[] = [];

function runEffect(effect: CommitEffect): void {
  try {
    effect();
  } catch (err) {
    // An effect is downstream of the truth, never a condition on it: the unit is
    // already committed and cannot be undone by a listener falling over. It is
    // logged rather than swallowed, and the remaining effects still run.
    logger.warn('afterCommit effect threw (the unit is committed; remaining effects still run)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Run `fn`'s writes as ONE unit: both or neither.
 *
 * Nesting is supported and is what makes ownership possible — a service function
 * can wrap its own writes without knowing whether its caller already opened a
 * unit (better-sqlite3 issues a SAVEPOINT for the inner one). Effects always
 * belong to the OUTERMOST unit, because a savepoint release is not a commit.
 */
export function withUnit<T>(fn: () => SyncOnly<T>): T {
  // The cast is the one place the compile-time refusal and the runtime meet:
  // by construction `SyncOnly<T>` is `T` for every value that reaches here.
  const body = fn as unknown as () => T;
  const db = getDb();

  if (depth > 0) {
    depth++;
    try {
      return db.transaction(body)();
    } finally {
      depth--;
    }
  }

  depth = 1;
  let value: T;
  try {
    value = db.transaction(body)();
  } catch (err) {
    // Rolled back: the effects described writes that no longer exist.
    pending = [];
    depth = 0;
    throw err;
  }

  // Committed. Take the queue and drop the depth BEFORE running anything, so an
  // effect that opens its own unit (or queues its own effect) behaves like any
  // other caller instead of being folded back into a unit that has closed.
  const queued = pending;
  pending = [];
  depth = 0;
  for (const effect of queued) runEffect(effect);
  return value;
}

/**
 * Queue an effect to run after the current unit commits.
 *
 * OUTSIDE a unit it runs immediately, and that is not a special case being
 * tolerated: in autocommit mode the write is already committed by the time the
 * next statement runs, so running now IS commit-then-emit. The alternative
 * (throwing) would make every call site ask "am I inside a unit?" — the
 * ceremony this primitive exists to remove.
 */
export function afterCommit(effect: CommitEffect): void {
  if (depth === 0) {
    runEffect(effect);
    return;
  }
  pending.push(effect);
}

/** True while a unit is open. For assertions and for guards that must refuse to
 *  do something un-transactional mid-unit; not a control-flow crutch. */
export function inUnit(): boolean {
  return depth > 0;
}
