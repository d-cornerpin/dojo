// PHASE-2 T2 Step 3 — every gate and every effect of the ONE writer, proven both ways.
//
// The rule this file enforces on itself: a gate is only tested when the SAME shape is shown
// to pass with the one offending detail corrected. Otherwise "it refused" proves nothing —
// it might refuse everything.

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-work-transition-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { transition, rejectClaim, revertCount, isTerminal } from '../store.js';

const AGENT = 'kevin';
const T = 1_700_000_000_000;

function seedWork(id: string, over: Record<string, unknown> = {}): void {
  const row = {
    id, kind: 'task', parent_id: null, agent_id: AGENT, assignee_agent: null,
    requester: 'owner', requester_id: 'owner', conversation_id: null,
    root_kind: 'ask', root_id: 'ask-1', state: 'open', claimed_by_turn: null,
    result_delivery_id: null, intent: 'do-it', wakes: 1, closes_thread: 0,
    hop_count: 0, superseded_by: null, title: 'a thing', goal: null, priority: null,
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

const stateOf = (id: string): string =>
  (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;
const rowOf = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown>;
const events = (id: string): Array<{ kind: string; actor: string; payload: string | null }> =>
  mockDb.current!.prepare('SELECT kind, actor, payload FROM work_events WHERE work_id = ? ORDER BY id')
    .all(id) as Array<{ kind: string; actor: string; payload: string | null }>;

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, outcome)
     VALUES ('d-1', ?, 'send_message', 'imessage', 'delivered')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO turn_artifacts (id, agent_id, kind, path) VALUES ('art-1', ?, 'file', '/tmp/x.png')`,
  ).run(AGENT);
});

describe('the discriminated result the caller must read', () => {
  it('applied carries from, to and the event it wrote', () => {
    seedWork('w1');
    const r = transition('w1', { to: 'claimed', by: 'agent', reason: 'picked it up', claimedByTurn: 7 });
    expect(r.kind).toBe('applied');
    if (r.kind !== 'applied') return;
    expect(r.from).toBe('open');
    expect(r.to).toBe('claimed');
    expect(r.eventId).toBeGreaterThan(0);
    expect(stateOf('w1')).toBe('claimed');
    expect(rowOf('w1').claimed_by_turn).toBe(7);
  });

  it('noop when the row is already there — never reported as a change', () => {
    seedWork('w1', { state: 'paused' });
    const r = transition('w1', { to: 'paused', by: 'agent', reason: 'again' });
    expect(r.kind).toBe('noop');
    expect(events('w1')).toHaveLength(0);       // a no-op writes no history
  });

  it('conflict when the caller acted on a state that has since moved', () => {
    seedWork('w1', { state: 'claimed' });
    const r = transition('w1', { to: 'done', by: 'agent', reason: 'x', expectedState: 'open' });
    expect(r.kind).toBe('conflict');
    if (r.kind !== 'conflict') return;
    expect(r.expected).toBe('open');
    expect(r.actual).toBe('claimed');
    expect(stateOf('w1')).toBe('claimed');      // nothing was overwritten
    // POSITIVE CONTROL: the same call with the true expected state applies
    const ok = transition('w1', {
      to: 'done', by: 'agent', reason: 'x', expectedState: 'claimed', resultDeliveryId: 'd-1',
    });
    expect(ok.kind).toBe('applied');
  });
});

describe('G1 — a stale id is refused with something steerable, never created', () => {
  it('refuses an id from a previous session and says what to do instead', () => {
    const r = transition('task-from-last-week', { to: 'done', by: 'agent', reason: 'done' });
    expect(r.kind).toBe('rejected');
    if (r.kind !== 'rejected') return;
    expect(r.gate).toBe('no-such-work');
    expect(r.detail).toMatch(/earlier session/);
    expect(mockDb.current!.prepare('SELECT count(*) c FROM work').get()).toEqual({ c: 0 });
  });
});

describe('G2 — every transition states its reason', () => {
  it('refuses an empty reason and accepts a real one', () => {
    seedWork('w1');
    expect(transition('w1', { to: 'claimed', by: 'agent', reason: '   ' }).kind).toBe('rejected');
    expect(transition('w1', { to: 'claimed', by: 'agent', reason: 'because' }).kind).toBe('applied');
  });
});

describe('G5 — the legal-transition table', () => {
  it('refuses a move that is not on the table, and allows the neighbouring one that is', () => {
    seedWork('w1', { state: 'on_deck' });
    const bad = transition('w1', { to: 'done', by: 'agent', reason: 'x', resultDeliveryId: 'd-1' });
    expect(bad.kind).toBe('rejected');
    if (bad.kind === 'rejected') expect(bad.gate).toBe('illegal-transition');
    expect(transition('w1', { to: 'claimed', by: 'agent', reason: 'x' }).kind).toBe('applied');
  });
});

describe('G6 — the engine may only assert what it can point at (OR2)', () => {
  it('refuses an engine transition with no evidence at all', () => {
    seedWork('w1', { state: 'claimed' });
    const r = transition('w1', { to: 'failed', by: 'engine', reason: 'gave up' });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.gate).toBe('engine-needs-evidence');
  });

  it('refuses an engine transition whose evidence resolves to nothing', () => {
    seedWork('w1', { state: 'claimed' });
    const r = transition('w1', { to: 'failed', by: 'engine', reason: 'gave up', evidenceRef: 'made-up-id' });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.gate).toBe('engine-evidence-unresolved');
  });

  it('accepts evidence that is a real delivery, a real artifact, or a real occurrence', () => {
    seedWork('sched', { kind: 'commitment' });
    seedWork('occ', { kind: 'occurrence', parent_id: 'sched', sequence: 1 });
    for (const [id, ref] of [['a', 'd-1'], ['b', 'art-1'], ['c', 'occ']] as const) {
      seedWork('w-' + id, { state: 'claimed' });
      const r = transition('w-' + id, { to: 'failed', by: 'engine', reason: 'gave up', evidenceRef: ref });
      expect(r.kind).toBe('applied');
    }
  });

  it('a NON-occurrence work row is not evidence — the reference must be the right KIND of thing', () => {
    seedWork('plain-task');
    seedWork('w1', { state: 'claimed' });
    const r = transition('w1', { to: 'failed', by: 'engine', reason: 'x', evidenceRef: 'plain-task' });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.gate).toBe('engine-evidence-unresolved');
  });
});

describe('G7 — done means DELIVERED', () => {
  it('refuses done with no delivery', () => {
    seedWork('w1', { state: 'claimed' });
    const r = transition('w1', { to: 'done', by: 'agent', reason: 'finished' });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.gate).toBe('done-requires-delivery');
    expect(stateOf('w1')).toBe('claimed');
  });

  it('refuses done with a delivery id that is not a delivery — a CHECK cannot see this', () => {
    seedWork('w1', { state: 'claimed' });
    const r = transition('w1', { to: 'done', by: 'agent', reason: 'finished', resultDeliveryId: 'd-nope' });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.gate).toBe('delivery-unresolved');
  });

  it('accepts done with a real delivery, and stamps closed_at with it', () => {
    seedWork('w1', { state: 'claimed' });
    const r = transition('w1', { to: 'done', by: 'agent', reason: 'sent it', resultDeliveryId: 'd-1' });
    expect(r.kind).toBe('applied');
    const row = rowOf('w1');
    expect(row.state).toBe('done');
    expect(row.result_delivery_id).toBe('d-1');
    expect(row.closed_at).toBeGreaterThan(1_600_000_000_000);
  });
});

describe('G8 — two-key is a type, not a source scan', () => {
  it('refuses an authoritative claim from a worker agent and allows it from the PM', () => {
    seedWork('w1', { state: 'claimed' });
    const bad = transition('w1', { to: 'failed', by: 'agent', reason: 'x', claim: 'authoritative' });
    expect(bad.kind).toBe('rejected');
    if (bad.kind === 'rejected') expect(bad.gate).toBe('authoritative-claim-not-permitted');
    const good = transition('w1', { to: 'failed', by: 'pm', reason: 'x', claim: 'authoritative' });
    expect(good.kind).toBe('applied');
  });

  it('a NON-terminal move needs no second key — blocked/paused are not settlements', () => {
    seedWork('w1', { state: 'claimed' });
    const r = transition('w1', {
      to: 'blocked', by: 'agent', reason: 'waiting on the API key', claim: 'requests-validation',
    });
    expect(r.kind).toBe('applied');
    expect(stateOf('w1')).toBe('blocked');
  });

  it('a worker claiming FAILED is recorded as a validation request, state unchanged', () => {
    seedWork('w1', { state: 'claimed' });
    const r = transition('w1', { to: 'failed', by: 'agent', reason: 'cannot do it', claim: 'requests-validation' });
    expect(r.kind).toBe('rejected');
    if (r.kind !== 'rejected') return;
    expect(r.gate).toBe('requires-validation');
    expect(stateOf('w1')).toBe('claimed');
    expect(events('w1').map((e) => e.kind)).toEqual(['validation_requested']);
  });

  it('DONE is exempt from the second key, because a delivery IS the receipt', () => {
    seedWork('w1', { state: 'claimed' });
    const r = transition('w1', {
      to: 'done', by: 'agent', reason: 'sent it', claim: 'requests-validation', resultDeliveryId: 'd-1',
    });
    expect(r.kind).toBe('applied');
  });

  it('an authoritative transition writes an adjudication row; a rejection writes the other kind', () => {
    seedWork('w1', { state: 'claimed' });
    transition('w1', { to: 'failed', by: 'owner', reason: 'I say so', claim: 'authoritative' });
    const adj = mockDb.current!.prepare('SELECT verdict, claim_state FROM adjudications WHERE work_id = ?')
      .all('w1') as Array<{ verdict: string; claim_state: string }>;
    expect(adj).toEqual([{ verdict: 'upheld', claim_state: 'failed' }]);
    expect(revertCount('w1')).toBe(0);
    const rej = rejectClaim('w1', { claimState: 'done', by: 'pm', note: 'no delivery, no done' });
    expect(rej.kind).toBe('applied');
    expect(revertCount('w1')).toBe(1);
    expect(rejectClaim('w1', { claimState: 'done', by: 'agent', note: 'let me' }).kind).toBe('rejected');
  });
});

describe('reopening settled work needs an authority', () => {
  it('refuses a worker reopening a done row and allows the owner', () => {
    seedWork('w1', { state: 'done', closed_at: T, result_delivery_id: 'd-1' });
    const bad = transition('w1', { to: 'open', by: 'agent', reason: 'late answer arrived' });
    expect(bad.kind).toBe('rejected');
    if (bad.kind === 'rejected') expect(bad.gate).toBe('reopen-requires-authority');
    const good = transition('w1', { to: 'open', by: 'owner', reason: 'late answer arrived', claim: 'authoritative' });
    expect(good.kind).toBe('applied');
    expect(rowOf('w1').closed_at).toBeNull();     // the paired CHECK is satisfied by the writer
  });
});

describe('effects run INSIDE, once, on every applied path', () => {
  it('writes exactly one transition event carrying the full story', () => {
    seedWork('w1');
    transition('w1', { to: 'claimed', by: 'agent', reason: 'mine', actorId: 'kevin', claimedByTurn: 3 });
    const ev = events('w1');
    expect(ev).toHaveLength(1);
    expect(ev[0].kind).toBe('transition');
    expect(ev[0].actor).toBe('kevin');
    const payload = JSON.parse(ev[0].payload!) as Record<string, unknown>;
    expect(payload).toMatchObject({ from: 'open', to: 'claimed', by: 'agent', reason: 'mine' });
  });

  it('decrements the parent countdown atomically when a child settles, and records it', () => {
    seedWork('parent', { kind: 'project', remaining_children: 2 });
    seedWork('child-a', { parent_id: 'parent', state: 'claimed' });
    seedWork('child-b', { parent_id: 'parent', state: 'claimed' });

    transition('child-a', { to: 'done', by: 'agent', reason: 'sent', resultDeliveryId: 'd-1' });
    expect(rowOf('parent').remaining_children).toBe(1);
    transition('child-b', { to: 'failed', by: 'pm', reason: 'gave up', claim: 'authoritative' });
    expect(rowOf('parent').remaining_children).toBe(0);
    expect(events('parent').map((e) => e.kind)).toEqual(['child_settled', 'child_settled']);
  });

  it('never drives the countdown negative, however many children settle', () => {
    seedWork('parent', { kind: 'project', remaining_children: 1 });
    seedWork('c1', { parent_id: 'parent', state: 'claimed' });
    seedWork('c2', { parent_id: 'parent', state: 'claimed' });
    transition('c1', { to: 'done', by: 'agent', reason: 'x', resultDeliveryId: 'd-1' });
    transition('c2', { to: 'done', by: 'agent', reason: 'x', resultDeliveryId: 'd-1' });
    expect(rowOf('parent').remaining_children).toBe(0);
  });

  it('does NOT decrement when a child moves between two non-terminal states', () => {
    seedWork('parent', { kind: 'project', remaining_children: 1 });
    seedWork('c1', { parent_id: 'parent', state: 'open' });
    transition('c1', { to: 'claimed', by: 'agent', reason: 'x' });
    transition('c1', { to: 'paused', by: 'agent', reason: 'x' });
    expect(rowOf('parent').remaining_children).toBe(1);
    expect(events('parent')).toHaveLength(0);
  });

  it('clears claimed_by_turn when the row leaves claimed', () => {
    seedWork('w1');
    transition('w1', { to: 'claimed', by: 'agent', reason: 'x', claimedByTurn: 11 });
    expect(rowOf('w1').claimed_by_turn).toBe(11);
    transition('w1', { to: 'open', by: 'agent', reason: 'aborted, nothing happened' });
    expect(rowOf('w1').claimed_by_turn).toBeNull();
  });

  it('a REFUSED transition leaves the row and the ledger untouched (bar the recorded request)', () => {
    seedWork('w1', { state: 'claimed' });
    transition('w1', { to: 'done', by: 'agent', reason: 'finished' });          // no delivery
    transition('w1', { to: 'done', by: 'engine', reason: 'finished' });          // no evidence
    expect(stateOf('w1')).toBe('claimed');
    expect(rowOf('w1').updated_at).toBe(T);
    expect(events('w1')).toHaveLength(0);
  });
});

describe('exported helpers', () => {
  it('isTerminal names exactly the three terminal states', () => {
    expect((['done', 'failed', 'abandoned'] as const).every(isTerminal)).toBe(true);
    expect((['open', 'claimed', 'paused', 'blocked', 'on_deck'] as const).some(isTerminal)).toBe(false);
  });
});
