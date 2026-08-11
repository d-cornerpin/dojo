// UX-REPAIR POST-.27 REPORT 2 / T40 — A FILED CLOSE CANNOT SIT IN SILENCE. (SOLVE LAYER 2.)
//
// ── THE INCIDENT (the owner's box, from his pasted card — the only admissible evidence) ──
// A Tomorrow-Brief task: created 11:58:42, retitled by the PM 11:58:52, paused when the
// agent replied without effectful work, un-paused when the owner spoke, the work done ~12:08
// with a verified `outlook_send` receipt, and at 12:10:14 RESULT + EVIDENCE landed on the
// card — the stored shape of a filed close. Then nothing. The task never closed. The card's
// activity log showed ZERO validation events and did not display the pending close at all.
//
// ── WHY THIS FLOOR IS CAUSE-INDEPENDENT ──
// Three separate mechanisms each hold such a row, and they compose into permanent silence:
//   1. `ownerEscalationOrderingExpr` releases a row to the owner ONLY once a validation
//      ATTEMPT is recorded. The only two writers of that record live inside the PM's own
//      review (`validation_review_miss`) and its validator-missing branch
//      (`validation_validator_unavailable`). A review that never runs writes neither — so a
//      row whose validator never showed up is held back FOREVER, with no ceiling and no
//      timeout. The hold was already logged; nothing ever ended it.
//   2. `readAuditTrail` is a UNION of `audit` / `transition` / verdict rows. A worker's close
//      is Key 1 and only Key 1: `validation_requested` lands and the row does NOT move. So
//      the one event proving a close was requested is in no branch, and the card's activity
//      log is genuinely EMPTY for the whole pending window — which is why the owner could not
//      tell "nobody filed" from "nobody answered".
//   3. The reality check (`alreadyDeliveredReceiptExpr`) suppresses owner escalation whenever
//      the work already reached the person — correctly, since its question is "is this really
//      done?" — and this incident is exactly that shape. So even a released row would say
//      nothing. Only a statement ABOUT THE VALIDATOR, not about the work, can reach him.
//
// requirement preserved (the ordering law's own intent, SWEEP CORE-2 item 1): the owner is
// still not told his validator did not rule while it is merely QUEUED. The floor below fires
// on a row past the same bound the escalation already uses, and it records an attempt of the
// existing `validator_unavailable` kind — it does not lower the bound, invent a threshold, or
// escalate anything itself. The controls pin both directions.
//
// requirement preserved (T21/T26): the pending flag survives. Nothing here writes a
// `transition` or a verdict, so `pendingCloseRequestExpr` cannot be consumed by it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
const broadcasts: Array<Record<string, unknown>> = [];

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-t40-silence-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { broadcasts.push(e); },
}));

import { runMigrations } from '../../db/migrations.js';
import { transition } from '../store.js';
import { readAuditTrail } from '../audit-trail.js';
import {
  selectRowsForOwnerEscalation, countRowsHeldBackFromOwner, validationAttemptCount,
  recordAttemptsForRowsNoValidatorEverSaw, VALIDATION_ATTEMPT_UNAVAILABLE,
  noteValidatorSilence, resetValidatorSilenceEpisode,
} from '../validation-drive.js';
import { pendingCloseRequestExpr, unvalidatedCloseExpr } from '../tracker-view.js';

const AGENT = 'kevin';
const T = 1_700_000_000_000;
const BOUND_MS = 5 * 60_000;

