// PHASE-6 T0D Step 1 arm (a) — THE ATTRIBUTE DOOR REFUSES A DEAD ID, AND THE
// REFUSAL IS NOT DISCARDABLE.
//
// The state door has refused a stale id by name since PHASE-2 (`transition()`
// G1). The ATTRIBUTE door did not: `patchWork` was a bare
// `UPDATE work SET … WHERE id = ?` that returned `0` for two unrelated facts —
// "you named no field" and "that row does not exist" — with no existence check,
// no log, and no outcome type. A write against a task id that no longer exists
// therefore did nothing and said nothing, which is the stale-task-id class the
// issues log has carried open since 2026-07-26.
//
// THE RULE THIS FILE ENFORCES ON ITSELF (copied from `transition.test.ts`): a
// gate is only tested when the SAME shape is shown to pass with the one
// offending detail corrected. "It refused" proves nothing on its own — it might
// refuse everything.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
const logged: Array<{ level: string; msg: string; meta?: unknown }> = [];

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    error: (msg: string, meta?: unknown) => logged.push({ level: 'error', msg, meta }),
    warn: (msg: string, meta?: unknown) => logged.push({ level: 'warn', msg, meta }),
    info: () => { /* not the subject */ },
    debug: () => { /* not the subject */ },
  }),
}));

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-work-patch-stale-test', 'dojo.db'),
  };
});

import { isOutcomeShaped } from '@dojo/shared';
import { runMigrations } from '../../db/migrations.js';
import { patchWork } from '../tracker-store.js';
import { transition } from '../store.js';
import { noteUnsettled } from '../outcome.js';

const AGENT = 'kevin';
const T = 1_700_000_000_000;

function seedWork(id: string, over: Record<string, unknown> = {}): void {
  const row = {
    id, kind: 'task', parent_id: null, agent_id: AGENT, assignee_agent: null,
    requester: 'owner', requester_id: 'owner', conversation_id: null,
    root_kind: 'tracker', root_id: id, state: 'open', claimed_by_turn: null,
    result_delivery_id: null, intent: 'tracker', wakes: 1, closes_thread: 0,
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

const titleOf = (id: string): string | null =>
  ((mockDb.current!.prepare('SELECT title FROM work WHERE id = ?').get(id) as
    { title: string | null } | undefined)?.title) ?? null;
const updatedAtOf = (id: string): number | null =>
  ((mockDb.current!.prepare('SELECT updated_at FROM work WHERE id = ?').get(id) as
    { updated_at: number } | undefined)?.updated_at) ?? null;

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  logged.length = 0;
  runMigrations();
});

