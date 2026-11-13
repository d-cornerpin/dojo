// UX-REPAIR ROUND 9 / T36 — STANDING-STATE CLAIMS NEED A BOARD RECEIPT.
//
// ── THE INCIDENT (round-9 S5, on the wire) ──
// "Recap the week for me — what did you and I actually get done?" → one 1,100-character answer
// bubble, composed in 14.2 seconds with **ZERO tool calls in the entire scenario** (catalog §3,
// §9.5). Its PAST-work claims were nearly perfect — exact file names, an exact 2+4+5 = 11 file
// count, the flight fare quoted from the ticket's own result. Its claims about what is CURRENTLY
// scheduled or owed were not (catalog §9.3):
//   * "schedule intact for tomorrow"        — no 6:45 AM row exists; the only future fire on the
//                                             whole board was S3's pasta timer;
//   * "Still on deck: parking pass renewal" — no parking-pass row on the live board at all;
//   * "two fence quotes still parked, waiting on Bob's address"
//                                           — the week holds 88 such commitment rows and every
//                                             one is `abandoned`, across four different documents;
//   * "recycling out Fri 6 PM"              — the ask closed `done`, no scheduled row was ever made.
// Third sighting of the same shape (round-8 S1, round-9 S5): the model recaps MEMORY-state and
// never ROW-state, and nothing in the engine notices that it asserted the board without reading it.
//
// ── WHAT THIS SUITE PINS ──
//   * the S5 recap with zero board contact → ONE steer, naming the door that answers the question;
//   * the exemption is the RECEIPT, never the prose: a `work_update` read (or any other contact
//     with the board or the calendar this turn) exempts it, and SAYING "I checked" does not;
//   * the class is the decision model's verdict (`asserts_board_state`); with none, no steer;
//   * every bound the plan marks UNTOUCHED still bounds the floor: one steer per turn shared with
//     both sibling classes, the MAX_TOOL_LOOPS proximity skip, engine turns, non-user
//     counterparties, the engine conv key — and both sibling classes keep PRECEDENCE and their
//     byte-identical steer texts (T22's and T33's suites are the regression obligation).
//

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ToolCall } from '@dojo/shared';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-standing-state-test', 'dojo.db'),
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {} }));

// T53 (owner ruling 5): the observation point moved with the carrier. The floor used to
// write its steer to the events lane as well as the queue, and these clauses watched that
// events-lane write to read what the model was told. The floor now steers through the RC-19
// door, so the durable record is a `role='system'` row and the model-facing delivery is the
// queue entry — both carrying the SAME bytes. Watching the row keeps every assertion below
// about the steer's WORDS exactly as it was; the clause that pins the two together against
// drift is in `agent/v2/__tests__/the-second-channel-stops-double-writing.test.ts`.
const steerRowSpy = vi.fn();
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertMessageIfAbsent: (...a: unknown[]) => steerRowSpy(...(a as [])),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { enqueueSteer } from '../../../steer-queue.js';
import { judgedFloor } from './post-call-kit.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';
import { FX } from '../../../../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = 'harnessbot';
const TURN = 4723; // the S5 turn

/**
 * The S5 recap, verbatim from the round-9 catalog (§9.1, row 36c456f9, seq 61276) — markdown,
 * newlines and all, because that is exactly what reached `persistedContent`.
 */
const S5_RECAP = `Here's the week, ${FX.n11} — the bulk of it landed today:

**Today (Mon, Aug 10)**
- **Denver trip prep** — your big one: packed-for-you carry-on checklist (rain shell included, showers forecast 82–85°F days / 60–61°F nights), flight logistics (Fri 6:30 AM out of SEA, be there by 4:30), plus a 5:30 AM reminder so you're not up before it.
- **Folder cleanup** — tidied three uploads folders (desk, misc, t23-replay): 11 test-junk files deleted with your sign-off, real stuff (bio, solar summary, your notes-0812) untouched.
- **Reminders set** — daily 4:08 PM Seattle weather check (first one delivered today), vet call for Milo's meds moved to Fri 10 AM, team dinner Wed 7 PM nudging at 6, recycling out Fri 6 PM.
- **Quick asks** — Mariners: no game today (lost Sun 1–4 to Rays, 56–63); inbox: nothing new; gas at $4.10 → ~$79/mo commute; cheapest direct SEA–Chicago for Labor Day: $297 (American, Sep 3–7), unbooked.

**Earlier in the week**
- 6:45 AM weekday "routine" reminder set up (first delivery glitched; schedule intact for tomorrow).
- Memory-test padding runs (the echo batches) — done.
- Quotes: two fence quotes still parked, waiting on Bob's address.

Still on deck: parking pass renewal, and the fence quote once Bob sends his address.`;

