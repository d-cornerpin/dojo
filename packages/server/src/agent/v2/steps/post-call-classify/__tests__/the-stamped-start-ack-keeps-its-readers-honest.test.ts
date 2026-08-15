// UX-REPAIR T2 — THE STAMP'S OTHER FIVE READERS, EACH PINNED IN THE DIRECTION IT WAS RULED.
//
// Stamping `origin_intent='engine_start_ack'` on the promoted start line is not a free column
// write: five readers see the new value on an owner-lane ASSISTANT row, and W1's sitting stopped
// the task rather than change them silently. The dispositions are the plan's, and each one is a
// clause here so nobody has to take the disposition on trust.
//
//   1  `shared/visibility.ts:681`            — classifies ANY origin_intent-stamped owner-lane
//                                              assistant row `fallback`. Its comment names the
//                                              start-ack from the era when the ack WAS
//                                              engine-composed; PHASE-4 T4 made it MODEL-SPOKEN
//                                              (`turn-closures.ts`), so `agent-text` is the
//                                              truthful class today. BYPASSED at the insert by
//                                              the declared override carrier
//                                              (`NewMessage.displayKind`), not by editing the arm.
//   2  `reclassifyDraftsAsWorkingNotes`      — selects `display_kind='agent-text'`. Input kept
//                                              byte-identical by (1), so the turn-end demotion
//                                              S1 observed still demotes the ack.
//   3  the sixth narrowing                   — `mb.display_kind='agent-text'`; same, byte-identical.
//   4  `finalize/completion-ack.ts`          — `AND origin_intent IS NULL`, comment: "Engine acks
//   5  `execute/result-notes.ts`                are excluded STRUCTURALLY by their origin_intent
//                                              tag." These were WRITTEN EXPECTING THE STAMP. Their
//                                              activation is designed behaviour being restored:
//                                              a 57-char "On it —" used to count as a substantive
//                                              reply and suppress the completion machinery.
//                                              Ruled ACCEPTED, and proven here in BOTH directions.
//                                              Reader 4 could not activate in T2's sitting (its
//                                              selector was dormant — see the block above its
//                                              clauses); UX-REPAIR ROUND 2 T15 repaired the
//                                              selector and those clauses flipped, deliberately.
//                                              Both probes now share ONE predicate,
//                                              `answered-edge.ts:substantiveReplySince`.
//
// The 237 historical unstamped acks on the dev body stay unstamped — no backfill — so the probes'
// behaviour on history is unchanged by construction.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb: { current: Database.Database | null } = { current: null };
const warns: Array<{ msg: string }> = [];
const infos: Array<{ msg: string }> = [];

vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t2-stamp-readers-test', 'dojo.db'),
  };
});

vi.mock('../../../../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: (msg: string) => { infos.push({ msg }); },
    warn: (msg: string) => { warns.push({ msg }); },
    error: vi.fn(),
  }),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import {
  insertMessageIfAbsent, reclassifyDraftsAsWorkingNotes, START_ACK_ORIGIN_INTENT,
} from '../../../../../memory/message-store.js';
import { classifyMessageForDisplay } from '@dojo/shared';
import { userRequestedCloseWantsReply } from '../../execute/result-notes.js';
import { runCompletionAck } from '../../finalize/completion-ack.js';
import type { AgentTurnState } from '../../../state.js';
import type { FinalizeContext } from '../../finalize/index.js';

const AGENT = 'kevin';
const CONV = 'conv-1';
const START_ACK_INTENT = 'engine_start_ack';
const ACK_TEXT = 'On it — reading both files now.';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (rel: string): string => fs.readFileSync(path.resolve(HERE, rel), 'utf8');

const rowFor = (id: string): { display_kind: string; display_tier: string; origin_intent: string | null } =>
  mockDb.current!.prepare('SELECT display_kind, display_tier, origin_intent FROM messages WHERE id = ?')
    .get(id) as { display_kind: string; display_tier: string; origin_intent: string | null };

beforeEach(() => {
  warns.length = 0; infos.length = 0;
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
});

// ════════════════════════════════════════════════════════════════════════
// THE WRITE SITE — both facts travel, or the readers below prove nothing
// ════════════════════════════════════════════════════════════════════════

