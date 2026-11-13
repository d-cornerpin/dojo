// The owner put these judgments on the small local decision model, each with its own lines: yes at or above the yes
// line, no below the no line, and between them no verdict, so the caller takes the harmless action (for three questions
// its word list decides there: `in-the-unsure-band-the-word-list-decides.test.ts`). Each is driven through its real
// entry point with the decision endpoint answering scripted probabilities. With no decision model installed nothing
// is dialled and the rule (or no verdict) stands. Every other question is its rule.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import '../decision-ask.js';
import { judgment } from '../decision-hooks.js';
import { __forgetResidencyForTests } from '../decide.js';
import { inboundIsWork, deliverableJudged } from '../v2/classifiers/inbound-routing.js';
import { askReplyClaims, replyClaim, type ReplyClaim } from '../v2/reply-claims.js';
import { settleFiller } from '../../memory/shape-judgment.js';
import { beginFillerPass, isFiller, setFillerVerdicts } from '../../vault/filler.js';
import { keepOnlyIfChecked } from '../../memory/summary-check.js';
import { isObligationNote } from '../../work/obligation-memory.js';
import { declaredDeliverableShape } from '../../work/deliverable-declaration.js';
import { installDecisionModel, scriptDecisions, yes } from './decision-fake.js';

const db = (): Database.Database => mockDb.current!;
let n = 0;
const agent = (): string => `agent-${++n}`;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  __forgetResidencyForTests();
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

/** A reply's claim through its one entry point; undefined is "no verdict". */
async function replyClaimSaid(name: ReplyClaim, turnOpenedWork = false): Promise<boolean | undefined> {
  const at = { agentId: agent(), messageId: `msg-${n}` };
  const prepare = (): { get: () => unknown } => ({ get: () => (turnOpenedWork ? { 1: 1 } : undefined) });
  await askReplyClaims({ toolResults: [] } as never, { ...at, db: { prepare }, turnNumber: 3, result: { toolCalls: [] }, lastUserMessageContent: 'did you tell them?' } as never, 'I sent the invoice to the accountant.');
  return replyClaim(at, name);
}

/** The rule calls "sure" filler; the next pass reads what the model said. */
async function fillerSaid(): Promise<boolean> {
  setFillerVerdicts(new Map());
  beginFillerPass();
  isFiller('sure');
  await settleFiller(agent());
  return isFiller('sure');
}

async function summaryRewritten(): Promise<boolean> {
  const rewrite = vi.fn(async () => ({ ok: true as const, text: 'The owner asked for a budget.' }));
  await keepOnlyIfChecked({ ok: true, text: 'A budget is still owed.' }, agent(), 'writer-x', rewrite);
  return rewrite.mock.calls.length > 0;
}

const declared = async (): Promise<boolean> =>
  (await declaredDeliverableShape({ title: 'Morning update', description: 'Every day at 7am, text me what is on today.', hasSchedule: true, agentId: agent() })) !== null;

/** Each question: its entry point, then [probability the model says, what the engine does with it]. `undefined` is
 *  "between the lines". `none` is what happens with no decision model. */
const QUESTIONS: Array<{ name: string; run: () => Promise<boolean | undefined>; cases: Array<[number, boolean | undefined]>; none: boolean | undefined }> = [
  { name: 'needs_several_steps', run: () => inboundIsWork({}, agent(), 'Plan the move and book the van.'), cases: [[0.6, true], [0.2, false], [0.4, undefined]], none: undefined },
  { name: 'deliverable', run: () => deliverableJudged(agent(), 'Here is the finished report.', true), cases: [[0.6, true], [0.4, false]], none: true },
  { name: 'filler', run: fillerSaid, cases: [[0.6, true], [0.45, false]], none: true },
  { name: 'obligation', run: () => isObligationNote(agent(), 'Need to return the drill.'), cases: [[0.8, true], [0.2, false]], none: false },
  { name: 'owes_a_message', run: declared, cases: [[0.45, true], [0.35, false]], none: false },
  { name: 'stated_current', run: summaryRewritten, cases: [[0.6, true], [0.4, false]], none: false },
  { name: 'claims_sent_to_third_party', run: () => replyClaimSaid('claims_sent_to_third_party'), cases: [[0.6, true], [0.4, false]], none: undefined },
  { name: 'only_promises_to_start', run: () => replyClaimSaid('only_promises_to_start'), cases: [[0.6, true], [0.4, false]], none: undefined },
  { name: 'standing_promise', run: () => replyClaimSaid('standing_promise'), cases: [[0.8, true], [0.2, false]], none: undefined },
  { name: 'asserts_board_state', run: () => replyClaimSaid('asserts_board_state'), cases: [[0.8, true], [0.2, false]], none: undefined },
];

describe('each judgment the owner put on the decision model is answered on its own lines', () => {
  for (const { name, run, cases, none } of QUESTIONS) {
    for (const [p, expected] of cases) {
      it(`${name}: the model says ${p}, so ${expected === undefined ? 'no verdict' : expected}`, async () => {
        installDecisionModel(db());
        // Filler weighs two answers: little content and much narration is filler.
        const calls = scriptDecisions((q) => yes(q === 'content' ? 1 - p : p));
        expect(await run()).toBe(expected);
        expect(calls.length).toBeGreaterThan(0);
      });
    }
    it(`${name}: with no decision model nothing is dialled`, async () => {
      const calls = scriptDecisions(() => yes(0.97));
      expect(await run()).toBe(none);
      expect(calls).toHaveLength(0);
    });
  }
});

describe('the reply claims are one request', () => {
  it('one reply asks all four questions in a single call', async () => {
    installDecisionModel(db());
    const calls = scriptDecisions(() => yes(0.97));
    await replyClaimSaid('only_promises_to_start');
    expect(calls).toHaveLength(1);
    expect(calls[0].questions.sort()).toEqual(['asserts_board_state', 'claims_sent_to_third_party', 'only_promises_to_start', 'standing_promise']);
  });

  it('a turn that opened a work row is not asked about a standing promise', async () => {
    installDecisionModel(db());
    const calls = scriptDecisions(() => yes(0.97));
    expect(await replyClaimSaid('standing_promise', true)).toBeUndefined();
    expect(calls[0].questions).not.toContain('standing_promise');
  });
});

describe('every other question is its rule', () => {
  it('a question the owner did not put on the model never dials it, even with the model installed', async () => {
    installDecisionModel(db());
    const calls = scriptDecisions(() => yes(0.97));
    for (const q of ['inbound_routing/simple_chat', 'inbound_routing/multi_step', 'reply_claims/claims_saved', 'provider_error/error_class', 'summary_check/invented']) {
      expect(await judgment(q, { state: { message: 'x' }, questions: { asked: { type: 'noul', instructions: 'x?' } } }), q).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });
});
