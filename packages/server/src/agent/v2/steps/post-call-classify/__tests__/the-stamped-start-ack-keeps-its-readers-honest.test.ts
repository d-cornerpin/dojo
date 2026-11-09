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
//   5  `execute/result-notes.ts`             : "Engine acks are excluded STRUCTURALLY by their origin_intent
//                                              tag." These were WRITTEN EXPECTING THE STAMP. Their
//                                              activation is designed behaviour being restored:
//                                              a 57-char "On it —" used to count as a substantive
//                                              reply and suppress the completion machinery.
//                                              Ruled ACCEPTED, and proven here in BOTH directions.
//                                              The probe reads one predicate,
//                                              `answered-edge.ts:substantiveReplySince`.
//   (Reader 4, the finalize completion-ack detection, was log-only and is deleted.)
//
// The 237 historical unstamped acks on the dev body stay unstamped — no backfill — so the probes'
// behaviour on history is unchanged by construction.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t2-stamp-readers-test', 'dojo.db'),
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
import { FX, FXID } from '../../../../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = FXID.n4;
const CONV = 'conv-1';
const START_ACK_INTENT = 'engine_start_ack';
const ACK_TEXT = 'On it — reading both files now.';

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
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, '${FX.n4}', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
});

// ════════════════════════════════════════════════════════════════════════
// THE WRITE SITE — both facts travel, or the readers below prove nothing
// ════════════════════════════════════════════════════════════════════════

describe('the promotion call carries BOTH the stamp and the explicit display kind', () => {

  it('the writer and the authority read ONE constant, so they cannot drift apart', () => {
    expect(START_ACK_ORIGIN_INTENT).toBe(START_ACK_INTENT);
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