describe('the promotion call carries BOTH the stamp and the explicit display kind', () => {
  it('terminal-text.ts passes the start-ack intent and an explicit agent-text kind', () => {
    const src = SRC('../terminal-text.ts');
    const call = /await deliverEngineUserAck\(([^;]*?)\);/s.exec(src)?.[1] ?? '';
    expect(call, 'the promotion call').toContain('START_ACK_ORIGIN_INTENT');
    expect(call, 'the promotion call').toContain("'agent-text'");
    // The knowledge was in-process at this instant all along: the flag is set BEFORE the call.
    expect(src.indexOf('engineStartAckDeliveredThisTurn = true'))
      .toBeLessThan(src.indexOf('await deliverEngineUserAck('));
  });

  it('the writer and the authority read ONE constant, so they cannot drift apart', () => {
    expect(START_ACK_ORIGIN_INTENT).toBe(START_ACK_INTENT);
    // Neither side spells the value itself: both import it.
    for (const rel of ['../terminal-text.ts', '../../../../../work/ask-settlement.ts']) {
      const src = SRC(rel);
      expect(src, rel).toContain('START_ACK_ORIGIN_INTENT');
      expect(src.replace(/START_ACK_ORIGIN_INTENT/g, ''), `${rel} has no second spelling`)
        .not.toContain(`'${START_ACK_INTENT}'`);
    }
  });

  it('the seventh narrowing is applied by the authority evidence predicate', () => {
    const src = SRC('../../../../../work/ask-settlement.ts');
    const fn = /function qualifyingDelivery\([\s\S]*?\n}/.exec(src)?.[0] ?? '';
    expect(fn, 'qualifyingDelivery').toContain('NOT_A_START_ACK');
  });
});

// ════════════════════════════════════════════════════════════════════════
// READER 6 — FOUND IN THIS SITTING'S SWEEP, NOT IN W1's. It does not change, and here is why.
// ════════════════════════════════════════════════════════════════════════

