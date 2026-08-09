// ════════════════════════════════════════
// SWEEP CORE-2 item 7 — DRAFTS ARE NOT ANSWERS. Written BEFORE the module.
//
// THE OWNER'S IRRITATION, MEASURED RATHER THAN DESCRIBED (Step 0, read-only over a
// `VACUUM INTO` copy of the live body at dojo `92447af`):
//
//   3,543 turns produced at least one answer-shaped bubble (an owner-lane, plain-text
//   `role='assistant'` row — the thing the dashboard renders as a reply).
//   535 of them (15.1%) produced TWO or THREE. 542 extra bubbles in all.
//   531 of those 535 carry `turns.answer_message_id`, and in 674 of 675 stamped
//   multi-bubble turns the stamp is the LAST text row of the turn.
//   502 of the 546 extras are followed by MORE TOOL WORK in the same turn and average
//   38 characters — "On it.", "Let me research this for you.", "On it — let me check
//   the folder and data file first, then create the script."
//
// So one turn in seven puts a second answer-shaped box on the owner's screen, and the
// platform already knows — in a column, not in prose — which box was the answer.
//
// WHY THE EXISTING DEMOTION DOES NOT COVER IT. `post-call-classify/terminal-text.ts` has
// demoted mid-work narration since 2026-07-10, but only when the text rides in the SAME
// model response as a tool call. The 502 above arrived in their own TOOL-LESS iteration
// and one of the turn-ending FLOORS (`no-tool-calls.ts`) granted the model another round.
// The engine's own rule — "the user reply is ALWAYS the terminal message: a separate,
// tool-less response emitted after the work completes" — was true of them the whole time;
// nothing was in a position to say so until the turn ended.
//
// WHICH IS THE ONE FACT THIS FILE IS ABOUT: **the answer's identity is only known at turn
// END**. So the bubbles stream exactly as they always did (nothing is suppressed, nothing
// is delayed, no bubble is withheld pending a verdict), and at the boundary — after
// `finalizeTurnRecord` has stamped the key — the ones the ledger does NOT name are
// RE-CLASSIFIED into the working-note lane, row and broadcast together.
//
// THE FOUR CONSTRAINTS, each with a clause below:
//   · THE DISCRIMINATOR IS THE LEDGER KEY. `turns.answer_message_id` and nothing else.
//     No prose is read, no length is measured, no phrase list exists. NO_PROSE greps the
//     module for the mechanism it must not have.
//   · NOTHING IS DELETED AND NOTHING IS REWRITTEN. `content`, `role`, `id` and `seq` are
//     byte-identical across the re-classification. ONE column moves. That is the cache law
//     (OR7): a stored assistant row is replayed into the model prefix every later turn, so
//     editing its bytes would move the cache boundary and make the platform lie about what
//     it said.
//   · BROADCAST EQUALS ROW. Every re-classified row is ANNOUNCED on the wire, so the live
//     view and a reload agree. A silent row edit is the defect, not the fix.
//   · NO KEY, NO VERDICT. A turn that recorded no answer has nothing to compare against and
//     re-classifies nothing. Fails closed, and that arm is driven.
// ════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb: { current: Database.Database | null } = { current: null };
const broadcasts: Array<Record<string, unknown>> = [];

vi.mock('../../../../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(o.tmpdir(), 'dojo-draft-reclassify-test', 'dojo.db'),
  };
});

vi.mock('../../../../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { broadcasts.push(e); },
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessageIfAbsent } from '../../../../../memory/message-store.js';
import { reclassifyTurnDrafts } from '../draft-reclassify.js';
import { NON_ANSWERING_DISPLAY_KINDS } from '../../../../../work/ask-settlement.js';

const AGENT = 'agent-drafts';
let tmpDir: string;

const seedTurn = (turnNumber: number, answerMessageId: string | null): void => {
  mockDb.current!.prepare(
    `INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered, answer_message_id)
     VALUES (?, ?, datetime('now'), datetime('now'), ?, ?, ?)`,
  ).run(AGENT, turnNumber, answerMessageId ? 'answered' : 'no_reply_intended',
    answerMessageId ? 1 : 0, answerMessageId);
};

const rowOf = (id: string) => mockDb.current!.prepare(
  'SELECT id, role, content, display_kind, display_tier, lane, seq FROM messages WHERE id = ?',
).get(id) as { id: string; role: string; content: string; display_kind: string;
  display_tier: string; lane: string; seq: number } | undefined;

