// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR T41 (option A, owner ruling 2026-08-12) — THE FAST DOOR OPENS FOR A TEXTER.
//
// THE INCIDENT (owner's box, 2026-08-12 ~10:51 PM): he texted his agent a one-sentence
// question over iMessage. First tools at +18 s, a tracker nudge at +28 s, and **the only
// thing he ever received was the final answer at +3 minutes.** No acknowledgment of any kind.
//
// THE MEASURED CAUSE (W19's live reproduction at `c44e5cc`, turn 4805, floor model): the
// 30-second threshold governs when the ENGINE NOTICES, never when the PERSON HEARS. Notice
// at +30 s → steer armed at +84 s (a whole model call had to finish first) → the person's
// first word at +145 s. 4.8× the promise. On the owner's real turn the ack lost the race to
// the answer outright, because a terminal tool-less reply never passes the promotion arm.
//
// THE RULING: the pre-call door at `multistep-detection.ts` — where the steer already rides
// model call #1, so the person hears the agent's own first sentence when that call returns —
// opens for routed-channel asks too, not only for `decision.multistep`. No new constant, no
// new prose, no new mechanism: the door, the steer and the delivery all already exist.
//
// WHAT THIS FILE PINS, in both directions:
//   * the door opens where the ack can REACH the person (iMessage, SMS — and, since
//     UX-REPAIR ROUND 12 T51, Teams);
//   * it stays shut everywhere it would buy nothing — the dashboard (dots and a live
//     stream), email (no push arm exists in `deliverEngineUserAck`, so an early row would be
//     a bubble the channel never got: the F-22 shape RC-9 exists to prevent), an unknown
//     sender, an agent-flagged sender (RC-4.2), and any loop but the first;
//   * opener 1 (`decision.multistep`) is byte-identical in effect, and two open doors still
//     produce exactly ONE steer.
//
// ⚠ ONE CONTROL BELOW MOVED, AND THE OWNER MOVED IT. T51 (ruling 3, 2026-08-16) is
// "TEAMS YES, EMAIL NO". Teams was shut here for a REASON THAT WAS TRUE AT THE TIME — the ack
// had no Teams push arm — and T51 gave it one, so the clause that read "email and Teams stay
// shut" is now false about Teams and still exactly true about email. It is narrowed to email
// rather than deleted, and the ruling's own file
// (`preflight/__tests__/the-ack-reaches-teams-and-never-email.test.ts`) owns the positive
// Teams clauses and the push-arm derivation. What this file asserts is unchanged: the door
// opens where the ack can reach the person and nowhere else.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeDb = { prepare: () => emptyStmt };
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => fakeDb }));

vi.mock('../../../../../config/platform.js', () => ({
  isPMAgent: () => false,
  isHealerAgent: () => false,
  isDreamerAgent: () => false,
}));

const decision = { multistep: false, name: null as string | null, source: 'heuristic_single', heuristic: { signals: [] } };
vi.mock('../../../classifiers/multistep.js', () => ({
  getMultistepConfig: () => ({ enabled: true, model: null, baseUrl: '', timeoutMs: 5000 }),
  detectMultistep: async () => decision,
}));

const infos: Array<{ msg: string }> = [];
vi.mock('../../../../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    info: (msg: string) => { infos.push({ msg }); },
  }),
}));

import { advance, initState, type AgentTurnState } from '../../../state.js';
import { detectMultistepAndScaffold } from '../multistep-detection.js';
import { START_ACK_STEER_TEXT } from '../steer-checkpoint.js';
import type { TurnCounterparty } from '../../../counterparty.js';

const AGENT = '57b52025-0b0f-40a6-b916-9efdb9a642a3';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (rel: string): string => fs.readFileSync(path.resolve(HERE, rel), 'utf8');