// `startAckRepliedNow` (`preflight/start-ack.ts`) asks "has the person heard anything from the
// agent this turn?" with `AND origin_intent IS NULL` in its predicate, so a stamped ack stops
// satisfying it. That is a behaviour change in the READ — and the plan's STOP condition is
// about a change in BEHAVIOUR, so the question is whether any caller can reach the read on a
// turn where the stamp exists. All four cannot: every one of them is short-circuited first by
// a flag that the promotion sets in the same block, BEFORE the row is written. Pinned as
// source conformance rather than argued, so a future re-ordering has to meet this clause.
describe('reader 6: the F10 replied-check is unreachable on a turn that promoted a start line', () => {
  const guardsBefore = (src: string, marker: string): string =>
    src.slice(0, src.indexOf(marker));

  it('start-ack.ts: the ack-owed gate tests the delivered flag BEFORE the query', () => {
    const src = SRC('../../preflight/start-ack.ts');
    const gate = /if \(turnCtx\.engineStartAckDeliveredThisTurn[^\n]*startAckRepliedNow\(\)\) return;/
      .exec(src)?.[0] ?? '';
    expect(gate, 'the fireStartAckIfOwed gate').toBeTruthy();
    expect(guardsBefore(gate, 'startAckRepliedNow()'))
      .toContain('turnCtx.engineStartAckDeliveredThisTurn');
  });

  // UX-REPAIR T41 (option B, owner ruling 2026-08-12) MOVED THE FIRST CLAUSE OF THIS GUARD
  // and this clause moved with it, deliberately. The window the promotion opens on is now
  // OWED (`armed || requested`) rather than ARMED — a whole model call sits between those
  // two flags and the owner's incident happened inside it. What this clause asserts is
  // UNCHANGED and is the only thing it ever asserted: whatever opens the guard, the
  // delivered flag is tested BEFORE `startAckRepliedNow()`, so the F10 replied-check (whose
  // `origin_intent IS NULL` predicate a stamped ack no longer satisfies) is unreachable on a
  // turn that promoted a start line.
  it('terminal-text.ts: the promotion guard tests the delivered flag BEFORE the query', () => {
    const src = SRC('../terminal-text.ts');
    const guard = /\(turnCtx\.startAckSteerArmedThisTurn \|\| turnCtx\.startAckSteerRequested\)[\s\S]*?!startAckRepliedNow\(\)/
      .exec(src)?.[0] ?? '';
    expect(guard, 'the promotion guard').toBeTruthy();
    expect(guardsBefore(guard, '!startAckRepliedNow()'))
      .toContain('!turnCtx.engineStartAckDeliveredThisTurn');
  });

  // ⚠ HL4 STEP 2 (2e), MERGER 1 — THE GUARD'S TARGET MOVED, SO THE GUARD MOVES WITH IT.
  // The ack ladder left `assemble/steer-checkpoint.ts` for `assemble/start-ack-door.ts`,
  // which now owns the text, the arming and the reminder rung for BOTH openers. This clause
  // asserts exactly what it always asserted — a delivered/armed flag is tested BEFORE
  // `startAckRepliedNow()`, so the F10 replied-check is unreachable on a turn that promoted
  // a start line — and it now asserts one thing MORE, because the merger introduced an
  // indirection this guard has to see through: `startAckDoorOpen` must really BE the two
  // flag tests, or moving them behind a helper would hollow the guard out while it passed.
  it('start-ack-door.ts: both steer arms test a delivered/armed flag BEFORE the query', () => {
    const src = SRC('../../assemble/start-ack-door.ts');

    // The shared gate is the two flags and nothing weaker.
    const shared = /export function startAckDoorOpen\([\s\S]*?\n}/.exec(src)?.[0] ?? '';
    expect(shared, 'the shared half of the door gate').toBeTruthy();
    expect(shared).toContain('!turnCtx.startAckSteerArmedThisTurn');
    expect(shared).toContain('!engineStartAckDeliveredThisTurn');

    const first = /if \(turnCtx\.startAckSteerRequested[\s\S]*?!startAckRepliedNow\(\)\) \{/.exec(src)?.[0] ?? '';
    expect(first, 'the request opener').toBeTruthy();
    expect(guardsBefore(first, '!startAckRepliedNow()'))
      .toContain('startAckDoorOpen(turnCtx, engineStartAckDeliveredThisTurn)');
    const reminder = /turnCtx\.startAckSteersInjected === 1 &&[\s\S]*?!startAckRepliedNow\(\)/.exec(src)?.[0] ?? '';
    expect(reminder, 'the reminder rung').toBeTruthy();
    expect(guardsBefore(reminder, '!startAckRepliedNow()'))
      .toContain('!engineStartAckDeliveredThisTurn');
  });
});

// ════════════════════════════════════════════════════════════════════════
// READERS 1-3 — DISPLAY. Byte-identical inputs, because the write overrides the classifier.
// ════════════════════════════════════════════════════════════════════════

describe('readers 1-3: the stamped ack still reads, and still demotes, as the agent', () => {
  it('at INSERT the stamped ack is agent-text / user-visible, exactly as an unstamped bubble', () => {
    insertMessageIfAbsent({
      id: 'ack', agentId: AGENT, role: 'assistant', content: ACK_TEXT, lane: 'owner',
      conversationId: CONV, turnNumber: 4,
      originIntent: START_ACK_INTENT, displayKind: 'agent-text',
    } as never);
    insertMessageIfAbsent({
      id: 'plain', agentId: AGENT, role: 'assistant', content: 'A tool-less draft line.',
      lane: 'owner', conversationId: CONV, turnNumber: 4,
    } as never);
    expect(rowFor('ack')).toEqual({
      display_kind: 'agent-text', display_tier: 'user-visible', origin_intent: START_ACK_INTENT,
    });
    expect(rowFor('plain').display_kind).toBe(rowFor('ack').display_kind);
  });

  it('at TURN END the ack is demoted to working-note, the same as S1 observed', () => {
    insertMessageIfAbsent({
      id: 'ack', agentId: AGENT, role: 'assistant', content: ACK_TEXT, lane: 'owner',
      conversationId: CONV, turnNumber: 4,
      originIntent: START_ACK_INTENT, displayKind: 'agent-text',
    } as never);
    insertMessageIfAbsent({
      id: 'answer', agentId: AGENT, role: 'assistant', content: 'Done — t2b.txt was longer.',
      lane: 'owner', conversationId: CONV, turnNumber: 4,
    } as never);
    const moved = reclassifyDraftsAsWorkingNotes({ agentId: AGENT, turnNumber: 4, answerMessageId: 'answer' });
    expect(moved.map((m) => m.id)).toEqual(['ack']);
    expect(rowFor('ack').display_kind).toBe('working-note');
    expect(rowFor('answer').display_kind).toBe('agent-text');
  });

  it('CONTROL — the fallback arm LIVES: another origin_intent still classifies fallback', () => {
    // The arm is not edited and not disarmed. It is BYPASSED for this one writer, by that
    // writer declaring the kind it means. Every other stamped intent classifies as before.
    for (const intent of ['pm_rename', 'thrash_notice', 'cross_conv_send_echo']) {
      expect(classifyMessageForDisplay({
        role: 'assistant', content: 'some engine-composed line', lane: 'owner', originIntent: intent,
      })).toEqual({ tier: 'user-visible', kind: 'fallback' });
    }
    // …including the start-ack intent, when nobody overrides it. The classifier is untouched.
    expect(classifyMessageForDisplay({
      role: 'assistant', content: ACK_TEXT, lane: 'owner', originIntent: START_ACK_INTENT,
    })).toEqual({ tier: 'user-visible', kind: 'fallback' });
  });
});

// ════════════════════════════════════════════════════════════════════════
// READERS 4-5 — THE PROBES, ACTIVATED AS DESIGNED, PROVEN IN BOTH DIRECTIONS
// ════════════════════════════════════════════════════════════════════════

/** An engine-scaffolded task with NO birthing ask, so the probe falls through to the
 *  `length(trim(content)) > 40` adjacency read that both readers share. */
function scaffoldTask(id: string, openedAtMs: number): void {
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, opened_at, updated_at)
     VALUES (?, 'task', ?, 'agent', 'engine_scaffold', ?, 'open', 'tracker', 0, 0, 'the work', ?, ?)`,
  ).run(id, AGENT, id, openedAtMs, openedAtMs);
}

function assistantRow(id: string, content: string, atMs: number, originIntent: string | null): void {
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, display_kind, display_tier,
                           origin_intent, conversation_id, turn_number, created_at)
     VALUES (?, ?, 'assistant', ?, 'owner', 'agent-text', 'user-visible', ?, ?, 4, ?)`,
  ).run(id, AGENT, content, originIntent, CONV, atMs);
}

