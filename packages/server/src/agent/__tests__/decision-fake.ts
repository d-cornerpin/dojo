// Test kit for the lanes that ask the decision model alongside a rule (v3.5 Part C). Never a real model: the
// decision provider is a row in an in-memory DB and every /v1/systemone request is a scripted fetch.
import type Database from 'better-sqlite3';
import { vi } from 'vitest';
import { recordShadow, recordTruth } from '../decision-shadow.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';

export interface DecisionCall { questions: string[]; state: unknown }

/** The local provider and the standard decision model, installed. */
export function installDecisionModel(db: Database.Database): void {
  db.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://127.0.0.1:47131', 'none', 1)").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, output_cost_per_m, is_enabled)
    VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 262144, 0, 0, 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
}

/** Script the decision model: `answer(name, state)` is what it says to each question. Returns the requests seen. */
export function scriptDecisions(answer: (name: string, state: unknown) => Record<string, unknown> | 'fail'): DecisionCall[] {
  const calls: DecisionCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/api/ps')) return Response.json({ models: [] });
    const body = JSON.parse(init?.body ?? '{}') as { state: unknown; questions: Record<string, unknown> };
    calls.push({ questions: Object.keys(body.questions), state: body.state });
    const answers: Record<string, unknown> = {};
    for (const name of Object.keys(body.questions)) {
      const a = answer(name, body.state);
      if (a === 'fail') return new Response('nope', { status: 500 });
      answers[name] = a;
    }
    return Response.json({ answers, usage: { input_tokens: 20 } });
  }));
  return calls;
}

export const yes = (p = 0.95): Record<string, unknown> => ({ noul: p });

/**
 * Simulate the MEASURED accuracy that flips a yes/no question to `model` under B3's policy: 60 judged rows the
 * model answers right with confidence (30 true at 0.95, 30 false at 0.04) against a rule that always says false,
 * plus 8 near-coin-flip rows at 0.55 that make the 0.5–0.6 decile the model's weak band. Nothing is mocked: the real
 * score and the real policy read these rows.
 */
export function proveNoul(purpose: string, question: string): void {
  const seed = (i: number, truth: boolean, p: number): void => {
    const turnId = `proof-${purpose}-${question}-${i}`;
    recordShadow({ purpose, question, turnId, ruleSaid: false, modelSaid: { type: 'noul', noul: p } });
    recordTruth(turnId, question, truth, 'test: measured accuracy');
  };
  for (let i = 0; i < 30; i++) { seed(i, true, 0.95); seed(100 + i, false, 0.04); }
  for (let i = 0; i < 8; i++) seed(200 + i, i % 2 === 0, 0.55);
}

/** The same for a `choice` question: the model names the truth (confidence 0.9) on 60 rows; the rule says `ruleAlways`. */
export function proveChoice(purpose: string, question: string, truths: string[], ruleAlways: string): void {
  for (let i = 0; i < 60; i++) {
    const truth = truths[i % truths.length];
    const turnId = `proof-${purpose}-${question}-${i}`;
    recordShadow({
      purpose, question, turnId, ruleSaid: ruleAlways,
      modelSaid: { type: 'choice', choice: truth, probabilities: { [truth]: 0.9 }, confidence: 0.9 },
    });
    recordTruth(turnId, question, truth, 'test: measured accuracy');
  }
}
