// The owner put five judgments on the small local decision model: simple chat, deliverable, filler, "the reply claims
// it sent something to someone else", and the summary check's "does it state something as pending". Each reaches the
// model through its real entry point when the model is installed, and falls to its rule when it is not. Every other
// question is its rule and never dials the model. The decision model is a provider row and a scripted fetch.
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
import { isConversational, deliverableJudged } from '../v2/classifiers/inbound-routing.js';
import { complexityClassifier } from '../v2/classifiers/complexity.js';
import { askReplyClaims, claimsSentToThirdParty } from '../v2/reply-claims.js';
import { settleFiller } from '../../memory/shape-judgment.js';
import { beginFillerPass, isFiller, setFillerVerdicts } from '../../vault/filler.js';
import { keepOnlyIfChecked } from '../../memory/summary-check.js';
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

const PLAN = 'Draft a five-part migration plan, then email it to the whole team and book a review.';
const PLAN_IS_SIMPLE = complexityClassifier(PLAN).complexity === 'simple';

/** Each of the five through its own entry point; `modelSays` is the opposite of its rule, and `run` is true when the
 *  model's answer was the one used. */
const FIVE: Array<{ name: string; modelSays: number; run: () => Promise<boolean> }> = [
  { name: 'simple_chat', modelSays: PLAN_IS_SIMPLE ? 0.02 : 0.97, run: async () => (await isConversational({}, agent(), PLAN)) !== PLAN_IS_SIMPLE },
  { name: 'deliverable', modelSays: 0.02, run: async () => !(await deliverableJudged(agent(), 'Here is the finished report.', true)) },
  {
    name: 'filler', modelSays: 0.02, run: async () => {
      setFillerVerdicts(new Map());
      beginFillerPass();
      expect(isFiller('sure')).toBe(true);
      await settleFiller(agent());
      beginFillerPass();
      return isFiller('sure') === false;
    },
  },
  {
    name: 'claims_sent_to_third_party', modelSays: 0.02, run: async () => {
      const at = { agentId: agent(), messageId: `msg-${n}` };
      const ctx = { ...at, result: { toolCalls: [] }, lastUserMessageContent: 'did you tell them?' };
      await askReplyClaims({ toolResults: [] } as never, ctx as never, 'I sent the invoice to the accountant.');
      return claimsSentToThirdParty(at, true) === false;
    },
  },
  {
    name: 'stated_current', modelSays: 0.97, run: async () => {
      const rewrite = vi.fn(async () => ({ ok: true as const, text: 'The owner asked for a budget.' }));
      await keepOnlyIfChecked('[USER] draft the budget', { ok: true, text: 'A budget is still owed.' }, agent(), 'writer-x', rewrite);
      return rewrite.mock.calls.length > 0;
    },
  },
];

describe('the five judgments the owner put on the decision model', () => {
  for (const { name, modelSays, run } of FIVE) {
    it(`${name}: the model answers when it is installed`, async () => {
      installDecisionModel(db());
      const calls = scriptDecisions(() => yes(modelSays));
      expect(await run()).toBe(true);
      expect(calls.length).toBeGreaterThan(0);
    });
    it(`${name}: the rule answers when no decision model is installed, and nothing is dialled`, async () => {
      const calls = scriptDecisions(() => yes(modelSays));
      expect(await run()).toBe(false);
      expect(calls).toHaveLength(0);
    });
  }
});

describe('every other question is its rule', () => {
  it('a question the owner did not put on the model never dials it, even with the model installed', async () => {
    installDecisionModel(db());
    const calls = scriptDecisions(() => yes(0.97));
    for (const q of ['inbound_routing/multi_step', 'inbound_routing/pleasantry', 'memory_shape/obligation', 'reply_claims/claims_saved', 'provider_error/error_class', 'summary_check/invented']) {
      expect(await judgment(q, { state: { message: 'x' }, questions: { asked: { type: 'noul', instructions: 'x?' } } }), q).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });
});
