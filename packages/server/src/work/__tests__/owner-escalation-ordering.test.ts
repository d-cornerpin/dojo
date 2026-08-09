// ════════════════════════════════════════════════════════════════════════════════════════
// SWEEP CORE-2 ITEM 1 — THE ORDERING LAW.
//
// *"(3) Escalation to the owner only AFTER a recorded validation attempt."* — the owner,
// 2026-08-06.
//
// ── THE SHAPE THIS FORBIDS, MEASURED (battery `bmsgs7qejup`, TB8 §3.2) ───────────────────
//   01:14:17/:23/:33   three rows request Key 2
//   01:15:00–01:16:10  PM validation turn #1 — no verdict, and NOTHING recorded it
//   01:17:00–01:18:04  PM validation turn #2 — same silence
//   01:20:00           the scheduler tells the OWNER all three are unvalidated
//   01:23:11           the PM upholds them — three minutes after the owner was bothered
//
// And worse, twice more: BATTERY6 — 5 of 6 owner-escalated rows never received an in-window
// verdict. BATTERY9 — 3 of 3. An escalation naming un-attempted work is the defect those
// denominators measured; TB8 made "was the validator ever asked?" answerable, and this file
// makes the answer the LAW.
//
// ── SCOPE, STATED RATHER THAN ASSUMED ───────────────────────────────────────────────────
// The law binds the TWO-KEY COMPLETE arms only — `done` awaiting Key 2, and `claimed` with a
// pending close request. That is the class the owner's law is about, the class TB8's
// coverage recorder observes, and the class `delegation-longhorizon` clause (c) measures.
// The `paused` and `blocked` arms are a DIFFERENT verdict with no coverage recorder behind
// them, so gating them would invent a hole where the owner is never told. They escalate
// exactly as they did before, and a negative control below pins that.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-owner-escalation-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { transition } from '../store.js';
import { appendAuditEntry } from '../audit-trail.js';
import { recordValidationEscalation } from '../tracker-store.js';
import {
  taskScope, validatedExpr, awaitingUserVerdictExpr, pendingCloseRequestExpr,
} from '../tracker-view.js';
import {
  selectRowsForOwnerEscalation,
  setValidationDoorbellHandler,
  VALIDATION_ATTEMPT_MISS,
  VALIDATION_ATTEMPT_UNAVAILABLE,
} from '../validation-drive.js';

const AGENT = 'kevin';
const T = 1_700_000_000_000;
/** Older than `VALIDATION_ESCALATION_MIN`, expressed as the sweep sees it: a cutoff. */
const NOW = T + 60 * 60_000;
const CUTOFF = NOW - 5 * 60_000;