function seedWork(id: string, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, kind: 'task', parent_id: null, agent_id: AGENT, assignee_agent: null,
    requester: 'owner', requester_id: 'owner', conversation_id: null,
    root_kind: 'tracker', root_id: '', state: 'claimed', claimed_by_turn: null,
    result_delivery_id: null, intent: 'do-it', wakes: 1, closes_thread: 0,
    hop_count: 0, superseded_by: null, title: 'Tomorrow brief', goal: null, priority: 'normal',
    notes: null, remaining_children: null, compile_pending: 0, ttl_at: null,
    reply_conversation_id: null, attempts: 0, next_attempt_at: null, schedule_json: null,
    tz: null, anchor_local: null, next_run_at: null, sequence: null,
    opened_at: T, closed_at: null, updated_at: T, provenance: 'live', ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO work (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
}

function seedDelivery(id: string): string {
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at)
     VALUES (?, ?, NULL, 'dashboard', 'dashboard', NULL, 'delivered', datetime('now'))`,
  ).run(id, AGENT);
  return id;
}

/** The agent files its own close: Key 1, and only Key 1. The row does not move. */
function fileCloseRequest(id: string, deliveryId: string | null = null): void {
  const res = transition(id, {
    to: 'done', by: 'agent', actorId: AGENT,
    reason: 'brief sent', resultDeliveryId: deliveryId ?? undefined,
  });
  expect(res.kind).toBe('refused');
}

const pending = (id: string): number =>
  (mockDb.current!.prepare(
    `SELECT ${pendingCloseRequestExpr('w')} AS p FROM work w WHERE w.id = ?`,
  ).get(id) as { p: number }).p;

const unvalidatedClose = (id: string): number =>
  (mockDb.current!.prepare(
    `SELECT (CASE WHEN ${unvalidatedCloseExpr('w')} THEN 1 ELSE 0 END) AS u FROM work w WHERE w.id = ?`,
  ).get(id) as { u: number }).u;

/** Age the row so it sits past the escalation bound, as the owner's did. */
function age(id: string, ms: number): void {
  mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(Date.now() - ms, id);
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  broadcasts.length = 0;
  resetValidatorSilenceEpisode();
  mockDb.current.prepare("INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')").run(AGENT, 'Kevin');
});

describe('the card can see that a close was requested', () => {
  it('RED: a filed close request appears in the activity log', () => {
    seedWork('w1');
    fileCloseRequest('w1', seedDelivery('d1'));

    const trail = readAuditTrail('w1');
    const filed = trail.filter((r) => r.entry_kind === 'validation_requested');

    expect(filed).toHaveLength(1);
    expect(filed[0].from_status).toBe('in_progress');
    expect(filed[0].to_status).toBe('complete');
    expect(filed[0].note).toMatch(/awaiting validation/i);
  });

  it('the branches that were already there are byte-unchanged', () => {
    seedWork('w2');
    // A real transition and a real verdict still render exactly as before.
    const moved = transition('w2', { to: 'paused', by: 'agent', actorId: AGENT, reason: 'waiting on them' });
    expect(moved.kind).toBe('applied');
    const trail = readAuditTrail('w2');
    expect(trail.some((r) => r.entry_kind === 'transition' && r.to_status === 'paused')).toBe(true);
  });
});

describe('the ordering law can no longer hold a row in permanent silence', () => {
  it('RED: a filed close past the bound with no attempt is invisible to the owner, forever', () => {
    seedWork('w3');
    fileCloseRequest('w3', seedDelivery('d3'));
    age('w3', BOUND_MS * 2);
    const staleBefore = Date.now() - BOUND_MS;

    // The rot, recorded: past the bound, unvalidated, and held back with zero attempts.
    expect(unvalidatedClose('w3')).toBe(1);
    expect(validationAttemptCount('w3')).toBe(0);
    expect(countRowsHeldBackFromOwner(staleBefore, [])).toBe(1);
    expect(selectRowsForOwnerEscalation(staleBefore, []).map((r) => r.id)).toEqual([]);

    // THE FLOOR: an attempt that could not be made is still an attempt, and it is recorded
    // through the SAME audit door the PM's own validator-missing branch uses.
    const wrote = recordAttemptsForRowsNoValidatorEverSaw(staleBefore, []);
    expect(wrote).toEqual(['w3']);
    expect(validationAttemptCount('w3')).toBe(1);

    // The existing escalation can now see it — no new escalation path was invented.
    expect(countRowsHeldBackFromOwner(staleBefore, [])).toBe(0);
    expect(selectRowsForOwnerEscalation(staleBefore, []).map((r) => r.id)).toEqual(['w3']);
  });

  it('the floor is IDEMPOTENT: a second pass over the same row records nothing further', () => {
    seedWork('w4');
    fileCloseRequest('w4', seedDelivery('d4'));
    age('w4', BOUND_MS * 2);
    const staleBefore = Date.now() - BOUND_MS;

    expect(recordAttemptsForRowsNoValidatorEverSaw(staleBefore, [])).toEqual(['w4']);
    expect(recordAttemptsForRowsNoValidatorEverSaw(staleBefore, [])).toEqual([]);
    expect(validationAttemptCount('w4')).toBe(1);
  });

  it('CONTROL — the ordering law still holds a row whose validator is merely QUEUED', () => {
    seedWork('w5');
    fileCloseRequest('w5', seedDelivery('d5'));
    // Inside the bound: the validator has had no time yet. Nothing is recorded, nothing moves.
    age('w5', 30_000);
    const staleBefore = Date.now() - BOUND_MS;

    expect(recordAttemptsForRowsNoValidatorEverSaw(staleBefore, [])).toEqual([]);
    expect(validationAttemptCount('w5')).toBe(0);
    expect(selectRowsForOwnerEscalation(staleBefore, []).map((r) => r.id)).toEqual([]);
  });

  it('CONTROL — a row the validator ALREADY attempted is not attempted again by the floor', () => {
    seedWork('w6');
    fileCloseRequest('w6', seedDelivery('d6'));
    age('w6', BOUND_MS * 2);
    const staleBefore = Date.now() - BOUND_MS;

    // The PM's own miss marker, written by its review. The floor must not double-count it.
    mockDb.current!.prepare(
      `INSERT INTO work_events (work_id, kind, actor, payload, created_at)
       VALUES (?, 'audit', 'pm', json_object('action_taken', 'validation_review_miss'), ?)`,
    ).run('w6', Date.now());

    expect(validationAttemptCount('w6')).toBe(1);
    expect(recordAttemptsForRowsNoValidatorEverSaw(staleBefore, [])).toEqual([]);
    expect(validationAttemptCount('w6')).toBe(1);
  });

  it('T21/T26 PRESERVATION — the attempt record is not a transition and does not consume the close', () => {
    seedWork('w7');
    fileCloseRequest('w7', seedDelivery('d7a'));
    age('w7', BOUND_MS * 2);
    expect(pending('w7')).toBe(1);

    recordAttemptsForRowsNoValidatorEverSaw(Date.now() - BOUND_MS, []);

    expect(pending('w7')).toBe(1);
    expect(unvalidatedClose('w7')).toBe(1);
    // SELF-HEAL: a validator that comes back still closes this row through the normal door.
    const res = transition('w7', {
      to: 'done', by: 'pm', actorId: 'kelly', claim: 'authoritative',
      reason: 'brief verified', resultDeliveryId: seedDelivery('d7'),
    });
    expect(res.kind).toBe('applied');
    expect(pending('w7')).toBe(0);
  });
});

describe('repeated validator silence reaches the owner', () => {
  it('says it ONCE per episode, through the existing toast machinery', async () => {
    await noteValidatorSilence(2, 'kevin');
    await noteValidatorSilence(2, 'kevin');
    await noteValidatorSilence(3, 'kevin');

    const toasts = broadcasts.filter((b) => b.type === 'chat:error');
    expect(toasts).toHaveLength(1);
    expect(String(toasts[0].error)).toMatch(/validation/i);
    expect(toasts[0].severity).toBe('warning');
  });

  it('says nothing while the validator is ruling, and re-arms after it goes quiet again', async () => {
    await noteValidatorSilence(0, 'kevin');
    expect(broadcasts.filter((b) => b.type === 'chat:error')).toHaveLength(0);

    await noteValidatorSilence(1, 'kevin');
    expect(broadcasts.filter((b) => b.type === 'chat:error')).toHaveLength(1);

    // The validator rules again: the episode ends.
    await noteValidatorSilence(0, 'kevin');
    // And a NEW stall is a NEW episode — one more toast, not silence forever.
    await noteValidatorSilence(1, 'kevin');
    expect(broadcasts.filter((b) => b.type === 'chat:error')).toHaveLength(2);
  });
});