describe('the attribute door refuses a work id that no longer exists', () => {
  it('REFUSES by name when the row is gone, and the SAME patch APPLIES when it is not', () => {
    // The adjacent arm first: this exact call works on a live row, so a refusal
    // below is about the id and nothing else.
    seedWork('w-live');
    const ok = patchWork('w-live', { title: 'renamed' });
    expect(ok.kind).toBe('applied');
    if (ok.kind === 'applied') expect(ok.value).toBe(1);
    expect(titleOf('w-live')).toBe('renamed');

    // Same shape, one detail corrected: the row does not exist.
    const gone = patchWork('w-deleted', { title: 'renamed' });
    expect(gone.kind).toBe('refused');
    if (gone.kind !== 'refused') return;
    expect(gone.reason).toBe('no-such-work');
    expect(gone.workId).toBe('w-deleted');
  });

  it('refuses a row DELETED after it was read — the race the 52 discarding callers ran', () => {
    seedWork('w-race');
    expect(patchWork('w-race', { priority: 'high' }).kind).toBe('applied');
    mockDb.current!.prepare('DELETE FROM work WHERE id = ?').run('w-race');
    const after = patchWork('w-race', { priority: 'low' });
    expect(after.kind).toBe('refused');
  });

  it('carries the SAME steerable remedy the state door has carried since PHASE-2', () => {
    // The two doors must not tell a model two different stories about one fact.
    // `transition()` G1's wording is the pin; the attribute door quotes it.
    const stateDoor = transition('w-deleted', { to: 'claimed', by: 'agent', reason: 'x' });
    expect(stateDoor.kind).toBe('refused');
    if (stateDoor.kind !== 'refused') return;

    const attrDoor = patchWork('w-deleted', { title: 'x' });
    expect(attrDoor.kind).toBe('refused');
    if (attrDoor.kind !== 'refused') return;

    expect(stateDoor.reason).toBe(attrDoor.reason);
    for (const phrase of ['earlier session', 'list the open work', 'current id']) {
      expect(stateDoor.detail).toContain(phrase);
      expect(attrDoor.detail).toContain(phrase);
    }
  });

  it('separates the two facts that both used to be `0`: no field named vs no such row', () => {
    seedWork('w-empty');
    const before = updatedAtOf('w-empty');

    // (1) A patch that mentions nothing is NOT a refusal — nothing was asked.
    const nothingAsked = patchWork('w-empty', {});
    expect(nothingAsked.kind).toBe('no_change');
    if (nothingAsked.kind === 'no_change') expect(nothingAsked.reason).toBe('empty-patch');
    // and the clock still may not move for a change that did not happen (M7).
    expect(updatedAtOf('w-empty')).toBe(before);

    // (2) An all-`undefined` patch is the same fact by the ONE PATCH RULE.
    expect(patchWork('w-empty', { title: undefined }).kind).toBe('no_change');

    // (3) The SAME empty patch against a DEAD id is the OTHER fact, and the
    //     dead row is the one worth reporting: a caller that named no field
    //     against a row that is not there has two problems, and only one of
    //     them is about the world.
    const emptyAndGone = patchWork('w-deleted', {});
    expect(emptyAndGone.kind).toBe('refused');
    if (emptyAndGone.kind === 'refused') expect(emptyAndGone.reason).toBe('no-such-work');
  });

  it('is an OUTCOME, which is what makes the refusal impossible to discard silently', () => {
    // The must-consume lint (PHASE-4's twelfth blocking gate) keys on the SHAPE
    // declared in `@dojo/shared`, never on a type name. This clause asserts the
    // shape at runtime, so the property the lint enforces is also a test: if a
    // later change demotes this door back to a bare `number`, the lint stops
    // seeing 51 call sites and THIS fails in the same commit.
    seedWork('w-shape');
    expect(isOutcomeShaped(patchWork('w-shape', { title: 't' }))).toBe(true);
    expect(isOutcomeShaped(patchWork('w-shape', {}))).toBe(true);
    expect(isOutcomeShaped(patchWork('w-deleted', { title: 't' }))).toBe(true);
  });

  it('reaches the ONE recorder the transition door already uses — not a second one', () => {
    // `noteUnsettled` is PHASE-4 T1's sanctioned "consume by recording" for the
    // caller with no branch to take. The attribute door's refusals go to the
    // SAME name; a second recorder for the same job would be the disease, and
    // the "no log" half of this door's three named absences would still be open.
    noteUnsettled(patchWork('w-deleted', { title: 't' }), 'test: the dead id');
    expect(logged.filter((l) => l.level === 'warn')).toHaveLength(1);
    expect(JSON.stringify(logged)).toContain('w-deleted');
    expect(JSON.stringify(logged)).toContain('no-such-work');

    // ...and a settled outcome records NOTHING, or the log becomes noise nobody
    // reads, which is how the last silent door got built.
    logged.length = 0;
    seedWork('w-noted');
    noteUnsettled(patchWork('w-noted', { title: 't' }), 'test: the live id');
    noteUnsettled(patchWork('w-noted', {}), 'test: the empty patch');
    expect(logged).toHaveLength(0);
  });
});
