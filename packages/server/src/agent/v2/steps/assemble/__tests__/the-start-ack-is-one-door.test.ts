// ════════════════════════════════════════════════════════════════════════════════════════
// HL4 STEP 2 (2e), MERGER 1 — THE START-ACK IS ONE DOOR.
//
// W26 handed this up and W27's census ranked it the lowest-risk merger in the tree, with
// the reason that makes it low-risk: the observable behaviour is ALREADY single-door,
// because the latch makes whichever opener runs second a no-op. What was not single was
// the CODE — two copies of the same three-flag write, two enqueues of the same constant,
// and a reminder rung that reads the first steer's own queue entry from a third place.
// The census also corrected W26's count: it is not "two doors", it is six sites — three
// upstream REQUEST sites, two arming sites and the checkpoint that converts a request into
// a steer.
//
// THE MERGER IS A DELETION. One module owns the text, the flag triple, the arming gate and
// the reminder rung; the openers keep ONLY their own opening predicate, which is the one
// thing that genuinely differs between them (a wall-clock/tracker REQUEST versus a routed
// channel or a multistep verdict). Nothing about when the door opens moves.
//
// §1 is the RED and it is structural, because "one door" is a claim about the code: at
// `20d199a` the flag triple has TWO writers and the steer constant has TWO enqueues.
// §2 and §3 are the preservation clauses, driven, and they are the reason this is safe.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertMessageIfAbsent: vi.fn(),
}));

import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runSteerCheckpoint } from '../steer-checkpoint.js';
import { START_ACK_STEER_TEXT } from '../steer-checkpoint.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '../../..');
const AGENT = 'kevin';

const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

function engineCode(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(fp); continue; }
      if (!e.name.endsWith('.ts') || e.name.includes('.test.')) continue;
      out.push({ rel: path.relative(ENGINE, fp).split(path.sep).join('/'), text: stripComments(fs.readFileSync(fp, 'utf8')) });
    }
  };
  walk(ENGINE);
  return out;
}

function sitesMatching(re: RegExp): string[] {
  const hits: string[] = [];
  for (const { rel, text } of engineCode()) {
    text.split('\n').forEach((l, i) => { if (re.test(l)) hits.push(`${rel}:${i + 1}`); });
  }
  return hits;
}

// ── The checkpoint's own inputs, at the one moment it runs: assemble, mid-array. ──
type Bag = Record<string, unknown>;
const bag = (over: Bag = {}): Bag => ({
  startAckSteerRequested: false,
  startAckSteerArmedThisTurn: false,
  startAckSteersInjected: 0,
  startAckSteerInjectedAtLoop: 0,
  ...over,
});

function runCheckpoint(over: {
  turnCtx?: Bag; loopCount?: number; delivered?: boolean; replied?: boolean;
  state?: AgentTurnState;
} = {}): { state: AgentTurnState; turnCtx: Bag } {
  const turnCtx = over.turnCtx ?? bag();
  const state = over.state ?? advance(
    initState({ agentId: AGENT, maxToolLoops: 20 } as Parameters<typeof initState>[0]),
    { loopCount: over.loopCount ?? 1 },
  );
  const out = runSteerCheckpoint(state, {
    agentId: AGENT,
    turnCtx: turnCtx as never,
    turnNumber: 9,
    engineStartAckDeliveredThisTurn: over.delivered ?? false,
    startAckRepliedNow: () => over.replied ?? false,
    // The drain's own two arguments. An empty array and a bare context are enough: this
    // suite is about the DOOR, and the drain has its own clauses in `contract.test.ts`.
    mctx: {} as never,
    messages: [] as never,
  });
  return { state: out.state, turnCtx };
}

const fired = (s: AgentTurnState): Array<{ floor: string; content: string; atLoop: number }> =>
  s.steerQueue.fired as unknown as Array<{ floor: string; content: string; atLoop: number }>;

beforeEach(() => { vi.clearAllMocks(); });

// ════════════════════════════════════════════════════════════════════
// §1 — ONE DOOR (the RED)
// ════════════════════════════════════════════════════════════════════

