// Test kit for the judgments the decision model answers. Never a real model: the decision provider is a row in an
// in-memory DB and every /v1/systemone request is a scripted fetch.
import type Database from 'better-sqlite3';
import { vi } from 'vitest';
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
