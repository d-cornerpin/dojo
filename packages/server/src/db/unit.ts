// Transactions and commit-then-emit. `fn` may not return a Promise: the process has one connection, so
// an await mid-transaction lets other writes join this unit. Staying sync also keeps the queue race-free.
// afterCommit effects run only after the OUTERMOST unit commits; a thrown unit runs none.

import { getDb } from './connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('unit');

/** A post-commit effect (broadcast, wake, cache poke); synchronous so the queue order holds. */
export type CommitEffect = () => void;

/** A Promise `T` turns into a shape no Promise satisfies, so the call fails to typecheck; else identity. */
type SyncOnly<T> = T extends PromiseLike<unknown>
  ? { readonly ERROR_withUnit_is_synchronous: 'a transaction cannot span an await' }
  : T;

let depth = 0;
let pending: CommitEffect[] = [];

function runEffect(effect: CommitEffect): void {
  try {
    effect();
  } catch (err) {
    logger.warn('afterCommit effect threw (the unit is committed; remaining effects still run)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** One unit, all or nothing. Nested units are savepoints; effects belong to the outermost unit. */
export function withUnit<T>(fn: () => SyncOnly<T>): T {
  const body = fn as unknown as () => T;
  const db = getDb();

  if (depth > 0) {
    depth++;
    const mark = pending.length;
    try {
      return db.transaction(body)();
    } catch (err) {
      // The savepoint rolled back: drop what this unit queued, keep what its parents did.
      pending.length = mark;
      throw err;
    } finally {
      depth--;
    }
  }

  depth = 1;
  let value: T;
  try {
    value = db.transaction(body)();
  } catch (err) {
    pending = [];
    depth = 0;
    throw err;
  }

  // Take the queue and reset depth BEFORE running effects, so an effect that opens a unit starts afresh.
  const queued = pending;
  pending = [];
  depth = 0;
  for (const effect of queued) runEffect(effect);
  return value;
}

/** Run `effect` after the current unit commits, or now when outside a unit (autocommit already did). */
export function afterCommit(effect: CommitEffect): void {
  if (depth === 0) {
    runEffect(effect);
    return;
  }
  pending.push(effect);
}