/** The 2026-07-08 case the floor was BUILT for, verbatim from its own header. */
const EMPTY_PROMISE = 'On it. Let me pull up all your calendars.';
/** Round-8 S5's standing PROMISE — the sibling class, which keeps its own steer. */
const S5_STANDING_PROMISE =
  "Yes, I can. From now on, when a reminder fires I'll post it here first — and if you haven't "
  + 'replied within a few minutes, I\'ll text it to your phone as a backup.';

function stateWith(over: Partial<AgentTurnState> = {}): AgentTurnState {
  const base = initState({
    agentId: AGENT, contextWindow: 128_000, isAutoRouted: false,
    configuredModelId: 'test-model', turnNumber: TURN, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null,
    lastUserMessageContent: 'Recap the week for me — what did you and I actually get done?',
    lastUserMessageId: 'msg-user-1',
  } as Parameters<typeof initState>[0]);
  return advance(base, { loopCount: 2, modelId: 'test-model', ...over });
}

function ctxFor(over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: AGENT,
    turnNumber: TURN,
    db: mockDb.current,
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' } as unknown as PostCallClassifyContext['counterparty'],
    chosenConvKey: 'ck-1',
    isEngineTurn: false,
    maxToolLoops: 75,
    turnCtx: {},
    ...over,
  } as unknown as PostCallClassifyContext;
}

const scratch = (persistedContent: string): PostCallScratch => ({
  persistedContent, interAgentTurn: false, deliberateSurfaceTurn: false,
  deliveredAsStartLine: false, hasXmlFallbackTools: false, effectiveModelIdForPersist: 'test-model',
});

/** The floor on a reply the decision model judged; `says` defaults to this suite's class. */
const floor = (st: AgentTurnState, c: PostCallClassifyContext, sc: PostCallScratch, says: Parameters<typeof judgedFloor>[3] = { asserts_board_state: true }) =>
  judgedFloor(st, c, sc, says);

/** A successful tool result for `name`, the way the loop records one. */
function withToolCall(state: AgentTurnState, name: string, args: Record<string, unknown> = {}, opts: { isError?: boolean } = {}): AgentTurnState {
  const call = { id: `tc-${name}`, name, arguments: args } as ToolCall;
  return advance(state, {
    toolCalls: [call],
    toolResults: [{
      toolCallId: `tc-${name}`, name, isError: opts.isError ?? false, content: 'ok',
    } as AgentTurnState['toolResults'][number]],
  });
}

const steerText = () => (steerRowSpy.mock.calls[0][0] as { content: string }).content;

beforeEach(() => {
  vi.clearAllMocks();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'HarnessBot', 'idle', '1970-01-01')`).run(AGENT);
});

describe('T36: a reply that asserts standing state without reading the board is steered once', () => {
  it('THE S5 REPLAY: the week recap, zero tool calls → one steer', async () => {
    const out = await floor(stateWith(), ctxFor(), scratch(S5_RECAP));
    expect(out.directive, 'a recap that asserts what is scheduled and owed must not end the turn unchecked').toBe('continue');
    expect(steerRowSpy).toHaveBeenCalledTimes(1);
    expect((steerRowSpy.mock.calls[0][0] as { role: string }).role).toBe('system');
  });

  it('the steer names the door that answers the question, and never speaks to the user', async () => {
    await floor(stateWith(), ctxFor(), scratch(S5_RECAP));
    const text = steerText();
    expect(text.startsWith('[System]'), 'the floor steers the MODEL (OR2)').toBe(true);
    expect(text).toContain('work_update');
    // The standard the correction is measured against is the ROW, and the steer says which row
    // states do not count as live — otherwise "check the board" and "it is on the board" agree.
    expect(text).toMatch(/what the board actually holds/i);
    expect(text).toMatch(/abandoned, closed, or was never created/i);
    // Driven twice on the floor model: the granted round went to a blocked task the board read
    // had just surfaced, and the answer the person asked for was never corrected. The steer has
    // to bound the round to the answer it was granted for.
    expect(text).toMatch(/do not pick up new work/i);
    // Neither sibling's order is the right one here: there is no work to "do now", and the
    // problem is not that nothing was recorded — it is that nothing was READ.
    expect(text).not.toContain('Do the work NOW with tool calls and deliver the result.');
    expect(text).not.toContain('made a STANDING promise');
  });

  it('the steer quotes the first 200 characters of the reply', async () => {
    await floor(stateWith(), ctxFor(), scratch(S5_RECAP));
    const text = steerText();
    expect(text).toContain(`Here's the week, ${FX.n11}`);
    expect(text).not.toContain('schedule intact for tomorrow');
  });
});

