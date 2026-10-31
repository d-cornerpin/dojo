// v3.5 C3 — THE PROVIDER ERROR'S CLASS ASKS THE DECISION MODEL ALONGSIDE THE RULES (spec item 42).
//
// Where the provider's own answer (status, structured body, transport code) settled the class, nothing is asked
// (the exact-match fast path). Where the error's WORDS were all there was, the decision model is asked one `choice`
// (retryable_transient / auth / context_too_long / rate_limited / permanent). `rule` and `shadow`: the rule's
// class, unchanged, both logged. `model`: the choice stands in outside its weak band and, a class being able to lock
// an agent, only when clearly beyond it. The decision model is never real: a provider row and a scripted fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { decisionAsksSettled } from '../decision-ask.js';
import { classifyProviderError, classifyProviderErrorText } from '../provider-error.js';
import { judgeProviderError, PROVIDER_ERROR_PURPOSE } from '../provider-error-judgment.js';
import { modeFor } from '../decision-policy.js';
import { installDecisionModel, proveChoice, scriptDecisions } from './decision-fake.js';

const db = (): Database.Database => mockDb.current!;
const OVERLONG = 'The model rejected the request: the conversation is 204015 tokens, over the 200000 it can read';
const choice = (name: string, confidence = 0.95): Record<string, unknown> => ({ choice: name, probabilities: { [name]: confidence }, confidence });
const shadow = (): Array<{ rule_said: string; model_said: string }> =>
  db().prepare('SELECT rule_said, model_said FROM decision_shadow WHERE purpose = ?').all(PROVIDER_ERROR_PURPOSE) as never;
const judged = (text: string) => judgeProviderError(classifyProviderError(text), text, 'a1');

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); });
afterEach(async () => { await decisionAsksSettled(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('no decision model, or the provider answered: nothing is asked', () => {
  it('no decision model: the rule\'s facts come back untouched', async () => {
    const calls = scriptDecisions(() => choice('auth'));
    const rule = classifyProviderError(OVERLONG);
    expect((await judgeProviderError(rule, OVERLONG, 'a1')).facts).toBe(rule);
    expect(calls).toHaveLength(0);
  });

  it('the exact-match fast path: a status, a structured body or a transport code settles the class and is never asked', async () => {
    installDecisionModel(db());
    const calls = scriptDecisions(() => choice('permanent'));
    const byStatus = classifyProviderError({ status: 401, message: 'prompt is too long: 204015 tokens' });
    const byTransport = classifyProviderError({ code: 'ECONNREFUSED', message: 'fetch failed' });
    expect(byStatus).toMatchObject({ class: 'auth', basis: 'status' });
    expect((await judgeProviderError(byStatus, 'prompt is too long', 'a1')).facts).toBe(byStatus);
    expect((await judgeProviderError(byTransport, 'fetch failed', 'a1')).facts).toBe(byTransport);
    await decisionAsksSettled();
    expect(calls).toHaveLength(0);
  });
});

describe('shadow: the rule\'s class stands, the choice is logged beside it', () => {
  beforeEach(() => { installDecisionModel(db()); });

  it('words only: asked once, logged with the rule\'s class in the choice\'s vocabulary, and the facts are unchanged', async () => {
    expect(modeFor(PROVIDER_ERROR_PURPOSE, 'error_class')).toBe('shadow');
    const calls = scriptDecisions(() => choice('context_too_long'));
    const rule = classifyProviderError(OVERLONG);
    expect(rule.basis).not.toBe('status');
    const out = await judgeProviderError(rule, OVERLONG, 'a1');
    expect(out.facts).toBe(rule);
    await decisionAsksSettled();
    expect(calls).toHaveLength(1);
    expect(calls[0].questions).toEqual(['error_class']);
    expect(shadow().map((r) => [r.rule_said, JSON.parse(r.model_said).choice])).toEqual([[JSON.stringify(out.choice), 'context_too_long']]);
  });

  it('a decision model that is down changes nothing', async () => {
    scriptDecisions(() => 'fail');
    const rule = classifyProviderError(OVERLONG);
    expect((await judgeProviderError(rule, OVERLONG, 'a1')).facts).toBe(rule);
  });
});

describe('model mode (proven on measured accuracy)', () => {
  beforeEach(() => {
    installDecisionModel(db());
    proveChoice(PROVIDER_ERROR_PURPOSE, 'error_class', ['context_too_long', 'retryable_transient', 'rate_limited'], 'unknown');
  });

  it('is on', () => { expect(modeFor(PROVIDER_ERROR_PURPOSE, 'error_class')).toBe('model'); });

  it('"prompt is too long" is `context_too_long`: a request that fails the same way forever, not an auth failure and not a retry', async () => {
    scriptDecisions(() => choice('context_too_long', 0.95));
    const out = await judged(OVERLONG);
    expect(out.choice).toBe('context_too_long');
    expect(out.facts).toMatchObject({ class: 'bad_request', basis: 'text' });
  });

  it('the other choices land on the classes the engine already acts on', async () => {
    const text = 'The vendor said: please come back in a little while';   // words with no rule
    for (const [said, cls] of [['rate_limited', 'rate_limit'], ['retryable_transient', 'server'], ['auth', 'auth'], ['permanent', 'bad_request']] as const) {
      scriptDecisions(() => choice(said, 0.99));
      expect((await judged(text)).facts.class).toBe(cls);
    }
  });

  it('inside the weak band, or not clearly beyond it, the rule\'s class stands', async () => {
    const rule = classifyProviderError(OVERLONG);
    scriptDecisions(() => choice('context_too_long', 0.35));              // the weak decile
    expect((await judgeProviderError(rule, OVERLONG, 'a1')).facts).toBe(rule);
    scriptDecisions(() => choice('auth', 0.38));                          // not beyond the band's top (0.4): strict
    expect((await judgeProviderError(rule, OVERLONG, 'a1')).facts).toBe(rule);
  });

  it('a decision model that fails leaves the rule\'s class', async () => {
    scriptDecisions(() => 'fail');
    const rule = classifyProviderError(OVERLONG);
    expect((await judgeProviderError(rule, OVERLONG, 'a1')).facts).toBe(rule);
  });
});

describe('the recovery cascade reads the class through the seam', () => {
  it('`recoverFromError` computes its facts with `judgeProviderError` over the error text', () => {
    const src = readFileSync(fileURLToPath(new URL('../v2/recovery.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/await \(await import\('\.\.\/provider-error-judgment\.js'\)\)\.judgeProviderError\([^\n]*\n\s+error instanceof AgentError && error\.provider \? error\.provider : classifyProviderError\(error\), fullErrText, agentId\)\)\.facts/);
  });
  it('the rule itself is untouched: the words still classify as they did', () => {
    expect(classifyProviderErrorText('429 Too Many Requests').class).toBe('rate_limit');
  });
});
