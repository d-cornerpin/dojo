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
import fs from 'node:fs';
import path from 'node:path';

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
    getDbPath: () => p.join(o.tmpdir(), 'dojo-t7-status-frame-test', 'dojo.db'),
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
import { dispatchPMRenameHandoff } from '../v2/steps/execute/scaffold-title.js';

const AGENT = 'agent-t7';
const SRC = path.join(__dirname, '..', '..');

const TRIGGER_SRC = fs.readFileSync(
  path.join(SRC, 'agent', 'v2', 'steps', 'preflight', 'turn-trigger.ts'), 'utf8',
);
const CHAT_TSX = fs.readFileSync(
  path.join(SRC, '..', '..', 'dashboard', 'src', 'pages', 'Chat.tsx'), 'utf8',
);
const RUNTIME_SRC = fs.readFileSync(path.join(SRC, 'agent', 'runtime.ts'), 'utf8');

/** Executable lines only. These clauses are about what the CODE does; a comment that
 *  explains the rule (and therefore quotes its keywords) must not satisfy or trip them. */
const codeOnly = (src: string): string => src
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
  .join('\n');

const TRIGGER_CODE = codeOnly(TRIGGER_SRC);
const CHAT_CODE = codeOnly(CHAT_TSX);

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

  // ── THE MOVE, AND ITS STOP CONDITION ────────────────────────────────────────────────
  it('RED: the working status is written AFTER the conversation key is published', () => {
    const publish = TRIGGER_CODE.indexOf('turnCtx.convKey = chosenConvKey;');
    const status = TRIGGER_CODE.indexOf("setAgentStatus(agentId, 'working')");
    expect(publish, 'the conv-key publication is still in this file').toBeGreaterThan(-1);
    expect(status, 'the status write is still in this file').toBeGreaterThan(-1);
    expect(
      status,
      'frame 1 can only carry a truthful `userFacing` if the key is published first',
    ).toBeGreaterThan(publish);
  });

  it('STOP CONDITION, pinned: no yield point separates the status write from the conv-key publication', () => {
    // The plan stops the task if an `await` sits between the two sites, because moving the
    // DB `working` write across a yield would widen the 409 / busy-check window observably.
    // `runTurnTrigger` is a plain function with no `await` at all, so the whole span is one
    // synchronous block — pinned here so a future `async` cannot reopen the hazard silently.
    const fn = TRIGGER_CODE.slice(TRIGGER_CODE.indexOf('export function runTurnTrigger'));
    expect(fn.slice(0, 200)).not.toMatch(/export\s+async\s+function/);
    const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
    expect(body, 'no await may separate the two sites').not.toMatch(/\bawait\b/);
    // ...and the two sites really are both inside that body.
    expect(body).toMatch(/turnCtx\.convKey = chosenConvKey;/);
    expect(body).toMatch(/setAgentStatus\(agentId, 'working'\)/);
  });

  // ── THE CLIENT GUARD ────────────────────────────────────────────────────────────────
  it('RED: the client refuses to light the working UI on a frame that says userFacing:false', () => {
    const expr = CHAT_CODE.slice(CHAT_CODE.indexOf('const showWorkingUi'));
    const decl = expr.slice(0, expr.indexOf(';') + 1);
    expect(decl, 'the declaration is still in this file').toContain('showWorkingUi');
    expect(
      decl,
      'showWorkingUi must refuse an explicitly non-user-facing frame',
    ).toMatch(/turnUserFacing\s*!==\s*false/);
    expect(decl, 'wordy mode stays exempt').toContain('wordyMode');
    expect(decl, 'a request in flight stays exempt (the busy-box latch)').toContain('awaitingUserReply');
    // The frame's own answer is what is read — including "it did not say".
    expect(CHAT_CODE).toMatch(/setTurnUserFacing\(e\.userFacing\)/);
  });

  it('control: the bare-frame default survives untouched (the media path depends on it)', () => {
    // `tools/cat/media.ts` broadcasts `{status:'working'}` with neither field to hold the
    // dots up during image generation. A frame with NO `turnKind` must keep behaving as
    // today; only an EXPLICIT `userFacing:false` is refused.
    expect(CHAT_TSX).toMatch(/e\.turnKind\s*\?\?\s*'user'/);
  });

  // ── THE SIBLING: THE PM RENAME HANDOFF'S WIRE FRAME ─────────────────────────────────
  it('RED: the PM rename broadcast carries the stored row\'s own truth, not a hand-built `role: user`', async () => {
    await dispatchPMRenameHandoff({
      callingAgentId: AGENT, taskId: 'task-1', taskTitle: 'Some interim slice',
      originalPrompt: 'go and do the multi-step thing',
    });
    const row = mockDb.current!.prepare(
      `SELECT id, role, lane, display_kind, origin_intent FROM messages WHERE origin_intent = 'pm_rename'`,
    ).get() as { id: string; role: string; lane: string; display_kind: string; origin_intent: string };
    expect(row, 'the handoff persists an events-lane engine row').toBeTruthy();
    expect(row.lane).toBe('events');
    expect(row.display_kind).toBe('engine-note');

    const frame = frames.find((f) => f.type === 'chat:message') as
      { message: { id: string; role: string; displayKind?: string | null } } | undefined;
    expect(frame, 'the handoff broadcasts the row').toBeTruthy();
    expect(frame!.message.id).toBe(row.id);
    expect(frame!.message.role, 'the wire role is the row\'s role').toBe(row.role);
    expect(
      frame!.message.displayKind,
      'the store knows this is engine traffic; the wire frame must say so too',
    ).toBe(row.display_kind);
  });

  // ── THE RIDER, MEASURED ─────────────────────────────────────────────────────────────
  it('rider: v1\'s heartbeat is dead code, so it is left alone — pinned so a revival must align it', () => {
    // T7's rider says: align the v1 heartbeat to carry `userFacing` IF it is on a live path,
    // otherwise record that it is not and touch nothing. Measured: `runtime.ts` exports
    // `startStatusHeartbeat` and nothing calls it — v2 runs its own local copy
    // (`agent/v2/loop.ts`), and `runAgentLoop` (v1) no longer exists. If that ever changes,
    // this clause fails and the aligner becomes required.
    expect(RUNTIME_SRC).toMatch(/export function startStatusHeartbeat/);
    const callers = RUNTIME_SRC.match(/(?<!export function )startStatusHeartbeat\(/g) ?? [];
    expect(callers.length, 'v1 heartbeat has no live caller inside runtime.ts').toBe(0);
  });
});
