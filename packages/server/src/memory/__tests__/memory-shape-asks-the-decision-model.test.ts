// v3.5 C3 — MEMORY SHAPE ASKS THE DECISION MODEL ALONGSIDE ITS RULES (spec A19–A22).
//
// A19 standing instruction + prose shape and A20 obligation (the vault_remember writer guard), A21 filler (the Dreamer's
// triage), A22 "is this span worth a summary" (the nightly rebuild). In `rule` and `shadow` mode each returns its rule's
// answer unchanged and the model's is logged beside it; in `model` mode the verdict stands in outside the question's
// weak band. The credential gate is a safety gate and never asks. The decision model is never real: a provider row
// and a scripted fetch.
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
vi.mock('../embeddings.js', () => ({ generateEmbedding: vi.fn(async () => new Float32Array(8)), queueEmbedding: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { decisionAsksSettled } from '../../agent/decision-ask.js';
import { entryShape, settleFiller, spanWorthJudged, MEMORY_SHAPE_PURPOSE } from '../shape-judgment.js';
import { beginFillerPass, isFiller, takeFillerCandidates, setFillerVerdicts } from '../../vault/filler.js';
import { executeVaultRemember } from '../../vault/tools.js';
import { modeFor } from '../../agent/decision-policy.js';
import { installDecisionModel, proveNoul, scriptDecisions, yes } from '../../agent/__tests__/decision-fake.js';

const db = (): Database.Database => mockDb.current!;
const rows = (q?: string): Array<{ question: string; rule_said: string; model_said: string }> =>
  db().prepare(`SELECT question, rule_said, model_said FROM decision_shadow WHERE purpose = ? ${q ? 'AND question = ?' : ''} ORDER BY id`)
    .all(...(q ? [MEMORY_SHAPE_PURPOSE, q] : [MEMORY_SHAPE_PURPOSE])) as never;
const QUESTIONS = ['standing_instruction', 'prose_shaped', 'obligation', 'filler', 'worth_summary'];
const OBLIGATION = 'I will send the budget to the owner tomorrow.';
const FACT = 'Tunnel: Cloudflare named. Reason: self-hosted integration.';
const PROSE = 'We looked at the options. Then we compared them for a while. In the end we picked the second one. It was cheaper and faster.';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  setFillerVerdicts(new Map());
  takeFillerCandidates();
});
afterEach(async () => { await decisionAsksSettled(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('no decision model on the box: the rules answer and nothing is asked', () => {
  it('every shape judgment is its rule; no request, no row', async () => {
    const calls = scriptDecisions(() => yes());
    const shape = entryShape('a1', OBLIGATION);
    expect(await shape.obligation('first-person commissive')).toBe('first-person commissive');
    expect(await shape.obligation(null)).toBeNull();
    expect(await shape.standing(false)).toBe(false);
    expect(await shape.prose(true)).toBe(true);
    expect(await spanWorthJudged('a1', 'a span', false)).toBe(false);
    beginFillerPass(); isFiller('sure'); await settleFiller('a1');
    await decisionAsksSettled();
    expect(calls).toHaveLength(0);
    expect(rows()).toEqual([]);
  });
});

describe('shadow: the rule decides and both answers are logged', () => {
  beforeEach(() => { installDecisionModel(db()); });

  it('all five start in shadow', () => { for (const q of QUESTIONS) expect(modeFor(MEMORY_SHAPE_PURPOSE, q)).toBe('shadow'); });

  it('a vault entry\'s three questions are ONE request, and the rule\'s answers stand even against a sure model', async () => {
    const calls = scriptDecisions((name) => (name === 'obligation' ? yes(0.02) : name === 'standing_instruction' ? yes(0.99) : yes(0.01)));
    const shape = entryShape('a1', OBLIGATION);
    expect(await shape.obligation('first-person commissive ("I will …" / "I need to …")')).toMatch(/first-person commissive/);
    expect(await shape.standing(false)).toBe(false);
    expect(await shape.prose(true)).toBe(true);
    await decisionAsksSettled();
    expect(calls).toHaveLength(1);
    expect(calls[0].questions.sort()).toEqual(['obligation', 'prose_shaped', 'standing_instruction']);
    expect(rows().map((r) => [r.question, r.rule_said])).toEqual(expect.arrayContaining([['obligation', 'true'], ['standing_instruction', 'false'], ['prose_shaped', 'true']]));
  });

  it('vault_remember: an obligation is refused as it always was, whatever the model says; a credential is refused with no ask at all', async () => {
    const calls = scriptDecisions(() => yes(0.01));
    const refused = await executeVaultRemember('a1', { content: OBLIGATION, type: 'note' });
    expect(refused).toMatch(/^Refused: this reads as an OBLIGATION rather than a memory \(matched: first-person commissive/);
    const secret = await executeVaultRemember('a1', { content: 'api_key: shppa_FAKE_a1b2c3d4e5f6', type: 'fact' });
    expect(secret).toMatch(/^Refused: this content looks like it contains a credential/);
    await decisionAsksSettled();
    expect(calls).toHaveLength(1);                                                               // the obligation's; the credential gate never asked
    expect(JSON.stringify(calls[0].state)).not.toContain('shppa_FAKE');
  });

  it('the filler pass: short messages the rule judged are asked in one request each 64, logged under "filler", and nothing changes', async () => {
    const calls = scriptDecisions(() => yes(0.97));
    beginFillerPass();
    expect([isFiller('sure'), isFiller('the budget is 40k'), isFiller('let me check the logs for that one')]).toEqual([true, false, true]);
    expect(isFiller('x'.repeat(101))).toBe(false);                                               // over 100 characters: not the rule's judgment
    await settleFiller('a1');
    await decisionAsksSettled();
    expect(calls).toHaveLength(1);
    expect(calls[0].questions).toEqual(['m0', 'm1', 'm2']);
    expect(rows('filler').map((r) => r.rule_said)).toEqual(['true', 'false', 'true']);
    expect([isFiller('sure'), isFiller('the budget is 40k')]).toEqual([true, false]);            // the model\'s 0.97 changed nothing
  });

  it('more than 64 short messages are more than one request', async () => {
    const calls = scriptDecisions(() => yes(0.5));
    beginFillerPass();
    for (let i = 0; i < 70; i++) isFiller(`note number ${i}`);
    await settleFiller('a1');
    await decisionAsksSettled();
    expect(calls.map((c) => c.questions.length)).toEqual([64, 6]);
  });

  it('nothing accumulates outside a triage pass', async () => {
    isFiller('sure');
    expect(takeFillerCandidates()).toEqual([]);
  });

  it('the rebuild\'s floor is asked beside, and still decides', async () => {
    scriptDecisions(() => yes(0.99));
    expect(await spanWorthJudged('a1', 'a span of tool calls', false)).toBe(false);
    await decisionAsksSettled();
    expect(rows('worth_summary').map((r) => r.rule_said)).toEqual(['false']);
  });

  it('a model that is down changes nothing', async () => {
    scriptDecisions(() => 'fail');
    expect(await spanWorthJudged('a1', 'a span', true)).toBe(true);
    expect(await entryShape('a1', FACT).prose(false)).toBe(false);
    await decisionAsksSettled();
    expect(rows()).toEqual([]);
  });
});

describe('model mode (proven on measured accuracy): the verdict stands in, outside the weak band only', () => {
  beforeEach(() => { installDecisionModel(db()); for (const q of QUESTIONS) proveNoul(MEMORY_SHAPE_PURPOSE, q); });

  it('the policy has flipped all five', () => { for (const q of QUESTIONS) expect(modeFor(MEMORY_SHAPE_PURPOSE, q)).toBe('model'); });

  it('vault_remember: a promise the rule would refuse is saved when the model is sure it is a fact; a fact the rule misses is refused when it is sure it is a promise', async () => {
    scriptDecisions((name) => (name === 'obligation' ? yes(0.02) : yes(0.02)));
    expect(await executeVaultRemember('a1', { content: OBLIGATION, type: 'note' })).not.toMatch(/OBLIGATION rather than a memory/);
    scriptDecisions((name) => (name === 'obligation' ? yes(0.97) : yes(0.02)));
    expect(await executeVaultRemember('a1', { content: FACT, type: 'fact' })).toMatch(/^Refused: this reads as an OBLIGATION rather than a memory \(matched: the decision model read it as an obligation\)/);
  });

  it('inside the weak band the rule\'s refusal stands', async () => {
    scriptDecisions(() => yes(0.55));
    expect(await executeVaultRemember('a1', { content: OBLIGATION, type: 'note' })).toMatch(/OBLIGATION rather than a memory/);
  });

  it('vault_remember: narrative prose is bounced only when the model says so; a standing instruction is saved as written when it says so', async () => {
    scriptDecisions(() => yes(0.02));
    expect(await executeVaultRemember('a1', { content: PROSE, type: 'fact' })).not.toMatch(/Reads like narrative prose/);   // rule: prose → model: not prose
    scriptDecisions((name) => (name === 'standing_instruction' ? yes(0.97) : yes(0.97)));
    expect(await executeVaultRemember('a1', { content: PROSE, type: 'fact' })).not.toMatch(/Too long|Reads like narrative prose/);   // exempt: a standing instruction
  });

  it('the credential gate still refuses with a model that says "not a credential" — it never asks', async () => {
    const calls = scriptDecisions(() => yes(0.0));
    expect(await executeVaultRemember('a1', { content: 'api_key: shppa_FAKE_a1b2c3d4e5f6', type: 'fact' })).toMatch(/^Refused: this content looks like it contains a credential/);
    expect(calls).toHaveLength(0);
  });

  it('the filler pass applies the confident verdicts to the passes that follow', async () => {
    scriptDecisions((name) => (name === 'm0' ? yes(0.97) : name === 'm1' ? yes(0.02) : yes(0.55)));
    beginFillerPass();
    isFiller('the budget is 40k'); isFiller('sure'); isFiller('thanks');
    await settleFiller('a1');
    expect(isFiller('the budget is 40k')).toBe(true);    // rule: not filler → model: filler
    expect(isFiller('sure')).toBe(false);                // rule: filler → model: not
    expect(isFiller('thanks')).toBe(true);               // inside the band: the rule
  });

  it('the rebuild asks the model in place of the 120-character floor', async () => {
    scriptDecisions(() => yes(0.97));
    expect(await spanWorthJudged('a1', 'short', false)).toBe(true);
    scriptDecisions(() => yes(0.02));
    expect(await spanWorthJudged('a1', 'x'.repeat(500), true)).toBe(false);
  });
});

describe('the sites ask through the seam and the credential gate stands alone', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
  it('A19/A20: the writer guard asks `entryShape` at all three rules', () => {
    const src = read('vault/tools.ts');
    expect(src).toMatch(/await shape\.obligation\(obligationShape\(content\)\)/);
    expect(src).toMatch(/await shape\.standing\(isStandingInstruction\(content\)\)/);
    expect(src).toMatch(/await shape\.prose\(isProseShaped\(content, cap, terminators\)\)/);
  });
  it('A21: the Dreamer\'s triage opens a filler pass and settles it at both sites; the rule lives in filler.ts', () => {
    const src = read('vault/maintenance.ts');
    expect((src.match(/beginFillerPass\(\)/g) ?? []).length).toBe(2);
    expect((src.match(/await settleFiller\(/g) ?? []).length).toBe(2);
    expect(src).not.toMatch(/FILLER_PATTERNS/);
  });
  it('A22: the rebuild asks `spanWorthJudged` where it compared the 120-character floor', () => {
    expect(read('memory/summary-rebuild.ts')).toMatch(/!await spanWorthJudged\(flag\.agentId, input, proseChars\(input\) >= MIN_PROSE_CHARS\)/);
  });
  it('the credential patterns moved out of tools.ts whole; the gate file imports nothing', () => {
    expect(read('vault/tools.ts')).not.toMatch(/CREDENTIAL_PATTERNS/);
    expect(read('vault/credential-gate.ts')).not.toMatch(/^import /m);
  });
});
