// v3.5 field fix 3, ranked fix #3: THE VERDICT SWEEP RECORDS ONLY WHAT HAPPENED.
//
// The owner's box (diagnosis Problem 1): five done or cancelled tasks still carried an uncleared
// `user_verdict_requested`. Every 30s the 12h sweep picked them, `setTrackerStatus(…, 'blocked')`
// was refused (done/abandoned can only go to open), and the sweep wrote "dropped to blocked,
// please review" and broadcast the row ANYWAY: 716 false audit rows per task in six hours.
//
// Three parts, and the class law as a test (every sweep step applies its action or takes the row
// out of its own subject, and records only what happened):
//   (a) a finished row is never awaiting a verdict (`awaitingUserVerdictExpr`);
//   (b) any move into a terminal state answers an open verdict request;
//   (c) the sweep writes its audit row and broadcasts only when the drop applied; a refusal
//       clears the request with its reason;
//   plus the repair migration, append-only, for rows already finished with a request open.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-verdict-sweep', 'dojo.db'),
  };
});
const frames: Array<Record<string, unknown>> = [];
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { frames.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }) }));
const notices: unknown[] = [];
vi.mock('../../agent/a2a-notice.js', () => ({ deliverA2ANotice: async (n: unknown) => { notices.push(n); } }));
// One switch per test: make the drop refuse for a named row, the way a pre-gate would.
const refuseDropFor = new Set<string>();
vi.mock('../../work/tracker-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../work/tracker-store.js')>();
  return {
    ...actual,
    setTrackerStatus: (id: string, status: Parameters<typeof actual.setTrackerStatus>[1], input: Parameters<typeof actual.setTrackerStatus>[2]) =>
      refuseDropFor.has(id)
        ? { kind: 'refused', workId: id, reason: 'illegal-transition', detail: 'refused for this test' }
        : actual.setTrackerStatus(id, status, input),
  };
});
// The same for the override sweep: a resolve that finds the request already answered.
const overrideAlreadyAnswered = { value: false };
vi.mock('../../work/override-requests.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../work/override-requests.js')>();
  return {
    ...actual,
    resolveOverrideRequest: (...a: Parameters<typeof actual.resolveOverrideRequest>) =>
      overrideAlreadyAnswered.value ? false : actual.resolveOverrideRequest(...a),
  };
});

import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from '../../db/migrations.js';
import { sweepStaleRequests } from '../runner.js';
import { openTrackerTask, requestUserVerdict } from '../../work/tracker-store.js';
import { transition } from '../../work/store.js';
import { awaitingUserVerdictExpr } from '../../work/tracker-view.js';
import { fileOverrideRequest } from '../../work/override-requests.js';

const AGENT = 'agent-worker';
const HOURS_13 = 13 * 3600_000;
const db = (): Database.Database => mockDb.current!;

function seedTask(title: string): string {
  return openTrackerTask({
    title, status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
}

/** A verdict request the owner never answered, filed 13h ago (written raw so it can be backdated). */
function oldRequest(id: string): void {
  db().prepare(
    `INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, 'user_verdict_requested', '{}', 'pm', ?)`,
  ).run(id, Date.now() - HOURS_13);
}

function finish(id: string, to: 'done' | 'abandoned'): void {
  if (to === 'done') {
    db().prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at)
       VALUES (?, ?, NULL, 'dashboard', 'dashboard', 'delivered', datetime('now'))`,
    ).run(`d-${id}`, AGENT);
  }
  const r = transition(id, {
    to, by: 'owner', actorId: 'owner', claim: 'authoritative', reason: `owner ${to}`,
    resultDeliveryId: to === 'done' ? `d-${id}` : null,
  });
  expect(r.kind).toBe('applied');
}

const stateOf = (id: string): string => (db().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;
const awaiting = (id: string): number =>
  (db().prepare(`SELECT ${awaitingUserVerdictExpr('w')} AS a FROM work w WHERE w.id = ?`).get(id) as { a: number }).a;
const sweepRows = (id: string): number => (db().prepare(
  `SELECT count(*) AS c FROM work_events WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = 'auto_sweep'`,
).get(id) as { c: number }).c;
const cleared = (id: string): Array<{ reason: string }> => (db().prepare(
  `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'user_verdict_cleared' ORDER BY id`,
).all(id) as Array<{ payload: string }>).map((r) => JSON.parse(r.payload) as { reason: string });
/** The raw "request newer than clear" position, ignoring the row's state. */
const openOnLog = (id: string): boolean => {
  const r = db().prepare(
    `SELECT (SELECT MAX(id) FROM work_events WHERE work_id = ? AND kind = 'user_verdict_requested') AS q,
            (SELECT MAX(id) FROM work_events WHERE work_id = ? AND kind = 'user_verdict_cleared') AS c`,
  ).get(id, id) as { q: number | null; c: number | null };
  return (r.q ?? -1) > (r.c ?? -1);
};
const framesFor = (id: string): number => frames.filter((f) => {
  const d = f.data as { id?: string; taskId?: string; task_id?: string } | undefined;
  return d?.id === id || d?.taskId === id || d?.task_id === id;
}).length;

beforeEach(() => {
  mockDb.current?.close();
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Worker', 'idle', '1970-01-01')`).run(AGENT);
  frames.length = 0;
  notices.length = 0;
  refuseDropFor.clear();
  overrideAlreadyAnswered.value = false;
});

