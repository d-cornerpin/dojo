// v3.5 C2 — INBOUND ROUTING ASKS THE DECISION MODEL ALONGSIDE ITS RULES (spec A11–A15).
//
// In `rule` and `shadow` mode every routing judgment returns what its rule always returned — byte for byte, the
// multistep chat-JSON call included (owner ruling) — and the model's answer is logged beside it. Only when the
// policy has flipped a question to `model` on measured accuracy does the model's verdict stand in, and only
// outside the question's weak band; inside it, today's behaviour. A15 wakes the primary: the strictest reading.
// The decision model is never real: a provider row and a scripted fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
// The system model's multistep chat call: scripted, and counted.
const chat = vi.hoisted(() => ({ calls: 0, reply: '{"multistep": true, "name": "Tidy the files"}' }));
vi.mock('../../../router/selector.js', () => ({ getSystemModel: () => 'system-model' }));
vi.mock('../../model.js', () => ({
  callModel: async () => { chat.calls++; return { content: chat.reply, toolCalls: [], usage: {} }; },
}));

import { runMigrations } from '../../../db/migrations.js';
import { decisionAsksSettled } from '../../decision-ask.js';
import {
  courtesyJudged, deliverableJudged, delegatesJudged, detectMultistepJudged, isConversational, INBOUND_ROUTING_PURPOSE,
} from '../classifiers/inbound-routing.js';
import { detectMultistep, type MultistepConfig } from '../classifiers/multistep.js';
import { complexityClassifier } from '../classifiers/complexity.js';
import { START_ACK_POOL } from '../ack-copy.js';
import { modeFor } from '../../decision-policy.js';
import { installDecisionModel, proveNoul, scriptDecisions, yes } from '../../__tests__/decision-fake.js';

