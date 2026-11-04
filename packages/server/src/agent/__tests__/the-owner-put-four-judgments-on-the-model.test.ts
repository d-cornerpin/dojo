// v3.5 OWNER DECISION (v35-reconciliation.md, OWNER ANSWERS item 11): exactly four judgments are answered by the
// small local decision model in 3.5 - simple chat, deliverable, filler, and "the agent claims it sent something to
// someone else". Every other judgment stays on its rule (or in shadow). A model that is absent or answers badly
// leaves the judgment with its rule. The switch is recorded; a shipped default is never told as the owner's choice.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-owner-four', 'dojo.db'),
  };
});
const broadcast = vi.fn();
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: unknown) => broadcast(e), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import '../decision-ask.js';
import { modeFor } from '../decision-policy.js';
import { announceDecidedSwitches, switchRecord } from '../decision-switch.js';
import { deliverableJudged } from '../v2/classifiers/inbound-routing.js';
import { REPLY_CLAIM_PURPOSE, REPLY_CLAIM_QUESTIONS } from '../v2/reply-claims.js';
import { INBOUND_ROUTING_PURPOSE, INBOUND_ROUTING_QUESTION_NAMES } from '../v2/classifiers/inbound-routing.js';
import { MEMORY_SHAPE_PURPOSE, MEMORY_SHAPE_QUESTION_NAMES } from '../../memory/shape-judgment.js';
import { PROVIDER_ERROR_PURPOSE, PROVIDER_ERROR_QUESTION_NAMES } from '../provider-error-judgment.js';
import { SUMMARY_CHECK_PURPOSE, SUMMARY_CHECK_QUESTIONS } from '../../memory/summary-check-ledger.js';
import { installDecisionModel, scriptDecisions, yes } from './decision-fake.js';
import { __forgetResidencyForTests } from '../decide.js';

const db = (): Database.Database => mockDb.current!;
const ON_THE_MODEL = [
  [INBOUND_ROUTING_PURPOSE, 'simple_chat'], [INBOUND_ROUTING_PURPOSE, 'deliverable'],
  [MEMORY_SHAPE_PURPOSE, 'filler'], [REPLY_CLAIM_PURPOSE, 'claims_sent_to_third_party'],
] as const;
const everyJudgment = (): Array<[string, string]> => [
  ...INBOUND_ROUTING_QUESTION_NAMES.map((q) => [INBOUND_ROUTING_PURPOSE, q] as [string, string]),
  ...MEMORY_SHAPE_QUESTION_NAMES.map((q) => [MEMORY_SHAPE_PURPOSE, q] as [string, string]),
  ...Object.keys(REPLY_CLAIM_QUESTIONS).map((q) => [REPLY_CLAIM_PURPOSE, q] as [string, string]),
  ...PROVIDER_ERROR_QUESTION_NAMES.map((q) => [PROVIDER_ERROR_PURPOSE, q] as [string, string]),
  ...SUMMARY_CHECK_QUESTIONS.map((q) => [SUMMARY_CHECK_PURPOSE, q] as [string, string]),
];
const isOn = (p: string, q: string): boolean => ON_THE_MODEL.some(([a, b]) => a === p && b === q);

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  broadcast.mockClear();
  __forgetResidencyForTests();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; vi.unstubAllGlobals(); });

describe('the owner put exactly four judgments on the decision model', () => {
  it('with the model installed: the four answer on the model with no score yet, every other judgment does not', () => {
    installDecisionModel(db());
    for (const [p, q] of everyJudgment()) {
      expect(modeFor(p, q), `${p}/${q}`).toBe(isOn(p, q) ? 'model' : 'shadow');
    }
    expect(everyJudgment().filter(([p, q]) => modeFor(p, q) === 'model')).toHaveLength(4);
  });

  it('a 16 GB box without the model keeps every rule', () => {
    for (const [p, q] of everyJudgment()) expect(modeFor(p, q), `${p}/${q}`).toBe('rule');
  });

  it('the owner may still hold one of the four to its rule', () => {
    installDecisionModel(db());
    db().prepare("INSERT INTO config (key, value) VALUES ('decision_mode.inbound_routing.deliverable', 'rule')").run();
    expect(modeFor(INBOUND_ROUTING_PURPOSE, 'deliverable')).toBe('rule');
    expect(modeFor(INBOUND_ROUTING_PURPOSE, 'simple_chat')).toBe('model');
  });

  it('field failure 2: the four are a shipped default, so they are RECORDED silently, never told as the owner\'s choice (zero cards after an update)', () => {
    announceDecidedSwitches();
    expect(broadcast).not.toHaveBeenCalled();
    expect(switchRecord(INBOUND_ROUTING_PURPOSE, 'simple_chat')).toBeNull();
    installDecisionModel(db());
    announceDecidedSwitches();
    announceDecidedSwitches();
    for (const [p, q] of ON_THE_MODEL) expect(switchRecord(p, q)?.state, `${p}/${q}`).toBe('model');
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('the model answers the judgment; a missing or bad answer falls back to the rule', () => {
  const payload = 'Here is the finished report.';
  it('the model overrules the rule on a deliverable', async () => {
    installDecisionModel(db());
    scriptDecisions(() => yes(0.02));
    expect(await deliverableJudged('a1', 'a2', payload, true)).toBe(false);
  });
  it('the model unavailable (HTTP error): the rule answers', async () => {
    installDecisionModel(db());
    scriptDecisions(() => 'fail');
    expect(await deliverableJudged('a1', 'a2', payload, true)).toBe(true);
  });
  it('an answer in the wrong shape: the rule answers', async () => {
    installDecisionModel(db());
    scriptDecisions(() => ({ nonsense: 1 }));
    expect(await deliverableJudged('a1', 'a2', payload, true)).toBe(true);
  });
  it('no model on the box: the rule answers and nothing is dialled', async () => {
    const calls = scriptDecisions(() => yes(0.02));
    expect(await deliverableJudged('a1', 'a2', payload, true)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
