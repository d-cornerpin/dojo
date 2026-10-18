// ════════════════════════════════════════════════════════════════════════════════════════
// t210 (decision 37) — THE APPEND RULES, one by one, on the module itself.
// The whole-turn behaviour is `t210-post-tail-append-the-turn-only-appends.test.ts`; this file
// pins each rule's edge: when a call goes out FRESH instead, and what an appended call carries.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { appendOnlyTurn, forgetTurnArray, UPDATE_LABEL, EMPTIED_LABEL } from '../append-only-turn.js';
import { tagMessageLane } from '../../../../../memory/message-lane-tag.js';

type M = { role: 'user' | 'assistant'; content: string };
const msg = (role: M['role'], content: string, lane?: string): M => (lane ? tagMessageLane({ role, content }, lane) : { role, content });
const fits = async () => true;

/** A call's fresh array: history rows, then one-shots, then the blocks (clock last). */
function call(history: M[], oneShots: M[], blocks: Array<[string, string]>) {
  const fresh = [...history, ...oneShots, ...blocks.map(([lane, text]) => msg('user', text, lane))];
  return { fresh, volatileFrom: history.length, blocksFrom: history.length + oneShots.length };
}
const H1 = [msg('user', 'ask'), msg('assistant', 'tool call 1')];
const H2 = [...H1, msg('user', 'tool result 1')];

