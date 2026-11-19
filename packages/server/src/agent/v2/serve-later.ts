// THE ONE WRITER of "serve this again at". Its own file so the settlement can call it without loading the clock's
// readers (they reach the settlement back through the work spine).

import { getDb } from '../../db/connection.js';
import { afterCommit } from '../../db/unit.js';
import { createLogger } from '../../logger.js';
import { recordDeliveryAttempt } from '../../memory/message-store.js';
import { workingExpr } from '../../work/terminal-states.js';

const logger = createLogger('owed');

export type Owed = { kind: 'ask' | 'task'; id: string } | { kind: 'row'; agentId: string; rowid: number };

/** Write the due time (null clears); the one clock is armed after the caller's unit commits. */
export function serveLater(subject: Owed, at: number | null, why: string, opts: { onlyIfParked?: true } = {}): void {
  const db = getDb();
  if (subject.kind === 'row') {
    if (at !== null) recordDeliveryAttempt({ agentId: subject.agentId, rowid: subject.rowid, notBefore: at });
  } else if (opts.onlyIfParked) {
    db.prepare(`UPDATE work SET next_attempt_at = MIN(next_attempt_at, ?), updated_at = ?
      WHERE id = ? AND next_attempt_at IS NOT NULL AND hold_kind IS NULL AND ${workingExpr('work')}`).run(at, Date.now(), subject.id);
  } else {
    db.prepare('UPDATE work SET next_attempt_at = ?, updated_at = ? WHERE id = ?').run(at, Date.now(), subject.id);
  }
  logger.info('owed: serve again at', { subject, at, why });
  afterCommit(() => void import('./owed.js').then((m) => m.armOwedClock()));
}