const STAMPED_ACK = 'On it — pulling current HubSpot pricing to finish the comparison.';
const REAL_ANSWER = 'Pipedrive is the better fit for three people: cheaper per seat and simpler to run.';

// The three clauses under each probe are a DIRECTION PAIR plus the history control, not a RED:
// the fixture rows carry the stamp the fix writes, so the reader answers the new value here
// whether or not the writer has landed. What makes the flip visible is the third clause — the
// same text, the same length, no stamp — which is the shape the 237 historical rows have.
describe('reader 5: the close-note steer stops being suppressed by an "On it"', () => {
  it('ACTIVATED — a turn whose only bubble is the STAMPED ack still owes the person a reply', () => {
    const t = Date.now() - 60_000;
    scaffoldTask('task-1', t);
    assistantRow('ack', STAMPED_ACK, t + 1000, START_ACK_INTENT);
    expect(STAMPED_ACK.trim().length).toBeGreaterThan(40);   // it clears the probe's own threshold
    expect(userRequestedCloseWantsReply('work_update', { action: 'status', task_id: 'task-1' }, AGENT))
      .toBe(true);
  });

  it('CONTROL — a REAL answer satisfies the probe and the machinery stays quiet', () => {
    const t = Date.now() - 60_000;
    scaffoldTask('task-1', t);
    assistantRow('ack', STAMPED_ACK, t + 1000, START_ACK_INTENT);
    assistantRow('answer', REAL_ANSWER, t + 2000, null);
    expect(userRequestedCloseWantsReply('work_update', { action: 'status', task_id: 'task-1' }, AGENT))
      .toBe(false);
  });

  it('CONTROL — the 237 unstamped historical acks are unaffected: no stamp, no change', () => {
    const t = Date.now() - 60_000;
    scaffoldTask('task-1', t);
    assistantRow('ack', STAMPED_ACK, t + 1000, null);        // history: origin_intent NULL
    expect(userRequestedCloseWantsReply('work_update', { action: 'status', task_id: 'task-1' }, AGENT))
      .toBe(false);
  });
});