describe('(a)+(c) the sweep over finished rows: nothing written, nothing broadcast, on every run', () => {
  it('THE FIELD SHAPE: done and cancelled rows with an old open request; a live row beside them', async () => {
    const live = seedTask('live, awaiting the owner');
    const done = seedTask('finished');
    const gone = seedTask('cancelled');
    finish(done, 'done');
    finish(gone, 'abandoned');
    for (const id of [live, done, gone]) oldRequest(id);

    expect(awaiting(done), 'a finished row is not awaiting a verdict').toBe(0);
    expect(awaiting(gone)).toBe(0);
    expect(awaiting(live)).toBe(1);

    await sweepStaleRequests();
    await sweepStaleRequests();

    // the live row: one drop, one audit row, one clear
    expect(stateOf(live)).toBe('blocked');
    expect(sweepRows(live)).toBe(1);
    expect(cleared(live)).toHaveLength(1);
    expect(awaiting(live)).toBe(0);
    // the finished rows: zero audit rows and zero frames on BOTH runs, state untouched
    for (const id of [done, gone]) {
      expect(sweepRows(id), `false "dropped to blocked" rows on ${id}`).toBe(0);
      expect(framesFor(id), `broadcasts for a row nothing happened to (${id})`).toBe(0);
    }
    expect(stateOf(done)).toBe('done');
    expect(stateOf(gone)).toBe('abandoned');
  });

  it('a REFUSED drop clears the request with its reason and writes no "dropped to blocked" record', async () => {
    const t = seedTask('refused drop');
    oldRequest(t);
    refuseDropFor.add(t);
    await sweepStaleRequests();
    await sweepStaleRequests();
    expect(stateOf(t)).toBe('claimed');
    expect(sweepRows(t)).toBe(0);
    expect(framesFor(t)).toBe(0);
    const c = cleared(t);
    expect(c).toHaveLength(1);
    expect(c[0].reason).toMatch(/refused/);
    expect(awaiting(t), 'the refused row left the sweep\'s subject').toBe(0);
  });

  it('an ALREADY-BLOCKED row: the request clears, and no false move is recorded', async () => {
    const t = seedTask('already blocked');
    expect(transition(t, { to: 'blocked', by: 'owner', actorId: 'owner', claim: 'authoritative', reason: 'waiting on a reply' }).kind).toBe('applied');
    oldRequest(t);
    await sweepStaleRequests();
    expect(stateOf(t)).toBe('blocked');
    expect(sweepRows(t)).toBe(0);
    expect(cleared(t)).toHaveLength(1);
  });
});

describe('(b) a move into a terminal state answers an open verdict request', () => {
  for (const to of ['done', 'abandoned'] as const) {
    it(`closing to ${to} appends user_verdict_cleared, and a later reopen does not revive the request`, () => {
      const t = seedTask(`close to ${to}`);
      requestUserVerdict(t, 'pm', { reason: 'stalemate' });
      expect(awaiting(t)).toBe(1);
      finish(t, to);
      expect(openOnLog(t), 'the request is still open on the log').toBe(false);
      const c = cleared(t);
      expect(c).toHaveLength(1);
      expect(c[0].reason).toMatch(/^closed/);
      expect(transition(t, { to: 'open', by: 'owner', actorId: 'owner', claim: 'authoritative', reason: 'reopen' }).kind).toBe('applied');
      expect(awaiting(t)).toBe(0);
    });
  }

  it('CONTROL: a terminal move with no open request writes no clear', () => {
    const t = seedTask('nothing asked');
    finish(t, 'abandoned');
    expect(cleared(t)).toHaveLength(0);
  });
});

describe('the repair migration: finished rows with a request still open', () => {
  const FILE = (): string => {
    const dir = path.resolve(__dirname, '../../db/migrations');
    const name = fs.readdirSync(dir).find((f) => /^210_/.test(f));
    expect(name, 'migration 210 is missing').toBeDefined();
    return fs.readFileSync(path.join(dir, name!), 'utf8');
  };

  it('appends one clear per finished row with an open request, leaves live rows alone, and is append-only', () => {
    const done = seedTask('finished long ago');
    const live = seedTask('live');
    finish(done, 'done');
    oldRequest(done);
    oldRequest(live);
    const before = (db().prepare('SELECT count(*) AS c, MAX(id) AS m FROM work_events').get() as { c: number; m: number });
    db().exec(FILE());
    db().exec(FILE());
    expect(openOnLog(done)).toBe(false);
    expect(cleared(done)).toHaveLength(1);
    expect(openOnLog(live), 'a live request is the owner\'s to answer').toBe(true);
    const after = (db().prepare('SELECT count(*) AS c FROM work_events WHERE id <= ?').get(before.m) as { c: number });
    expect(after.c, 'no earlier event was touched').toBe(before.c);
  });
});

describe('the sibling override sweep records only a resolution that applied', () => {
  it('a stale override request that is already answered writes no auto-deny record and sends no notice', async () => {
    const t = seedTask('override asked');
    fileOverrideRequest(t, { requestedBy: AGENT, requestedStatus: 'complete', justification: 'the engine is wrong' });
    db().prepare(`UPDATE work_events SET created_at = ? WHERE work_id = ? AND kind = 'override_request'`).run(Date.now() - HOURS_13, t);
    overrideAlreadyAnswered.value = true;
    await sweepStaleRequests();
    expect(sweepRows(t)).toBe(0);
    expect(notices).toHaveLength(0);
  });

  it('CONTROL: an unanswered stale override is auto-denied once, recorded once, and the requester is told', async () => {
    const t = seedTask('override asked, live');
    fileOverrideRequest(t, { requestedBy: AGENT, requestedStatus: 'complete', justification: 'the engine is wrong' });
    db().prepare(`UPDATE work_events SET created_at = ? WHERE work_id = ? AND kind = 'override_request'`).run(Date.now() - HOURS_13, t);
    await sweepStaleRequests();
    await sweepStaleRequests();
    expect(sweepRows(t)).toBe(1);
    expect(notices).toHaveLength(1);
  });
});
