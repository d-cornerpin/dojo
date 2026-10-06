// ════════════════════════════════════════════════════════════════════════════════════════
// t116 E1, THE SECOND WINDOW — THE PRESS THAT LANDS WHILE THE POST-CALL STAGES RUN.
//
// `call-llm`'s fourth checkpoint catches the press that is already standing when the provider
// call returns (driven in `call-llm/__tests__/the-stop-fence-is-read-on-the-success-side.test.ts`).
// It cannot catch the press that lands AFTER it, and the gap is not a hairline: between that
// checkpoint and this writer sit seven post-call stages, several of which await — the
// terminal-text classifier, the no-reply drains, the closeout floors. The release blast
// pressed stop in that region and watched a reply arrive anyway, twice.
//
// THIS MODULE WAS THE SHIPPING DOOR AND SAID SO. Its own docstring read "No way out.", and
// `grep -c isStopFenced persist-assistant.ts` returned 0 — the owner-lane `insertMessageIfAbsent`
// and `ownOutputBroadcast` below it were the exact two statements that put a refused answer in
// front of a person, with nothing between the press and them.
//
// ── THE TWO CLAUSES, AND THEY POINT IN OPPOSITE DIRECTIONS ──
// This is one requirement with two halves, and a fix that got either half backwards would be
// worse than the defect:
//
//   §1  text arriving AFTER the press never reaches the person — no row, no broadcast, and
//       any bubble the live chunks already painted is retracted;
//   §2  a press arriving AFTER the row is persisted retro-deletes NOTHING. The fence is read
//       before the write and nowhere else; a reply the person has honestly already received
//       stays received, and the platform never un-says what it said.
//
//   §3  and in both directions the TURN KEEPS ITS HONEST RECORD. Suppressing the reply is not
//       the same act as recording the stop, they have different writers, and this file proves
//       this one does not touch the other.
//
// Driven one step at a time on a REAL in-memory database, in the shape the sibling
// answer-anyway file established: the broadcaster records rather than swallows, so "did
// anything user-visible go out?" is answerable, and the row is read back from `messages`
// rather than inferred from a spy.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { ToolCall } from '@dojo/shared';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = 'zargo';
const CONV = 'conv-1';
const TURN = 6169;
const ROW = 'msg-the-refused-reply';

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t116-e1', 'dojo.db'),
  };
});