const db = (): Database.Database => mockDb.current!;
const CFG: MultistepConfig = { enabled: true, model: null, baseUrl: '', timeoutMs: 5000 } as MultistepConfig;
const S4 = "I want a comparison of HubSpot and Pipedrive for a 3-person shop. Split the research between your helpers if that's faster, and give me one combined write-up with a bottom-line recommendation.";
const S5 = "What's the biggest file in my fixtures folder? Just curious.";
const S6 = "Go through my uploads folder and give me a thorough summary of what's in there.";   // ambiguous: the chat call decides
const shadowRows = (): Array<{ question: string; rule_said: string; model_said: string }> =>
  db().prepare("SELECT question, rule_said, model_said FROM decision_shadow WHERE purpose = ? ORDER BY id").all(INBOUND_ROUTING_PURPOSE) as never;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  chat.calls = 0;
  chat.reply = '{"multistep": true, "name": "Tidy the files"}';
});
afterEach(async () => { await decisionAsksSettled(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('no decision model on the box: the rules answer and nothing is asked', () => {
  it('every judgment is its rule, no request is made, no row is written', async () => {
    const calls = scriptDecisions(() => yes());
    const turn = {};
    expect(await isConversational(turn, 'a1', 'hey there')).toBe(true);
    expect(await delegatesJudged(turn, 'a1', 'have one of your agents research it', true)).toBe(true);
    expect(await courtesyJudged('a1', 'sounds good')).toBe(true);
    expect(await deliverableJudged('a1', 'draft #4 is ready', true)).toBe(true);
    expect(await detectMultistepJudged(turn, S5, 'a1', CFG)).toEqual(await detectMultistep(S5, 'a1', CFG));
    await decisionAsksSettled();
    expect(calls).toHaveLength(0);
    expect(shadowRows()).toEqual([]);
  });
});

describe('shadow (no measured accuracy yet): the rule decides, the model is asked alongside and both are logged', () => {
  beforeEach(() => { installDecisionModel(db()); });

  it('all three questions about one message are ONE request, and they all stay in shadow', async () => {
    const calls = scriptDecisions((name) => (name === 'simple_chat' ? yes(0.02) : yes(0.97)));   // the model disagrees with the rule everywhere
    const turn = {};
    for (const q of ['simple_chat', 'multi_step', 'delegates', 'pleasantry', 'deliverable']) expect(modeFor(INBOUND_ROUTING_PURPOSE, q)).toBe('shadow');
    expect(await isConversational(turn, 'a1', 'hey there')).toBe(true);                       // the rule: simple
    expect(await delegatesJudged(turn, 'a1', 'hey there', false)).toBe(false);                // the rule: no
    const multi = await detectMultistepJudged(turn, S5, 'a1', CFG);
    expect(multi).toEqual(await detectMultistep(S5, 'a1', CFG));                              // the rule: not multi-step
    await decisionAsksSettled();
    expect(calls).toHaveLength(1);
    expect(calls[0].questions.sort()).toEqual(['delegates', 'multi_step', 'simple_chat']);
    expect(shadowRows().map((r) => [r.question, r.rule_said, JSON.parse(r.model_said).noul]).sort()).toEqual([
      ['delegates', 'false', 0.97], ['multi_step', 'false', 0.97], ['simple_chat', 'true', 0.02],
    ]);
  });

  it('the multistep chat-JSON call is NOT removed in shadow: an ambiguous ask still goes to the system model', async () => {
    scriptDecisions(() => yes(0.01));                                                         // the decision model says "single"
    const d = await detectMultistepJudged({}, S6, 'a1', CFG);
    expect(chat.calls).toBe(1);
    expect(d).toMatchObject({ multistep: true, source: 'llm_multi' });                       // the rule (the chat call) decided
    await decisionAsksSettled();
    expect(shadowRows().map((r) => [r.question, r.rule_said])).toEqual([['multi_step', 'true']]);   // the row carries the rule's whole answer
  });

  it('a decision model that is down changes nothing: the rule answers and no row is written', async () => {
    scriptDecisions(() => 'fail');
    const turn = {};
    expect(await isConversational(turn, 'a1', 'hey there')).toBe(true);
    expect(await detectMultistepJudged(turn, S4, 'a1', CFG)).toMatchObject({ multistep: true, source: 'heuristic_multi' });
    await decisionAsksSettled();
    expect(shadowRows()).toEqual([]);
  });

  it('an engine ack line coming back is machine courtesy by construction and never asks', async () => {
    const calls = scriptDecisions(() => yes(0.01));
    expect(await courtesyJudged('a1', START_ACK_POOL[0])).toBe(true);
    await decisionAsksSettled();
    expect(calls).toHaveLength(0);
  });

  it('a pleasantry and a deliverable shape are asked once each, with the rule beside them', async () => {
    const calls = scriptDecisions((name) => (name === 'pleasantry' ? yes(0.9) : yes(0.1)));
    expect(await courtesyJudged('a1', 'what is the plan for friday')).toBe(false);            // the rule wins over the model's 0.9
    expect(await deliverableJudged('a1', 'Draft #14 is ready for review', true)).toBe(true);  // and over its 0.1
    await decisionAsksSettled();
    expect(calls.map((c) => c.questions)).toEqual([['pleasantry'], ['deliverable']]);
    expect(shadowRows().map((r) => [r.question, r.rule_said])).toEqual([['pleasantry', 'false'], ['deliverable', 'true']]);
  });
});

describe('model mode (proven on measured accuracy): the verdict stands in, outside the weak band only', () => {
  beforeEach(() => { installDecisionModel(db()); for (const q of ['simple_chat', 'multi_step', 'delegates', 'pleasantry', 'deliverable']) proveNoul(INBOUND_ROUTING_PURPOSE, q); });

  it('the policy has flipped all five', () => {
    for (const q of ['simple_chat', 'multi_step', 'delegates', 'pleasantry', 'deliverable']) expect(modeFor(INBOUND_ROUTING_PURPOSE, q)).toBe('model');
  });

  it('a confident answer replaces the rule; an answer inside the weak band leaves the rule alone', async () => {
    scriptDecisions((name) => (name === 'simple_chat' ? yes(0.03) : yes(0.55)));              // 0.55 sits in the model's weakest decile
    const turn = {};
    expect(await isConversational(turn, 'a1', 'hey there')).toBe(false);                      // rule: simple → model: not simple
    expect(await delegatesJudged(turn, 'a1', 'hey there', false)).toBe(false);                // in the band: the rule's false
    expect(await delegatesJudged(turn, 'a1', 'hey there', true)).toBe(true);                  // in the band: the rule's true
  });

  it('multistep: the model replaces the chat-JSON call (it is not made); inside the band the rule runs as before', async () => {
    scriptDecisions(() => yes(0.95));
    const d = await detectMultistepJudged({}, S6, 'a1', CFG);
    expect(d).toMatchObject({ multistep: true, source: 'decision_multi', name: null });
    expect(chat.calls).toBe(0);
    scriptDecisions(() => yes(0.55));                                                          // the weak band
    chat.reply = '{"multistep": false, "name": null}';
    const inside = await detectMultistepJudged({}, S6, 'a1', CFG);
    expect(inside).toMatchObject({ multistep: false, source: 'llm_single' });                // today's behaviour, chat call and all
    expect(chat.calls).toBe(1);
  });

  it('multistep still skips the three non-judgments: an engine message and an explicit request never ask', async () => {
    const calls = scriptDecisions(() => yes(0.95));
    expect(await detectMultistepJudged({}, '[A2A: x] build a thing and test it', 'a1', CFG)).toMatchObject({ source: 'engine_message' });
    expect(await detectMultistepJudged({}, 'please create a task for the budget', 'a1', CFG)).toMatchObject({ source: 'user_creating_explicitly' });
    expect(calls).toHaveLength(0);
  });

  it('a decision model that fails falls back to the rule in the rule\'s time', async () => {
    scriptDecisions(() => 'fail');
    expect(await isConversational({}, 'a1', 'hey there')).toBe(true);
    expect(await courtesyJudged('a1', 'sounds good')).toBe(true);
    expect(await detectMultistepJudged({}, S6, 'a1', CFG)).toMatchObject({ source: 'llm_multi' });
  });

  it('the pleasantry judgment can stop an agent\'s message waking a turn, and cannot override an engine ack', async () => {
    scriptDecisions(() => yes(0.97));
    expect(await courtesyJudged('a1', 'see you at the offsite')).toBe(true);                  // rule: false → model: pure pleasantry
    expect(complexityClassifier('hey there').complexity).toBe('simple');
    scriptDecisions(() => yes(0.02));
    expect(await courtesyJudged('a1', START_ACK_POOL[0])).toBe(true);                         // the exact-match fast path
  });

  it('A15 takes the STRICTEST band: 0.45 is outside the weak decile but not clearly beyond it, so the rule stands (the others act on it)', async () => {
    scriptDecisions(() => yes(0.45));
    expect(await deliverableJudged('a1', 'Draft #14 is ready for review', true)).toBe(true);   // strict: leave the rule alone
    expect(await delegatesJudged({}, 'a1', 'have one of your agents research it', true)).toBe(false);   // not strict: acts
    scriptDecisions(() => yes(0.97));
    expect(await deliverableJudged('a1', 'status: working on the second draft', false)).toBe(true);
    scriptDecisions(() => yes(0.03));
    expect(await deliverableJudged('a1', 'Draft #14 is ready for review', true)).toBe(false);
  });
});

describe('the five sites ask through the seam, and not around it (a census of the call sites, not a sentence)', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');
  it('A12: the assemble step asks `isConversational`; the bare complexity rule is no longer read there', () => {
    const src = read('agent/v2/steps/assemble/index.ts');
    expect(src).toMatch(/await isConversational\(turnCtx,/);
    expect(src).not.toMatch(/complexityClassifier/);
  });
  it('A13: the multistep detection passes the turn to `detectMultistep`, which hands it to the judged path', () => {
    expect(read('agent/v2/steps/assemble/multistep-detection.ts')).toMatch(/detectMultistep\(lastUserMessageContent, agentId, cfg, turnCtx\)/);
    expect(read('agent/v2/classifiers/multistep.ts')).toMatch(/detectMultistepJudged\(turnCtx, query, agentId, config\)/);
  });
  it('A14: the delegation hint asks `delegatesJudged` with the grammar\'s answer', () => {
    expect(read('agent/v2/steps/assemble/delegation-and-attachments.ts')).toMatch(/await delegatesJudged\(turnCtx, agentId, lastUserMessageContent, detectExplicitDelegation\(lastUserMessageContent\)\)/);
  });
  it('A11: the iMessage wake point asks `courtesyJudged`, after the sender-is-an-agent test', () => {
    const src = read('services/imessage-bridge.ts');
    expect(src).toMatch(/senderRecord\?\.is_agent &&\s+!!cleanedText &&\s+await courtesyJudged\(primaryId, cleanedText\)/);
    expect(src).not.toMatch(/isContentFreeCourtesy/);
  });
  it('A15: the A2A transport asks `deliverableJudged` only inside the FYI / primary / sub-agent test', () => {
    expect(read('agent/a2a-transport.ts')).toMatch(/senderIsSubAgent &&\s+await deliverableJudged\(target\.id, envelope\.payload, payloadLooksDeliverable\(envelope\.payload\)\)/);
  });
});
