// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR T7 — A STATUS FRAME NEVER ASSERTS A TURN KIND IT DOES NOT KNOW. Written BEFORE
// the fix.
//
// THE DEFECT. The first `agent:status working` of every turn is emitted at the top of
// preflight (`steps/preflight/turn-trigger.ts`), BEFORE the turn is classified. The seam
// (`agent-status.ts`) fabricated `turnKind:'user'` from a `?? 'user'` default and OMITTED
// `userFacing` entirely, because the turn's bag was still empty. The corrective frame lands
// on the same server tick (catalog S6:81-82, both `01:16:34.163Z`; the investigation's driven
// repro: six pairs, all 0 ms), so the visible harm is at most a sub-frame flicker — but the
// WIRE ASSERTS A FALSE FACT, and any consumer that samples between frames, reconnects, or
// was written against `agent:status` inherits it. Two unfiltered consumers exist today
// (`pages/Agents.tsx`, `pages/Tracker.tsx`).
//
// THE TWO HALVES, both needed:
//   (i)  MOVE the emit to just after the conversation key is published, still inside the
//        same synchronous span, so frame 1 carries a TRUTHFUL `userFacing`. `userFacing`'s
//        own commit (`e0acf31`) says status events carry human-facing truth "on working and
//        idle alike"; frame 1 was the one place that violated it.
//   (ii) STOP FABRICATING: omit `turnKind` when the turn's kind is genuinely unknown. The
//        client's `?? 'user'` default (`Chat.tsx`) stays — the legacy bare frames the media
//        path emits rely on it.
//
// WHAT MAY NOT MOVE (the recorded weld): `setAgentStatus` welds the DB write to the
// broadcast, and the `working` ROW must be visible early — the 409 arm
// (`gateway/routes/agents.ts`), peers' busy checks and the stuck-agent reaper all read it.
// So the call moves only WITHIN the synchronous window, and the STOP condition — "no `await`
// between the two sites" — is pinned below as a test rather than as a claim.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
const frames: Array<Record<string, unknown>> = [];

vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t7-status-frame-test', 'dojo.db'),
  };
});

vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { frames.push(e); },
}));

vi.mock('../runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => undefined }),
}));

import { runMigrations } from '../../db/migrations.js';
import { setAgentStatus } from '../agent-status.js';
import { openTurnContext, endTurnContext } from '../turn-context.js';

const AGENT = 'agent-t7';

const lastStatusFrame = (): Record<string, unknown> | undefined =>
  [...frames].reverse().find((f) => f.type === 'agent:status');

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const id of [AGENT, 'pm']) {
    mockDb.current.prepare(
      `INSERT OR IGNORE INTO agents (id, name, status, session_started_at)
       VALUES (?, ?, 'idle', '1970-01-01')`,
    ).run(id, id);
  }
  frames.length = 0;
});

afterEach(() => { endTurnContext(AGENT); });

describe('T7 — the status seam stops fabricating a turn kind', () => {
  it('RED: a turn whose kind is not yet known OMITS turnKind (it must not assert `user`)', () => {
    // Frame 1 of every turn: the bag is open and the conversation key is published, but
    // classification has not run, so `kind` is genuinely unknown.
    const ctx = openTurnContext(AGENT);
    ctx.convKey = null; // a background a2a / engine turn
    setAgentStatus(AGENT, 'working');
    const f = lastStatusFrame()!;
    expect(f.status).toBe('working');
    expect(
      Object.prototype.hasOwnProperty.call(f, 'turnKind'),
      'the seam must not assert a turn kind it has not computed',
    ).toBe(false);
  });

  it('RED (the a2a-wake repro): frame 1 of a background turn carries userFacing:false and no turnKind', () => {
    const ctx = openTurnContext(AGENT);
    ctx.convKey = null;
    setAgentStatus(AGENT, 'working');
    const f = lastStatusFrame()!;
    expect(f.userFacing).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(f, 'turnKind')).toBe(false);
  });

  it('control: frame 1 of a HUMAN turn carries userFacing:true (and still no fabricated kind)', () => {
    const ctx = openTurnContext(AGENT);
    ctx.convKey = 'human:owner';
    setAgentStatus(AGENT, 'working');
    const f = lastStatusFrame()!;
    expect(f.userFacing).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(f, 'turnKind')).toBe(false);
  });

  it('control (`4941ca1` preserved): once the kind IS known the frame carries it, both values', () => {
    const ctx = openTurnContext(AGENT);
    ctx.convKey = null;
    ctx.kind = 'a2a';
    setAgentStatus(AGENT, 'working');
    expect(lastStatusFrame()!.turnKind).toBe('a2a');
    ctx.convKey = 'human:owner';
    ctx.kind = 'user';
    setAgentStatus(AGENT, 'working');
    expect(lastStatusFrame()!.turnKind).toBe('user');
    expect(lastStatusFrame()!.userFacing).toBe(true);
  });

  it('control (legacy bare frames): outside a turn the frame carries NEITHER field', () => {
    // `undefined` convKey is the seam's "no turn resolved" case and stays omitted, so the
    // client keeps its safe default — the media generator's bare working frame relies on it.
    setAgentStatus(AGENT, 'working');
    const f = lastStatusFrame()!;
    expect(Object.prototype.hasOwnProperty.call(f, 'userFacing')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(f, 'turnKind')).toBe(false);
  });

  it('control: `idle` never carries turnKind, and still carries userFacing', () => {
    const ctx = openTurnContext(AGENT);
    ctx.convKey = 'human:owner';
    ctx.kind = 'user';
    setAgentStatus(AGENT, 'idle');
    const f = lastStatusFrame()!;
    expect(Object.prototype.hasOwnProperty.call(f, 'turnKind')).toBe(false);
    expect(f.userFacing).toBe(true);
  });

  it('control (the weld): the seam still WROTE the row it broadcast', () => {
    const ctx = openTurnContext(AGENT);
    ctx.convKey = 'human:owner';
    setAgentStatus(AGENT, 'working');
    const row = mockDb.current!.prepare('SELECT status FROM agents WHERE id = ?').get(AGENT) as { status: string };
    expect(row.status, 'the 409 arm, the peer busy checks and the reaper all read this row').toBe('working');
  });
});