function seedWork(id: string, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, kind: 'task', parent_id: null, agent_id: AGENT, assignee_agent: null,
    requester: 'owner', requester_id: 'owner', conversation_id: null,
    root_kind: 'tracker', root_id: '', state: 'claimed', claimed_by_turn: null,
    result_delivery_id: null, intent: 'do-it', wakes: 1, closes_thread: 0,
    hop_count: 0, superseded_by: null, title: 'a thing', goal: null, priority: 'normal',
    notes: null, remaining_children: null, compile_pending: 0, ttl_at: null,
    reply_conversation_id: null, attempts: 0, next_attempt_at: null, schedule_json: null,
    tz: null, anchor_local: null, next_run_at: null, sequence: null,
    opened_at: T, closed_at: null, updated_at: T, provenance: 'live',
    missed_runs_paused_at: null, ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO work (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
}

const recordAttempt = (workId: string, marker: string): void => {
  appendAuditEntry(workId, 'pm', { entryKind: 'observation', actionTaken: marker, reason: 'test' });
};

/** The sweep's own candidate set, read through the one function the scheduler calls. */
const candidates = (): string[] =>
  selectRowsForOwnerEscalation(CUTOFF, ['dreamer', 'healer']).map((r) => r.id);

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, outcome)
     VALUES ('d-1', ?, 'send_message', 'imessage', 'delivered')`,
  ).run(AGENT);
  setValidationDoorbellHandler(null);
});

/** A row in the exact state the Key-1 filing leaves it: `claimed`, close request pending. */
function seedKeyOneFiled(id: string): void {
  seedWork(id);
  const r = transition(id, {
    to: 'done', by: 'agent', actorId: AGENT, reason: 'done', resultDeliveryId: 'd-1',
  });
  expect(r.kind).toBe('refused');
  mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(T, id);
}

/** A row in the engine-receipt state: `done`, adjudicated by a role production excludes. */
function seedEngineReceiptClose(id: string): void {
  seedWork(id);
  const r = transition(id, {
    to: 'done', by: 'engine', actorId: 'engine', reason: 'receipt close',
    evidenceRef: 'd-1', resultDeliveryId: 'd-1',
  });
  expect(r.kind).toBe('applied');
  mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(T, id);
}

describe('THE ORDERING LAW — the owner is not told about work nobody tried to validate', () => {
  it('a Key-1-filed row past the bound with NO recorded attempt is REFUSED escalation', () => {
    seedKeyOneFiled('e1');
    expect(candidates()).toEqual([]);
  });

  it('an ENGINE-RECEIPT close past the bound with no recorded attempt is refused too', () => {
    seedEngineReceiptClose('e2');
    expect(candidates()).toEqual([]);
  });

  it('WITH a recorded MISS, the existing path is unchanged — the row escalates', () => {
    seedKeyOneFiled('e3');
    recordAttempt('e3', VALIDATION_ATTEMPT_MISS);
    expect(candidates()).toEqual(['e3']);
  });

  it('WITH a recorded VALIDATOR-UNAVAILABLE, it escalates — nobody could be asked, and the owner must still hear it', () => {
    seedEngineReceiptClose('e4');
    recordAttempt('e4', VALIDATION_ATTEMPT_UNAVAILABLE);
    expect(candidates()).toEqual(['e4']);
  });

  it('THE 01:20-BEFORE-01:23 SHAPE CANNOT HAPPEN: attempt first, then the owner', () => {
    // Two rows aged identically past the bound. One had its validator asked and it did not
    // rule; the other has never been in front of a validator at all. Only the first is the
    // owner's business, and that is the whole ruling.
    seedKeyOneFiled('asked');
    seedKeyOneFiled('never-asked');
    recordAttempt('asked', VALIDATION_ATTEMPT_MISS);
    expect(candidates()).toEqual(['asked']);
  });

  it('NEGATIVE CONTROL: an unvalidated PAUSE still escalates with no attempt recorded', () => {
    seedWork('p1', { state: 'paused' });
    expect(candidates()).toEqual(['p1']);
  });

  it('NEGATIVE CONTROL: an unvalidated BLOCK still escalates with no attempt recorded', () => {
    seedWork('b1', { state: 'blocked' });
    expect(candidates()).toEqual(['b1']);
  });

  it('NEGATIVE CONTROL: every pre-existing exclusion still bites', () => {
    // already escalated once
    seedKeyOneFiled('done-once');
    recordAttempt('done-once', VALIDATION_ATTEMPT_MISS);
    recordValidationEscalation('done-once', 'scheduler', 'thread-1');
    // a service agent's own maintenance row (owner-scope rule, 2026-07-18)
    seedKeyOneFiled('service');
    mockDb.current!.prepare('UPDATE work SET agent_id = ? WHERE id = ?').run('dreamer', 'service');
    recordAttempt('service', VALIDATION_ATTEMPT_MISS);
    // an engine missed-runs pause is not the owner's call
    seedWork('missed', { state: 'paused', missed_runs_paused_at: T });
    // and a row younger than the bound is not stale yet
    seedKeyOneFiled('young');
    recordAttempt('young', VALIDATION_ATTEMPT_MISS);
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(NOW, 'young');

    expect(candidates()).toEqual([]);
  });

  it('THE COUNTERFACTUAL: strip the ordering clause and the old defect returns', () => {
    // The clause cannot go RED in time (the law and its query landed together), so it is
    // proven by REMOVING it. This is the WHERE the scheduler carried at `3a4dc6a`, minus
    // the one new predicate — and it hands the owner a row nobody ever looked at, which is
    // exactly what BATTERY6 measured 5 times in 6 and BATTERY9 measured 3 times in 3.
    seedKeyOneFiled('never-asked');
    expect(candidates()).toEqual([]);
    const preFix = (mockDb.current!.prepare(`
      SELECT w.id AS id FROM work w
      WHERE ${taskScope('w')}
        AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.work_id = w.id AND e.kind = 'validation_escalated')
        AND ${awaitingUserVerdictExpr('w')} = 0
        AND (
          (w.state = 'done' AND ${validatedExpr('w', 'done')} = 0)
          OR (w.state = 'claimed' AND ${pendingCloseRequestExpr('w')} = 1)
        )
        AND w.updated_at < ?
    `).all(CUTOFF) as Array<{ id: string }>).map((r) => r.id);
    expect(preFix).toEqual(['never-asked']);
  });

  it('a validated row is not a candidate whatever its attempt history says', () => {
    seedWork('v1');
    recordAttempt('v1', VALIDATION_ATTEMPT_MISS);
    const r = transition('v1', {
      to: 'done', by: 'pm', actorId: 'kelly', claim: 'authoritative',
      reason: 'upheld', resultDeliveryId: 'd-1',
    });
    expect(r.kind).toBe('applied');
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(T, 'v1');
    expect(candidates()).toEqual([]);
  });
});