interface Bag {
  startAckSteerArmedThisTurn: boolean;
  startAckSteerRequested: boolean;
  startAckSteersInjected: number;
  startAckSteerInjectedAtLoop: number | null;
  inboundClassifiedAsWork: boolean;
}
const bag = (over: Partial<Bag> = {}): Bag => ({
  startAckSteerArmedThisTurn: false,
  startAckSteerRequested: false,
  startAckSteersInjected: 0,
  startAckSteerInjectedAtLoop: null,
  inboundClassifiedAsWork: false,
  ...over,
});

const person = (over: Partial<TurnCounterparty> = {}): TurnCounterparty => ({
  kind: 'user', name: 'David', relation: 'owner', channel: 'imessage',
  senderId: '+15550000000', threadId: null, senderIsAgent: false, ...over,
} as TurnCounterparty);

/** The turn's shape at the one moment this door is asked: assemble, loop 1, a real user
 *  message in hand and the first model call still being built. */
async function assembleLoop(over: {
  counterparty?: TurnCounterparty;
  turnCtx?: Bag;
  loopCount?: number;
  delivered?: boolean;
  agentSender?: boolean;
} = {}): Promise<{ state: AgentTurnState; turnCtx: Bag }> {
  const turnCtx = over.turnCtx ?? bag();
  const state = advance(
    initState({ agentId: AGENT, maxToolLoops: 20 } as Parameters<typeof initState>[0]),
    { loopCount: over.loopCount ?? 1 },
  );
  const out = await detectMultistepAndScaffold(state, {
    agentId: AGENT,
    turnCtx: turnCtx as never,
    db: fakeDb as never,
    counterparty: over.counterparty ?? person(),
    counterpartyIsAgentSender: over.agentSender ?? false,
    lastUserMessageContent: 'Did the T-Mobile internet go down?',
    engineStartAckDeliveredThisTurn: over.delivered ?? false,
    staleTaskWindowMinutes: 45,
  });
  return { state: out, turnCtx };
}

const steers = (s: AgentTurnState): Array<{ floor: string; content: string; atLoop: number }> =>
  (s.steerQueue as unknown as { pending: Array<{ floor: string; content: string; atLoop: number }> }).pending;

beforeEach(() => { infos.length = 0; decision.multistep = false; });

describe('the door opens for the person who has no dots and no stream', () => {
  it('RED→GREEN: an iMessage ask arms the start-ack steer on model call #1, with no multistep verdict', async () => {
    const { state, turnCtx } = await assembleLoop();
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(true);
    expect(turnCtx.startAckSteersInjected).toBe(1);
    expect(turnCtx.startAckSteerInjectedAtLoop).toBe(1);
    expect(steers(state).map((s) => s.floor)).toEqual(['start-ack']);
    // The steer is the one that already exists — not a new string written for this door.
    expect(steers(state)[0].content).toBe(START_ACK_STEER_TEXT);
    expect(steers(state)[0].atLoop).toBe(1);
  });

  it('an SMS ask arms it too — the other channel the ack can actually be pushed to', async () => {
    const { turnCtx } = await assembleLoop({ counterparty: person({ channel: 'sms' }) });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(true);
  });

  it('a known contact texting counts as a person, same as the owner', async () => {
    const { turnCtx } = await assembleLoop({ counterparty: person({ relation: 'known_contact' }) });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(true);
  });

  it('the firing is on the record, so a timeline can be read off the log', async () => {
    await assembleLoop();
    expect(infos.some((i) => /start-ack steer armed pre-call/.test(i.msg))).toBe(true);
  });
});