describe('reader 4: the completion detection engages — and still composes NOTHING (OR2)', () => {
  const finalizeCtx = (turnStartedAt: string): FinalizeContext => ({
    agentId: AGENT, turnNumber: 4, db: mockDb.current!,
    counterparty: { kind: 'user' }, counterpartyIsAgentSender: false, turnStartedAt,
  } as unknown as FinalizeContext);
  const turnState = (): AgentTurnState => ({
    lastAssistantTextForIM: null, surfacedReplyThisTurn: false, explicitSendThisTurn: {},
    steerQueue: { pending: [], fired: [] },
  } as unknown as AgentTurnState);

  /** A scaffold task CLOSED during this turn — the input the detection reads. The upheld
   *  adjudication (the two-key trigger) and the receipt (migration 135's `done means DELIVERED`
   *  CHECK) are the schema's own conditions for a closed row; this fixture honours both rather
   *  than working around them. */
  function completedScaffold(id: string, openedAtMs: number, closedAtMs: number): void {
    scaffoldTask(id, openedAtMs);
    mockDb.current!.prepare(
      `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at)
       VALUES (?, 'done', 'upheld', 'pm', ?)`,
    ).run(id, Date.now());
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id,
                               outcome, created_at)
       VALUES (?, ?, 4, 'dashboard', 'dashboard', ?, 'delivered', datetime('now'))`,
    ).run(`d-${id}`, AGENT, CONV);
    mockDb.current!.prepare(
      `UPDATE work SET state='done', closed_at=?, result_delivery_id=? WHERE id=?`,
    ).run(closedAtMs, `d-${id}`, id);
  }

  // ⚠ THE PIN THIS SITTING WROTE, AND THE FLIP IT WAS WRITTEN FOR — UX-REPAIR ROUND 2, T15.
  //
  // T2's sitting measured reader 4's activation as LATENT and pinned it rather than fixing it:
  // one line ABOVE the `origin_intent IS NULL` probe, the detection's scaffold selector bounded
  // an INTEGER epoch-ms column with the TEXT `turnStartedAt` —
  //
  //     AND t.closed_at >= ?          .all(agentId, turnStartedAt)
  //
  // — and in SQLite every INTEGER sorts BELOW every TEXT, so the comparison was false for every
  // row that existed. Measured then on the live body (`~/.dojo/data/dojo.db`, read-only):
  //     closed_at >= '2026-01-01 00:00:00'   -> 0 engine-scaffold done tasks
  //     closed_at >= 1767225600000           -> 25
  // The stamp reached a probe nothing could reach. The pin's own words were: *"pinned here so a
  // future repair of the selector cannot land without meeting the stamp"*.
  //
  // T15 IS THAT REPAIR, and this is the pin doing its job: the second clause below used to
  // assert that the stamp changed NOTHING, and it now asserts the opposite in both directions.
  // The change is deliberate, argued in the plan (T15's intent inventory: "the T2R dormancy-pin
  // test FLIPS consciously — that is what the pin is for"), and the full behavioural proof lives
  // with the repair, in `finalize/__tests__/the-completion-ack-probe-lives-again.test.ts`. What
  // stays here is reader 4's disposition, because this file is the record of what the STAMP did
  // to each of its readers: the activation T2 could only rule for, observed.
  it('the selector reads the column\'s own type now — the ms bound, in production', () => {
    const t = Date.now() - 60_000;
    const turnStartedAt = new Date(t).toISOString().slice(0, 19).replace('T', ' ');
    completedScaffold('task-1', t, Date.now());
    const sel = (bound: string | number): number => (mockDb.current!.prepare(
      `SELECT count(*) c FROM work t WHERE t.root_kind='engine_scaffold' AND t.kind='task'
         AND t.agent_id = ? AND t.state = 'done' AND t.closed_at >= ? AND t.repeat_interval IS NULL`,
    ).get(AGENT, bound) as { c: number }).c;
    // The measurement that named the defect, kept: this is why the TEXT bound had to go.
    expect(sel(turnStartedAt), 'the bound production used to pass').toBe(0);
    expect(sel(t), 'the same instant as epoch ms').toBe(1);
    // And the source no longer passes the text form or round-trips it.
    const src = SRC('../../finalize/completion-ack.ts');
    expect(src, 'the selector is bound with ms').toContain('turnStartedAtMs');
    expect(src, 'and nothing converts an instant on this path').not.toContain('unixepoch(');
  });

  it('ACTIVATED — the stamp decides it: a stamped ack fires the detection, a real answer quiets it', () => {
    for (const [stamp, expectFire] of [[START_ACK_INTENT, true], [null, false]] as const) {
      warns.length = 0; infos.length = 0;
      const t = Date.now() - 60_000;
      const turnStartedAt = new Date(t).toISOString().slice(0, 19).replace('T', ' ');
      completedScaffold(`task-${stamp}`, t, Date.now());
      assistantRow(`ack-${stamp}`, STAMPED_ACK, t + 1000, stamp);
      const before = (mockDb.current!.prepare('SELECT count(*) c FROM messages').get() as { c: number }).c;

      expect(runCompletionAck(turnState(), finalizeCtx(turnStartedAt))).toBe(false);

      // Stamped: the engine ack is not an answer, so the person is still owed and the
      // detection says so. Unstamped (the 237 historical rows): unchanged, still read as an
      // answer, still deduped.
      expect(warns.some((w) => /NO user-facing reply/.test(w.msg)), `stamp=${stamp}`).toBe(expectFire);
      expect(infos.some((i) => /completion ack skipped/.test(i.msg)), `stamp=${stamp}`).toBe(!expectFire);
      // OR2 is unmoved by the activation: the engine detects, it does not speak.
      expect((mockDb.current!.prepare('SELECT count(*) c FROM messages').get() as { c: number }).c)
        .toBe(before);
    }
  });
});