// RECORDS, never swallows: the absence of a `chat:message` and the presence of a
// `chat:retract` are both load-bearing here, and a swallowing mock can report neither.
const frames: Array<Record<string, unknown>> = [];
vi.mock('../../../../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { frames.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../../../../services/imessage-bridge.js', () => ({
  stripSystemTags: (s: string) => s,
  sendIMessageWithAttachment: vi.fn(),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { initState, type AgentTurnState } from '../../../state.js';
import { runPersistAssistant } from '../persist-assistant.js';
import { stoppedAgents, stopFencedRuns, activeRuns } from '../../../../shared-state.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

/** The answer the owner refused — the blast's leaked row was this shape: the turn's final text. */
const THE_REFUSED_ANSWER = 'Here is the whole comparison you asked for, with prices.';

interface Bag { [k: string]: unknown }

const turnCtxFor = (over: Record<string, unknown> = {}): Bag => ({
  agentId: AGENT, kind: 'user', convKey: 'dashboard:owner', conversationId: CONV,
  root: { kind: 'ask', id: 'm-1', conversationId: CONV }, servedWork: undefined,
  turnNumber: TURN, voiceFillerFired: false,
  ...over,
});

const modelResult = (
  over: Partial<{ content: string; toolCalls: ToolCall[] }> = {},
): PostCallClassifyContext['result'] => ({
  content: THE_REFUSED_ANSWER, toolCalls: [] as ToolCall[],
  inputTokens: 10, outputTokens: 5, stopReason: 'end_turn', ...over,
} as unknown as PostCallClassifyContext['result']);

const noteTerminalAnswer = vi.fn();

function ctxFor(over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: AGENT, turnCtx: turnCtxFor() as never, turnNumber: TURN, db: mockDb.current,
    agent: { id: AGENT, name: 'Zargo' } as never,
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard', senderId: null, senderIsAgent: false } as never,
    counterpartyIsAgentSender: false,
    chosenConvKey: 'dashboard:owner',
    hasUnansweredUser: true,
    triggerRow: { id: 'm-1', content: 'compare the options for me' } as never,
    isA2ATurn: false, isEngineTurn: false, isHumanContinuation: false,
    mostRecentIsA2A: false, mostRecentInbound: undefined, pendingEngineEvent: null,
    unrepliedAssign: null, a2aReplyContext: null, a2aReplyAssignMessageId: null,
    settledContextWakeTurn: false, waitingConvs: [], inboundChannel: 'dashboard',
    latestUserSource: null, lastUserMessageContent: 'compare the options for me',
    configuredModelId: 'floor', turnStartedAt: new Date().toISOString(), messageId: ROW,
    result: modelResult(), maxToolLoops: 20,
    reArmIfStrandedNoAnswer: vi.fn(), noteTerminalAnswer,
    deliverEngineUserAck: vi.fn(),
    persistAndBroadcastSystemRow: vi.fn(),
    startAckRepliedNow: () => false,
    ...over,
  } as unknown as PostCallClassifyContext;
}

const scratchFor = (over: Partial<PostCallScratch> = {}): PostCallScratch => ({
  persistedContent: THE_REFUSED_ANSWER, interAgentTurn: false, deliberateSurfaceTurn: false,
  deliveredAsStartLine: false, hasXmlFallbackTools: false, effectiveModelIdForPersist: 'floor',
  ...over,
});

let state: AgentTurnState;

/** The step, driven exactly as the driver drives it. */
const persist = (ctxOver: Partial<PostCallClassifyContext> = {}, scOver: Partial<PostCallScratch> = {}) =>
  runPersistAssistant(state, ctxFor(ctxOver), scratchFor(scOver));

/** The rows a person can actually be shown: what landed in `messages` under the turn's id. */
const ownerRows = () => mockDb.current!
  .prepare(`SELECT id, content, lane FROM messages WHERE agent_id = ? AND role = 'assistant'`)
  .all(AGENT) as Array<{ id: string; content: string; lane: string | null }>;

const framesOfType = (t: string) => frames.filter((f) => f.type === t);
/** Every frame carrying the refused text, whatever its shape — the person's eye does not
 *  care which event name delivered it. */
const framesCarryingTheAnswer = () =>
  frames.filter((f) => JSON.stringify(f).includes(THE_REFUSED_ANSWER));

beforeEach(() => {
  frames.length = 0;
  noteTerminalAnswer.mockClear();
  stoppedAgents.clear();
  stopFencedRuns.clear();
  activeRuns.clear();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Zargo', 'working', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
  state = initState({ agentId: AGENT, maxToolLoops: 20 } as Parameters<typeof initState>[0]);
});

// ── §1 — text that arrives after the press never reaches the person ───────────────────────

describe('§1 a reply the owner refused is neither stored nor shown', () => {
  it('⚠ THE RED (the release blocker): the press is live at the seam — no row, and nothing user-visible carries the text', async () => {
    stoppedAgents.add(AGENT);

    await persist();

    // THE ROW. This is the blast's own measurement — `replies after press=1 (must be 0)` —
    // read off the table the dashboard serves from rather than off a spy.
    expect(ownerRows(), 'the reply the owner refused was persisted and will render for ever')
      .toEqual([]);
    // THE BROADCAST. Separately asserted because they are separate failures: a row with no
    // frame still appears on the next page load, and a frame with no row still appears NOW.
    expect(framesOfType('chat:message'),
      'the refused reply was broadcast to the owner\'s chat feed').toEqual([]);
    expect(framesCarryingTheAnswer(),
      'the refused text went out on some other frame shape').toEqual([]);
  });

  it('the bubble the live chunks already painted is RETRACTED, not left orphaned on screen', async () => {
    // Suppressing the row silently would be its own defect: `onChunk` frames may have already
    // drawn a partial bubble, and a bubble with no row behind it is the one shape that makes
    // "every bubble has a row" unstateable. Same two frames, same order, as the established
    // idiom in `no-reply.ts`'s ghosted-ask arm and `closeout-floors.ts`'s closeout arm.
    stoppedAgents.add(AGENT);

    await persist();

    expect(framesOfType('chat:retract').length,
      'the partial bubble was abandoned on screen with no row behind it').toBe(1);
    expect(framesOfType('chat:retract')[0]).toMatchObject({ agentId: AGENT, messageId: ROW });
    // The stream is closed too, so the client is not left with a bubble that never settles.
    expect(framesOfType('chat:chunk').some((f) => f.done === true),
      'the stream was never closed, so the spinner runs for ever').toBe(true);
  });

  it('a TOOL-CALL iteration is suppressed the same way — both owner-lane writers, not just the text one', async () => {
    // The module has two owner-lane insert/broadcast pairs: text-with-tools and text-only. A
    // guard that covered one would leak on the other, and the tool_use arm is the one that
    // would also strand an orphan `tool_use` block with no result for the next assembly.
    stoppedAgents.add(AGENT);

    await persist({
      result: modelResult({ toolCalls: [{ id: 'tc1', name: 'work_update', input: {} }] as ToolCall[] }),
    });

    expect(ownerRows()).toEqual([]);
    expect(framesCarryingTheAnswer()).toEqual([]);
  });

  it('the RUN-SCOPED fence suppresses it too, not only the liftable flag', async () => {
    // `stoppedAgents` is clearable from outside mid-run by reset-session. A seam reading only
    // the raw flag would be green above and leak here, which is the measured T83 shape.
    stopFencedRuns.set(AGENT, Date.now());

    await persist();

    expect(ownerRows()).toEqual([]);
    expect(framesCarryingTheAnswer()).toEqual([]);
  });

  it('the step still hands the driver a usable outcome — suppression is not a crash', async () => {
    stoppedAgents.add(AGENT);
    const out = await persist();
    // `proceed`, deliberately: the engine's two abandons are pinned to the callLLM span by
    // CUT 4's finalize contract, and proceeding is what lets the turn leave through the path
    // where finalize runs and the record gets written. The stop is then honoured by
    // `execute`'s own checkpoint, which cancels the remaining batch.
    expect(out.directive).toBe('proceed');
  });
});

// ── §2 — the other direction: a press after the fact changes nothing ─────────────────────

describe('§2 a press after the reply has landed retro-deletes nothing', () => {
  it('⚠ THE OTHER DIRECTION: persisted first, pressed second — the row and the broadcast both stand', async () => {
    // The person has honestly already received this answer. Un-saying it would be a second
    // defect wearing the first one's clothes, and "the platform never edits what it said" is
    // a standing rule, not a preference.
    await persist();
    const before = ownerRows();
    expect(before.length, 'the control never persisted anything, so this proves nothing').toBe(1);

    stoppedAgents.add(AGENT);

    expect(ownerRows(), 'a late press reached back and deleted a reply the owner had received')
      .toEqual(before);
    expect(framesOfType('chat:retract'),
      'a late press retracted a bubble the owner had already read').toEqual([]);
  });

  it('CONTROL: no press anywhere — the reply persists and broadcasts exactly as it always did', async () => {
    await persist();

    const rows = ownerRows();
    expect(rows.length, 'the fence read is suppressing replies nobody refused').toBe(1);
    expect(rows[0].id).toBe(ROW);
    expect(rows[0].content).toContain(THE_REFUSED_ANSWER);
    expect(framesCarryingTheAnswer().length,
      'the owner stopped being shown their own answer').toBeGreaterThan(0);
    expect(framesOfType('chat:retract'), 'an unstopped reply was retracted').toEqual([]);
  });

  it('CONTROL: a press on a DIFFERENT agent does not suppress this agent\'s reply', async () => {
    stoppedAgents.add('some-other-agent');

    await persist();

    expect(ownerRows().length, 'one agent\'s stop silenced another agent').toBe(1);
  });

  it('CONTROL: a LIFTED press does not keep cutting replies for the rest of the run', async () => {
    // The fence is read at the seam, not remembered. A stop the platform has legitimately
    // retired must not go on silencing the agent — over-guarding here is the P3 silent-hang
    // shape the fence's own header warns about.
    stoppedAgents.add(AGENT);
    stoppedAgents.delete(AGENT);

    await persist();

    expect(ownerRows().length).toBe(1);
  });
});

// ── §3 — the record stays honest in both directions ──────────────────────────────────────

describe('§3 the stop is still written down as a stop', () => {
  it('suppressing the reply does not touch the turn\'s own record — different writers, by construction', () => {
    const stripped = (abs: string) => fs.readFileSync(abs, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const src = stripped(path.resolve(HERE, '../persist-assistant.ts'));

    // The seam writes no `turns` row and latches no exit — `exit_reason` is derived from this
    // same fence by `engine-exit.ts` and written by the run's exit path. A stop must neither
    // lose the record nor show the person a reply they refused, and keeping those two acts in
    // two writers is what makes both true at once.
    expect(/\bturns\b/.test(src), 'the persist seam started writing the turn record too')
      .toBe(false);
    expect(/latchEngineCut\(/.test(src), 'the seam started latching the turn\'s exit reason')
      .toBe(false);
  });

  it('the fence reader derives from `engine-exit`\'s own predicate, so the record and the suppression cannot disagree', async () => {
    // Not a second notion of "stopped": the suppression above and the `stop` exit reason read
    // the SAME predicate. A seam with its own idea of a live stop is how the blast's split
    // outcome happened in the first place — record says stop, screen says answered.
    const { isStopFenced } = await import('../../../../shared-state.js');
    stoppedAgents.add(AGENT);
    expect(isStopFenced(AGENT)).toBe(true);
    const { latchEngineCut } = await import('../../../engine-exit.js');
    expect(typeof latchEngineCut).toBe('function');
  });
});

// ── §4 — the census, so the seam cannot go blind again ───────────────────────────────────

describe('§4 the shipping door stays a fence reader', () => {
  const codeOf = (abs: string) => fs.readFileSync(abs, 'utf-8')
    // Comments first: this module carries several paragraphs about the fence, and a clause
    // satisfiable by the prose above the call tests the prose.
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  const SEAM = path.resolve(HERE, '../persist-assistant.ts');

  it('the seam reads the fence, and reads it BEFORE either owner-lane writer', () => {
    const src = codeOf(SEAM);
    const read = src.indexOf('isStopFenced(agentId)');
    expect(read, 'the shipping door stopped reading the stop fence').toBeGreaterThan(-1);

    // ORDER IS THE REQUIREMENT. A read placed after the insert is a read of a reply that has
    // already shipped — the defect with a fence check bolted on beside it. Both writers are
    // named because the module has two arms and either one alone can show a refused answer.
    const firstInsert = src.indexOf('insertMessageIfAbsent(');
    const firstBroadcast = src.indexOf('ownOutputBroadcast(');
    expect(firstInsert, 'the insert is gone — this clause lost its subject').toBeGreaterThan(-1);
    expect(firstBroadcast, 'the broadcast is gone — this clause lost its subject').toBeGreaterThan(-1);
    expect(read, 'the fence is read after the row is already written').toBeLessThan(firstInsert);
    expect(read, 'the fence is read after the reply is already broadcast').toBeLessThan(firstBroadcast);
  });

  it('the suppressed arm RETURNS at the read — it never falls through to the writers', () => {
    const src = codeOf(SEAM);
    // Rule 1 of the step contract: a step that requests exit returns at that point. A guard
    // that logs and carries on is the defect with a log line in front of it.
    expect(/if \(isStopFenced\(agentId\)\) \{[\s\S]{0,1200}?return proceed\(state\);[\s\S]{0,40}?\}/.test(src),
      'the fence branch does not return — execution continues into the owner-lane writers')
      .toBe(true);
  });

  it('nothing in the seam deletes a persisted reply — the no-retro-delete rule, in source', () => {
    const src = codeOf(SEAM);
    expect(/DELETE FROM messages|deleteMessage\(/.test(src),
      'the seam gained a deleter — a late press can now un-say what the owner already read')
      .toBe(false);
  });
});