describe('and stays shut everywhere it would buy nothing', () => {
  it('CONTROL — the dashboard is untouched: dots and a live stream already cover the wait', async () => {
    const { state, turnCtx } = await assembleLoop({ counterparty: person({ channel: 'dashboard', senderId: null }) });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(false);
    expect(steers(state)).toEqual([]);
  });

  it('CONTROL — voice is untouched for the same reason', async () => {
    const { turnCtx } = await assembleLoop({ counterparty: person({ channel: 'voice', senderId: null }) });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(false);
  });

  it('CONTROL — email stays shut: `deliverEngineUserAck` has no push arm for it, so an early row would be a bubble the channel never received (F-22) — and T51 ruled it stays that way', async () => {
    const { turnCtx } = await assembleLoop({ counterparty: person({ channel: 'email' }) });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(false);
    // The claim above is a FACT about the delivery site, not an opinion — pinned so a new
    // push arm and this door cannot drift apart.
    const closures = SRC('../../preflight/turn-closures.ts');
    const ackFn = closures.slice(closures.indexOf('const deliverEngineUserAck'));
    for (const has of ["channel === 'imessage'", "channel === 'sms'"]) expect(ackFn).toContain(has);
    expect(ackFn).not.toContain("channel === 'email'");
  });

  it('T51 — and Teams is now on the OTHER side of that same fact: it has an arm, so the door opens', async () => {
    const { turnCtx } = await assembleLoop({ counterparty: person({ channel: 'teams' }) });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(true);
  });

  it('CONTROL — RC-4.2: an agent-flagged sender never gets an ack (ack ping-pong)', async () => {
    const { turnCtx } = await assembleLoop({ agentSender: true });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(false);
  });

  it('CONTROL — an unknown texter gets nothing (the unknown-sender silence rule)', async () => {
    const { turnCtx } = await assembleLoop({ counterparty: person({ relation: 'unknown' }) });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(false);
  });

  it('CONTROL — only the FIRST loop: a continuation iteration never arms a fresh steer', async () => {
    const { state, turnCtx } = await assembleLoop({ loopCount: 3 });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(false);
    expect(steers(state)).toEqual([]);
  });

  it('CONTROL — an ack already delivered this turn closes the door', async () => {
    const { turnCtx } = await assembleLoop({ delivered: true });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(false);
  });

  it('CONTROL — a steer already armed by another site is never doubled', async () => {
    const already = bag({ startAckSteerArmedThisTurn: true, startAckSteersInjected: 1 });
    const { state } = await assembleLoop({ turnCtx: already });
    expect(steers(state)).toEqual([]);
  });
});

describe('opener 1 keeps working exactly as it did, and two doors still make one steer', () => {
  it('a multistep verdict on the DASHBOARD arms the steer, unchanged', async () => {
    decision.multistep = true;
    const { state, turnCtx } = await assembleLoop({ counterparty: person({ channel: 'dashboard', senderId: null }) });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(true);
    expect(turnCtx.startAckSteersInjected).toBe(1);
    expect(steers(state).map((s) => s.floor)).toEqual(['start-ack']);
  });

  it('a multistep verdict on iMessage — both openers true — still enqueues EXACTLY ONE steer', async () => {
    decision.multistep = true;
    const { state, turnCtx } = await assembleLoop();
    expect(steers(state)).toHaveLength(1);
    expect(turnCtx.startAckSteersInjected).toBe(1);
  });

  it('the classifier signal itself is untouched by the new door', async () => {
    decision.multistep = true;
    const { turnCtx } = await assembleLoop();
    expect(turnCtx.inboundClassifiedAsWork).toBe(true);
  });
});

describe('the rule is asked, never re-spelled', () => {
  it('the door imports the predicate; the channel list exists in ONE place', () => {
    const src = SRC('../multistep-detection.ts');
    expect(src).toContain('engineAckReachesTheirChannel');
    expect(src).not.toContain("'imessage'");
    // and the RC-9 demotion arm — the other reader of the same question — asks the same
    // declaration rather than carrying its own copy.
    const terminal = SRC('../../post-call-classify/terminal-text.ts');
    expect(terminal).toContain('isRoutedHumanCounterparty');
    expect(terminal).not.toContain("counterparty.channel === 'imessage'");
  });

  it('no threshold moved: the 30s constant is not mentioned here at all (#14)', () => {
    expect(SRC('../multistep-detection.ts')).not.toContain('ENGINE_START_ACK_AFTER_MS');
  });
});