describe('t210 append rules', () => {
  it('call 1 goes out as built; a later call with unchanged blocks appends only the new rows and the clock', async () => {
    const turn = {};
    const c1 = call(H1, [], [['msg.active-tasks', 'TASKS A'], ['msg.current-time', 'T1']]);
    const r1 = await appendOnlyTurn({ turn, loopCount: 1, ...c1, fits });
    expect(r1.appended).toBe(false);
    expect(r1.messages).toBe(c1.fresh);
    const c2 = call(H2, [], [['msg.active-tasks', 'TASKS A'], ['msg.current-time', 'T2']]);
    const r2 = await appendOnlyTurn({ turn, loopCount: 2, ...c2, fits });
    expect(r2.appended).toBe(true);
    expect(r2.messages.slice(0, c1.fresh.length)).toEqual(c1.fresh);
    expect(r2.messages.slice(c1.fresh.length).map((m) => m.content)).toEqual(['tool result 1', `${UPDATE_LABEL}\nT2`]);
    expect(r2.volatileFrom, 'the receipt keeps the turn\'s first boundary').toBe(c1.volatileFrom);
  });

  it('a block that goes empty and comes back: a notice, then the new copy labelled as replacing', async () => {
    const turn = {};
    await appendOnlyTurn({ turn, loopCount: 1, ...call(H1, [], [['msg.events', 'EVENTS\n• one'], ['msg.current-time', 'T1']]), fits });
    const r2 = await appendOnlyTurn({ turn, loopCount: 2, ...call(H2, [], [['msg.current-time', 'T2']]), fits });
    const tail2 = r2.messages.slice(-2).map((m) => m.content);
    expect(tail2[0]).toBe(`${EMPTIED_LABEL}\nEVENTS`);
    expect(tail2[1]).toBe(`${UPDATE_LABEL}\nT2`);
    const H3 = [...H2, msg('assistant', 'tool call 2'), msg('user', 'tool result 2')];
    const r3 = await appendOnlyTurn({ turn, loopCount: 3, ...call(H3, [], [['msg.events', 'EVENTS\n• two'], ['msg.current-time', 'T3']]), fits });
    expect(r3.messages.slice(0, r2.messages.length)).toEqual(r2.messages);
    const added = r3.messages.slice(r2.messages.length).map((m) => m.content);
    expect(added).toEqual(['tool call 2', 'tool result 2', `${UPDATE_LABEL}\nEVENTS\n• two`, `${UPDATE_LABEL}\nT3`]);
  });

  it('one-shot steers of this call are always appended, never compared away', async () => {
    const turn = {};
    await appendOnlyTurn({ turn, loopCount: 1, ...call(H1, [msg('user', 'NUDGE', 'msg.pending-nudge')], [['msg.current-time', 'T1']]), fits });
    const r2 = await appendOnlyTurn({ turn, loopCount: 2, ...call(H2, [msg('user', 'NUDGE', 'msg.pending-nudge')], [['msg.current-time', 'T2']]), fits });
    expect(r2.messages.filter((m) => m.content === 'NUDGE')).toHaveLength(2);
  });

  it('goes out FRESH when the conversation region did not simply grow (a fold, a trim, a re-rendered row)', async () => {
    const turn = {};
    await appendOnlyTurn({ turn, loopCount: 1, ...call(H1, [], [['msg.current-time', 'T1']]), fits });
    const rewritten = [msg('user', 'ask (re-rendered)'), H1[1], msg('user', 'tool result 1')];
    const c2 = call(rewritten, [], [['msg.current-time', 'T2']]);
    const r2 = await appendOnlyTurn({ turn, loopCount: 2, ...c2, fits });
    expect(r2.appended).toBe(false);
    expect(r2.messages).toBe(c2.fresh);
    // ... and the NEXT call appends to that fresh one.
    const H3 = [...rewritten, msg('assistant', 'tool call 2')];
    const r3 = await appendOnlyTurn({ turn, loopCount: 3, ...call([...H3, msg('user', 'r2')], [], [['msg.current-time', 'T3']]), fits });
    expect(r3.appended).toBe(true);
    expect(r3.messages.slice(0, c2.fresh.length)).toEqual(c2.fresh);
  });

  it('goes out FRESH when the appended array does not fit the room of the model being dialed', async () => {
    const turn = {};
    await appendOnlyTurn({ turn, loopCount: 1, ...call(H1, [], [['msg.current-time', 'T1']]), fits });
    const c2 = call(H2, [], [['msg.current-time', 'T2']]);
    const r2 = await appendOnlyTurn({ turn, loopCount: 2, ...c2, fits: async () => false });
    expect(r2.appended).toBe(false);
    expect(r2.messages).toBe(c2.fresh);
  });

  it('goes out FRESH after the memo is forgotten (a retry, a fallback or a re-fit sent something else)', async () => {
    const turn = {};
    await appendOnlyTurn({ turn, loopCount: 1, ...call(H1, [], [['msg.current-time', 'T1']]), fits });
    forgetTurnArray(turn);
    const r2 = await appendOnlyTurn({ turn, loopCount: 2, ...call(H2, [], [['msg.current-time', 'T2']]), fits });
    expect(r2.appended).toBe(false);
  });

  it('never carries across turns: a new turn context, or loop 1, starts fresh', async () => {
    const turn = {};
    await appendOnlyTurn({ turn, loopCount: 1, ...call(H1, [], [['msg.current-time', 'T1']]), fits });
    expect((await appendOnlyTurn({ turn: {}, loopCount: 2, ...call(H2, [], [['msg.current-time', 'T2']]), fits })).appended).toBe(false);
    expect((await appendOnlyTurn({ turn, loopCount: 1, ...call(H2, [], [['msg.current-time', 'T2']]), fits })).appended).toBe(false);
  });

  it('a call never ends on the model\'s own message: the newest block rides last when nothing else changed', async () => {
    const turn = {};
    await appendOnlyTurn({ turn, loopCount: 1, ...call(H1, [], [['msg.current-time', 'T1']]), fits });
    const H = [...H1, msg('user', 'r1'), msg('assistant', 'thinking aloud')];
    const r2 = await appendOnlyTurn({ turn, loopCount: 2, ...call(H, [], [['msg.current-time', 'T1']]), fits });
    expect(r2.messages[r2.messages.length - 1]).toMatchObject({ role: 'user', content: `${UPDATE_LABEL}\nT1` });
  });

  it('both labels hold the t141 shape: one bracket pair, one line, no quote', () => {
    for (const label of [UPDATE_LABEL, EMPTIED_LABEL]) {
      expect(label.startsWith('[') && label.endsWith(']')).toBe(true);
      expect(label.slice(1, -1)).not.toMatch(/[[\]"\n]/);
    }
  });
});