describe('§1 one door: one text, one flag triple, one enqueue', () => {
  it('the ARMED flag has exactly ONE writer in the engine', () => {
    // Two copies of a three-flag write is how a second door gets opened by accident — and
    // it is the shape W26 handed up. The three upstream REQUEST sites are untouched: they
    // write `startAckSteerRequested`, which is a different flag and a different job.
    const writers = sitesMatching(/turnCtx\.startAckSteerArmedThisTurn\s*=\s*true/);
    expect(writers).toHaveLength(1);
    expect(writers[0]).toMatch(/assemble\/start-ack-door\.ts/);
  });

  it('the whole flag triple is written in that ONE place, together', () => {
    for (const flag of ['startAckSteersInjected', 'startAckSteerInjectedAtLoop']) {
      const writers = sitesMatching(new RegExp(`turnCtx\\.${flag}\\s*=\\s*[^=]`));
      // `startAckSteersInjected` is also set to 2 by the reminder rung — in the same file.
      expect(writers.every((w) => w.includes('assemble/start-ack-door.ts')), `${flag}: ${writers.join(', ')}`).toBe(true);
    }
  });

  it('the start-ack steer is FILED from exactly one place', () => {
    const enqueues = sitesMatching(/floor: 'start-ack'/);
    expect(enqueues).toHaveLength(1);
    expect(enqueues[0]).toMatch(/assemble\/start-ack-door\.ts/);
  });

  it('and so is its reminder — rung 2 of one ladder, in the ladder\'s own file', () => {
    const enqueues = sitesMatching(/floor: 'start-ack-reminder'/);
    expect(enqueues).toHaveLength(1);
    expect(enqueues[0]).toMatch(/assemble\/start-ack-door\.ts/);
  });

  it('the text is declared once and imported, never re-typed', () => {
    const declarations = sitesMatching(/export const START_ACK_STEER_TEXT/);
    expect(declarations).toHaveLength(1);
    // …and it still has real binding sites, or the ack floor would be silent.
    expect(sitesMatching(/START_ACK_STEER_TEXT/).length).toBeGreaterThanOrEqual(2);
  });
});

// ════════════════════════════════════════════════════════════════════
// §2 — THE LADDER IS BYTE-IDENTICAL THROUGH THE DOOR
// ════════════════════════════════════════════════════════════════════

describe('§2 the checkpoint opener still arms exactly as it did', () => {
  it('a REQUESTED steer arms loop-synchronously and records which loop it rode', () => {
    const { state, turnCtx } = runCheckpoint({ turnCtx: bag({ startAckSteerRequested: true }), loopCount: 4 });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(true);
    expect(turnCtx.startAckSteersInjected).toBe(1);
    expect(turnCtx.startAckSteerInjectedAtLoop).toBe(4);
    expect(fired(state).map((e) => e.floor)).toEqual(['start-ack']);
    expect(fired(state)[0].content).toBe(START_ACK_STEER_TEXT);
  });

  it('T41-B: a DELIVERED ack disarms the door — the model is not asked to say hello twice', () => {
    const { state, turnCtx } = runCheckpoint({
      turnCtx: bag({ startAckSteerRequested: true }), delivered: true,
    });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(false);
    expect(fired(state)).toEqual([]);
  });

  it('F10: a reply that landed in flight disarms it too, and the flag order is preserved', () => {
    const { state, turnCtx } = runCheckpoint({
      turnCtx: bag({ startAckSteerRequested: true }), replied: true,
    });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(false);
    expect(fired(state)).toEqual([]);
  });

  it('no request, no steer — the door does not open itself', () => {
    const { state, turnCtx } = runCheckpoint();
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(false);
    expect(fired(state)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// §3 — RUNG 2, AND ITS BOUND
// ════════════════════════════════════════════════════════════════════

describe('§3 the reminder is rung 2 of the same ladder, and it stops at two', () => {
  it('the first steer was ignored on a LATER loop → one reminder, and it reads the queue entry', () => {
    const first = runCheckpoint({ turnCtx: bag({ startAckSteerRequested: true }), loopCount: 2 });
    // Same bag, same queue, a later loop: the gate is `loopCount > steerFiredAtLoop`.
    const second = runCheckpoint({
      turnCtx: first.turnCtx,
      state: advance(first.state, { loopCount: 3 }),
    });
    expect(second.turnCtx.startAckSteersInjected).toBe(2);
    expect(fired(second.state).map((e) => e.floor)).toEqual(['start-ack', 'start-ack-reminder']);
  });

  it('NOT on the same loop the first steer rode — the model has not been asked yet', () => {
    const first = runCheckpoint({ turnCtx: bag({ startAckSteerRequested: true }), loopCount: 2 });
    const second = runCheckpoint({ turnCtx: first.turnCtx, state: first.state });
    expect(second.turnCtx.startAckSteersInjected).toBe(1);
    expect(fired(second.state).map((e) => e.floor)).toEqual(['start-ack']);
  });

  it('HARD BOUND: never a third — after the reminder the terminal reply is the only voice left', () => {
    const first = runCheckpoint({ turnCtx: bag({ startAckSteerRequested: true }), loopCount: 2 });
    const second = runCheckpoint({ turnCtx: first.turnCtx, state: advance(first.state, { loopCount: 3 }) });
    const third = runCheckpoint({ turnCtx: second.turnCtx, state: advance(second.state, { loopCount: 4 }) });
    expect(third.turnCtx.startAckSteersInjected).toBe(2);
    expect(fired(third.state).map((e) => e.floor)).toEqual(['start-ack', 'start-ack-reminder']);
  });

  it('a delivered ack silences the reminder as well as the first rung', () => {
    const first = runCheckpoint({ turnCtx: bag({ startAckSteerRequested: true }), loopCount: 2 });
    const second = runCheckpoint({
      turnCtx: first.turnCtx, state: advance(first.state, { loopCount: 3 }), delivered: true,
    });
    expect(second.turnCtx.startAckSteersInjected).toBe(1);
    expect(fired(second.state).map((e) => e.floor)).toEqual(['start-ack']);
  });
});