beforeEach(() => {
  broadcasts.length = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-draft-reclassify-'));
  mockDb.current = new Database(path.join(tmpDir, 'dojo.db'));
  mockDb.current.pragma('journal_mode = WAL');
  runMigrations(mockDb.current);
  mockDb.current.prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, 'Drafts', 'idle', datetime('now'))`,
  ).run(AGENT);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** The measured shape: a start line, a mid-work progress note, then the answer. */
const seedDraftingTurn = (turnNumber: number): { draftA: string; draftB: string; answer: string } => {
  const draftA = 'msg-draft-a';
  const draftB = 'msg-draft-b';
  const answer = 'msg-answer';
  insertMessageIfAbsent({ id: draftA, agentId: AGENT, role: 'assistant', turnNumber,
    content: 'On it — let me check the folder first.' });
  insertMessageIfAbsent({ id: 'msg-tool', agentId: AGENT, role: 'assistant', turnNumber,
    content: JSON.stringify([{ type: 'tool_use', id: 'tc1', name: 'exec', input: { command: 'ls' } }]) });
  insertMessageIfAbsent({ id: draftB, agentId: AGENT, role: 'assistant', turnNumber,
    content: 'Read all 7 notes; compiling the counts now.' });
  insertMessageIfAbsent({ id: answer, agentId: AGENT, role: 'assistant', turnNumber,
    content: '7 .txt files; note-07.txt is the longest at 28 lines. Codeword TRUTH-0001.' });
  return { draftA, draftB, answer };
};

describe('SWEEP CORE-2 item 7 — the turn-end draft re-classification', () => {
  it('LEDGER_KEY_IS_THE_DISCRIMINATOR: the stamped bubble stays the answer; every other one becomes a working note', () => {
    const { draftA, draftB, answer } = seedDraftingTurn(1);
    seedTurn(1, answer);

    const out = reclassifyTurnDrafts({ agentId: AGENT, turnNumber: 1 });

    expect(out.answerMessageId).toBe(answer);
    expect(out.reclassified.map((r) => r.id).sort()).toEqual([draftA, draftB].sort());
    expect(rowOf(answer)!.display_kind).toBe('agent-text');
    expect(rowOf(draftA)!.display_kind).toBe('working-note');
    expect(rowOf(draftB)!.display_kind).toBe('working-note');
  });

  it('NO_KEY_NO_VERDICT: a turn that recorded no answer re-classifies nothing (fails closed)', () => {
    const { draftA, draftB, answer } = seedDraftingTurn(2);
    seedTurn(2, null);

    const out = reclassifyTurnDrafts({ agentId: AGENT, turnNumber: 2 });

    expect(out.answerMessageId).toBeNull();
    expect(out.reclassified).toEqual([]);
    for (const id of [draftA, draftB, answer]) {
      expect(rowOf(id)!.display_kind, `${id} untouched`).toBe('agent-text');
    }
    expect(broadcasts).toEqual([]);
  });

  it('NOTHING_DELETED_NOTHING_REWRITTEN: one column moves; content, role, id and seq are byte-identical (the cache law)', () => {
    const { draftA, draftB, answer } = seedDraftingTurn(3);
    seedTurn(3, answer);
    const before = new Map([draftA, draftB, answer, 'msg-tool'].map((id) => [id, rowOf(id)!]));
    const countBefore = (mockDb.current!.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c;

    reclassifyTurnDrafts({ agentId: AGENT, turnNumber: 3 });

    const countAfter = (mockDb.current!.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c;
    expect(countAfter, 'no row is deleted and none is added').toBe(countBefore);
    for (const [id, was] of before) {
      const now = rowOf(id)!;
      expect(now.content, `${id} content byte-identical`).toBe(was.content);
      expect(now.role, `${id} role unchanged`).toBe(was.role);
      expect(now.seq, `${id} seq unchanged`).toBe(was.seq);
      expect(now.lane, `${id} lane unchanged`).toBe(was.lane);
      expect(now.display_tier, `${id} tier unchanged`).toBe(was.display_tier);
    }
  });

  it('BROADCAST_EQUALS_ROW: every re-classified row is announced exactly once, by its own id', () => {
    const { draftA, draftB, answer } = seedDraftingTurn(4);
    seedTurn(4, answer);

    const out = reclassifyTurnDrafts({ agentId: AGENT, turnNumber: 4 });

    expect(broadcasts.length).toBe(out.reclassified.length);
    for (const b of broadcasts) {
      expect(b.type).toBe('chat:workingnote');
      expect(b.agentId).toBe(AGENT);
      // A RE-CLASSIFICATION converts the row that is already there: the bubble being
      // converted and the note it becomes are ONE row, so the two ids are the same id.
      // (The pre-existing demotion path writes a NEW system row and the ids differ.)
      expect(b.noteId).toBe(b.messageId);
      expect(b.reclassified).toBe(true);
      const row = rowOf(String(b.messageId));
      expect(row, 'the announced id resolves to a row').toBeTruthy();
      expect(row!.display_kind, 'the row the wire announced really moved').toBe('working-note');
      expect(b.content, 'the wire carries what the row holds').toBe(row!.content);
    }
    expect(broadcasts.map((b) => b.messageId).sort()).toEqual([draftA, draftB].sort());
    expect(broadcasts.some((b) => b.messageId === answer), 'the answer is never announced as a note').toBe(false);
  });

  it('SCOPE: tool chips, peer traffic, the person\'s own words and other turns are never touched', () => {
    const { answer } = seedDraftingTurn(5);
    insertMessageIfAbsent({ id: 'msg-user', agentId: AGENT, role: 'user', turnNumber: 5, content: 'how many files?' });
    // ⚠ STRENGTHENED AFTER A PLANTED FAULT WALKED PAST THE FIRST VERSION, and the correction
    // is recorded rather than quietly made. F5 deleted the `lane = 'owner'` predicate and this
    // clause STAYED GREEN — because a peer row written through the normal door is classified
    // `display_kind='a2a'`, so the KIND predicate was excluding it and the lane predicate was
    // never the thing being tested. The clause was passing for the wrong reason. The lane
    // predicate exists for the shape the kind predicate cannot see: a row whose kind was
    // stamped by something other than today's classifier (a legacy insert, a repair script,
    // the `unclassified` fail-open door). So one is seeded HERE, with the kind forced, and
    // now only the lane predicate stands between it and the owner's screen.
    insertMessageIfAbsent({ id: 'msg-a2a', agentId: AGENT, role: 'assistant', lane: 'a2a', turnNumber: 5,
      content: 'peer coordination text', displayKind: 'agent-text' });
    insertMessageIfAbsent({ id: 'msg-other-turn', agentId: AGENT, role: 'assistant', turnNumber: 4,
      content: 'an earlier turn\'s reply' });
    seedTurn(5, answer);

    const out = reclassifyTurnDrafts({ agentId: AGENT, turnNumber: 5 });

    const touched = new Set(out.reclassified.map((r) => r.id));
    expect(touched.has('msg-tool'), 'a tool chip is not a draft').toBe(false);
    expect(touched.has('msg-user'), 'the person\'s own words are never re-classified').toBe(false);
    expect(touched.has('msg-a2a'), 'peer traffic is not on the owner\'s screen').toBe(false);
    expect(touched.has('msg-other-turn'), 'another turn\'s reply is not this turn\'s draft').toBe(false);
    expect(rowOf('msg-tool')!.display_kind).toBe('tool-turn');
    expect(rowOf('msg-a2a')!.display_kind, 'the lane predicate, not the kind predicate, is what holds this').toBe('agent-text');
    expect(rowOf('msg-other-turn')!.display_kind).toBe('agent-text');
  });

  it('SINGLE_BUBBLE_TURN: the ordinary turn is a no-op — nothing moves and nothing is announced', () => {
    insertMessageIfAbsent({ id: 'solo', agentId: AGENT, role: 'assistant', turnNumber: 6, content: '113.' });
    seedTurn(6, 'solo');

    const out = reclassifyTurnDrafts({ agentId: AGENT, turnNumber: 6 });

    expect(out.reclassified).toEqual([]);
    expect(broadcasts).toEqual([]);
    expect(rowOf('solo')!.display_kind).toBe('agent-text');
  });

  it('IDEMPOTENT: running the boundary twice re-classifies nothing the second time', () => {
    const { answer } = seedDraftingTurn(7);
    seedTurn(7, answer);

    const first = reclassifyTurnDrafts({ agentId: AGENT, turnNumber: 7 });
    const announcedAfterFirst = broadcasts.length;
    const second = reclassifyTurnDrafts({ agentId: AGENT, turnNumber: 7 });

    expect(first.reclassified.length).toBe(2);
    expect(second.reclassified).toEqual([]);
    expect(broadcasts.length, 'a second pass announces nothing').toBe(announcedAfterFirst);
  });

  it('A_DEMOTED_DRAFT_IS_NOT_AN_ANSWERING_DELIVERY: the settlement authority\'s own exclusion set learns the new kind', () => {
    // THE DOWNSTREAM HALF, and it is not decoration. `deliveries` records the dashboard bubble
    // for EVERY streamed reply, drafts included (PHASE-2 T5). Three settlement predicates ask
    // "is the row behind this receipt something that could have been the answer?" and they all
    // read ONE declared set — `work/ask-settlement.ts`'s `NON_ANSWERING_DISPLAY_KINDS`, which
    // held `tool-turn` alone. A bubble the platform has just demoted at the turn boundary is,
    // by the platform's OWN statement, not the answer; leaving it out of that set would let an
    // ask be closed on a receipt pointing at a working note — CT0's defect class exactly, in a
    // new spelling. It is a NARROWING of what counts as an answer, never a widening.
    expect([...NON_ANSWERING_DISPLAY_KINDS].sort()).toEqual(['tool-turn', 'working-note']);
    // ONE declaration, or the three readers can drift apart again. Nothing outside the set's
    // own module may spell a display-kind exclusion list by hand.
    const roots = ['work/ask-settlement.ts', 'work/ask-remediation.ts', 'work/occurrences.ts'];
    for (const rel of roots) {
      const src = fs.readFileSync(new URL(`../../../../../${rel}`, import.meta.url), 'utf8');
      const handRolled = src.split('\n').filter((l) => /display_kind\s+IN\s*\(\s*'/.test(l));
      expect(handRolled, `${rel} builds its exclusion list from the shared constant`).toEqual([]);
    }
  });

  it('WIRED_AFTER_THE_STAMP: the `finally` arm calls it, and AFTER the record that writes the key', () => {
    const src = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const stamp = src.indexOf('await finalizeTurnRecord(');
    const call = src.indexOf('reclassifyTurnDrafts({');
    expect(stamp, '`finalizeTurnRecord` is still called from the finally arm').toBeGreaterThan(-1);
    expect(call, 'the re-classification is wired in at all').toBeGreaterThan(-1);
    // The ORDER is the mechanism: the key does not exist until `finalizeTurnRecord` writes
    // it, so a call above that line would read NULL on every turn and silently do nothing.
    expect(call, 'the re-classification runs AFTER the stamp').toBeGreaterThan(stamp);
  });

  it('NO_PROSE: the module reads the ledger key and never the words — greppable, so it cannot drift back', () => {
    const src = fs.readFileSync(
      new URL('../draft-reclassify.ts', import.meta.url), 'utf8',
    );
    const body = src.split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n');
    expect(body, 'the key is the discriminator').toContain('answer_message_id');
    // ⚠ THIS CLAUSE WAS WRONG AS FIRST WRITTEN and the correction is recorded rather than
    // quietly made: it forbade `/\.length\s*[<>]=?\s*\d/` outright, which flags
    // `reclassified.length > 0` — COUNTING THE ROWS THAT MOVED, which every honest
    // implementation must do. A clause that reds on the correct code is not a strict clause,
    // it is a broken one. Narrowed to what it was always about: a length taken OFF THE TEXT.
    for (const forbidden of [
      /\.includes\(\s*['"`]/,               // a phrase list
      /\.match\(/, /new RegExp/,            // a prose regex
      /\.toLowerCase\(\)/, /\.toUpperCase\(\)/, // normalising text in order to compare it
      /content(\.\w+)*\.length/,            // a length threshold standing in for a judgement
      // Any comparison applied to the words themselves. Spelled as the OPERATOR next to the
      // identifier rather than "somewhere on the same line": the loose form flagged the type
      // annotation `Array<{ id: string; content: string }>`, whose `>` closes a generic.
      /\bcontent\b\s*(===|!==|==|!=|<=|>=|<|>)/,
      /(===|!==|==|!=|<=|>=|<|>)\s*\w*\.?content\b/,
      /startsWith\(/, /endsWith\(/,
    ]) {
      expect(body, `the module must not ${String(forbidden)}`).not.toMatch(forbidden);
    }
  });
});
