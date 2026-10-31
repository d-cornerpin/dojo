// v3.5 C3 — A MODEL THAT AGREES WITH THE RULE CHANGES NOTHING (t321).
//
// The choice's five words lose the rule's detail (`quota` and `permanent` share one choice, `overloaded` and
// `server` share another), and mapping the choice BACK onto a class lands every 'permanent' on `bad_request` and
// every 'retryable_transient' on `server`. The engine acts differently on `quota` (the owner must add credit) than
// on `bad_request`, so a model that said EXACTLY what the rule said was rewriting the facts. An agreeing model must
// change nothing: the rule's object comes back untouched.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { decisionAsksSettled } from '../decision-ask.js';
import { classifyProviderError } from '../provider-error.js';
import { judgeProviderError, PROVIDER_ERROR_PURPOSE } from '../provider-error-judgment.js';
import { installDecisionModel, proveChoice, scriptDecisions } from './decision-fake.js';

const db = (): Database.Database => mockDb.current!;
const choice = (name: string, confidence = 0.95): Record<string, unknown> => ({ choice: name, probabilities: { [name]: confidence }, confidence });
const judged = (text: string) => judgeProviderError(classifyProviderError(text), text, 'a1');

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); });
afterEach(async () => { await decisionAsksSettled(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('model mode: agreement keeps the rule\'s class, disagreement still stands in', () => {
  beforeEach(() => {
    installDecisionModel(db());
    proveChoice(PROVIDER_ERROR_PURPOSE, 'error_class', ['context_too_long', 'retryable_transient', 'rate_limited', 'permanent'], 'unknown');
  });

  it('out of credit: the rule says `permanent` (CHOICE_OF maps `quota` there), the model says `permanent` — the class stays `quota`', async () => {
    const text = 'The account has insufficient_quota for this request';
    const rule = classifyProviderError(text);
    expect(rule).toMatchObject({ class: 'quota', basis: 'text' });
    scriptDecisions(() => choice('permanent', 0.99));
    const out = await judgeProviderError(rule, text, 'a1');
    expect(out.facts).toBe(rule);
    expect(out.facts.class).toBe('quota');
  });

  it('a brief outage: the rule says `retryable_transient` (CHOICE_OF maps `overloaded` there), the model agrees — the class stays `overloaded`', async () => {
    const text = 'The service is overloaded, try again later';
    const rule = classifyProviderError(text);
    expect(rule).toMatchObject({ class: 'overloaded', basis: 'text' });
    scriptDecisions(() => choice('retryable_transient', 0.99));
    const out = await judgeProviderError(rule, text, 'a1');
    expect(out.facts).toBe(rule);
    expect(out.facts.class).toBe('overloaded');
  });

  it('unchanged: a DISAGREEING model still stands its class in', async () => {
    scriptDecisions(() => choice('rate_limited', 0.99));
    expect((await judged('The vendor said: please come back in a little while')).facts.class).toBe('rate_limit');
  });
});