describe('T36: the exemption is a BOARD RECEIPT, never prose', () => {
  it('a work_update list this turn exempts the recap', async () => {
    const out = await floor(
      withToolCall(stateWith(), 'work_update', { action: 'list' }), ctxFor(), scratch(S5_RECAP));
    expect(out.directive).toBe('proceed');
    expect(steerRowSpy).not.toHaveBeenCalled();
  });

  it('a work_update get on one row is a read too', async () => {
    const out = await floor(
      withToolCall(stateWith(), 'work_update', { action: 'get', task_id: 'abc' }), ctxFor(), scratch(S5_RECAP));
    expect(out.directive).toBe('proceed');
  });

  it('a calendar_agenda this turn exempts a claim about the calendar', async () => {
    const out = await floor(
      withToolCall(stateWith(), 'calendar_agenda', { days: 7 }), ctxFor(),
      scratch('The vet call is on your calendar for Friday at 10.'));
    expect(out.directive).toBe('proceed');
  });

  it('opening the row it is describing is contact with the board', async () => {
    const out = await floor(
      withToolCall(stateWith(), 'work_open', { kind: 'reminder', what: 'recycling', when: 'Fri 6pm' }),
      ctxFor(), scratch('Recycling is set for Friday 6 PM and is still on your board.'));
    expect(out.directive).toBe('proceed');
  });

  it('a FAILED board read is not a receipt, the floor still fires', async () => {
    const out = await floor(
      withToolCall(stateWith(), 'work_update', { action: 'list' }, { isError: true }), ctxFor(), scratch(S5_RECAP));
    expect(out.directive).toBe('continue');
  });

  it('a tool call that is not board contact does not exempt it', async () => {
    const out = await floor(
      withToolCall(stateWith(), 'web_search', { query: 'mariners score' }), ctxFor(), scratch(S5_RECAP));
    expect(out.directive).toBe('continue');
  });

  it('SAYING the board was checked, with no receipt anywhere, does not exempt it', async () => {
    const out = await floor(stateWith(), ctxFor(),
      scratch('I checked the tracker just now: the parking pass renewal is still on deck and the fence quotes are still parked.'));
    expect(out.directive).toBe('continue');
  });
});

describe('T36 controls: every UNTOUCHED bound still bounds the floor', () => {
  it('the forward class keeps precedence and its byte-identical steer text', async () => {
    const out = await floor(stateWith(), ctxFor(),
      scratch('Two fence quotes are still parked. Let me pull up all your calendars.'), { asserts_board_state: true, only_promises_to_start: true });
    expect(out.directive).toBe('continue');
    expect(steerText()).toContain('Do the work NOW with tool calls and deliver the result.');
  });

  it('the standing-PROMISE class keeps precedence and its own steer text', async () => {
    const out = await floor(stateWith(), ctxFor(),
      scratch(`${S5_STANDING_PROMISE} Two fence quotes are still parked.`), { asserts_board_state: true, standing_promise: true });
    expect(out.directive).toBe('continue');
    expect(steerText()).toContain('made a STANDING promise');
  });

  it('the 2026-07-08 pin is untouched: an immediate empty promise gets the original steer', async () => {
    const out = await floor(stateWith(), ctxFor(), scratch(EMPTY_PROMISE), { only_promises_to_start: true });
    expect(out.directive).toBe('continue');
    expect(steerText()).toContain('Do the work NOW with tool calls and deliver the result.');
  });

  it('ONE STEER PER TURN, shared with both siblings: a fired promise-floor steer means no second steer', async () => {
    const st = advance(stateWith(), {
      steerQueue: enqueueSteer(stateWith().steerQueue, { floor: 'promise-floor', content: 'earlier steer', atLoop: 1 }),
    });
    const out = await floor(st, ctxFor(), scratch(S5_RECAP));
    expect(out.directive).toBe('proceed');
    expect(steerRowSpy).not.toHaveBeenCalled();
  });

  it('the MAX_TOOL_LOOPS proximity skip is unchanged', async () => {
    const out = await floor(stateWith({ loopCount: 75 }), ctxFor({ maxToolLoops: 75 }), scratch(S5_RECAP));
    expect(out.directive).toBe('proceed');
  });

  it('an engine turn is never steered by this floor', async () => {
    const out = await floor(stateWith(), ctxFor({ isEngineTurn: true }), scratch(S5_RECAP));
    expect(out.directive).toBe('proceed');
  });

  it('a peer counterparty is never steered by this floor', async () => {
    const out = await floor(stateWith(), ctxFor({
      counterparty: { kind: 'agent', relation: 'peer' } as unknown as PostCallClassifyContext['counterparty'],
    }), scratch(S5_RECAP));
    expect(out.directive).toBe('proceed');
  });

  it('the engine conv key is never steered by this floor', async () => {
    const out = await floor(stateWith(), ctxFor({ chosenConvKey: 'engine' }), scratch(S5_RECAP));
    expect(out.directive).toBe('proceed');
  });

  it('an effectful action this turn exempts a standing-state claim too', async () => {
    const out = await floor(withToolCall(stateWith(), 'sms_send', { to: '+15550200' }), ctxFor(), scratch(S5_RECAP));
    expect(out.directive).toBe('proceed');
  });
});
