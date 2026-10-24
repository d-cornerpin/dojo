// v3.5 B1 — decide(): THE ONE SEAM THROUGH WHICH THE ENGINE ASKS THE DECISION MODEL. It returns typed
// answers, or null on any failure so every caller's rule runs. REVIEW FOCUS 1: Ollama is down or the
// decision model is missing when a reply floor runs — the caller gets null in the rule's time.
// Every /v1/systemone call is a scripted fetch: no real model is asked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { decide, type Question } from '../decide.js';
import { getDecisionProvider } from '../decision-provider.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';
import { decisionWindowTokens, writerJobWindowTokens } from '../../services/dojo-working-memory.js';
import { holdWhenQuiet } from '../../services/ollama-quiet.js';

const BASE = 'http://127.0.0.1:47123';
const db = (): Database.Database => mockDb.current!;
const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
let respond: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<Response>;

const QUESTIONS: Record<string, Question> = {
  only_promises_to_start: { type: 'noul', instructions: 'Does `reply` END by promising to begin work, with nothing delivered yet?' },
  topic: { type: 'choice', instructions: 'Which topic is `reply` about?', criteria: { billing: null, other: null } },
  urgency: { type: 'score', instructions: 'How urgent is `reply`?', criteria: ['not', 'somewhat', 'very'] },
};
const DOCUMENTED = {
  answers: {
    only_promises_to_start: { noul: 0.91 },
    topic: { choice: 'billing', probabilities: { billing: 0.85, other: 0.15 }, confidence: 0.7 },
    urgency: { score: 1.3, probabilities: { not: 0.2, somewhat: 0.3, very: 0.5 }, confidence: 0.4 },
  },
  usage: { input_tokens: 120 },
};

function install(): void {
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none', 1)").run(BASE);
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, output_cost_per_m, is_enabled)
    VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 262144, 0, 0, 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  calls.length = 0;
  respond = async () => Response.json(DOCUMENTED);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string; signal?: AbortSignal }) => {
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    calls.push({ url, body });
    return respond(body, init?.signal);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('decide()', () => {
  it('posts the state and questions to the local /v1/systemone, resident, and returns typed answers', async () => {
    install();
    expect(getDecisionProvider()).toMatchObject({ baseUrl: BASE, model: STANDARD_DECISION_MODEL.tag });
    const answers = await decide({ reply: 'I will start on it now.' }, QUESTIONS, { purpose: 'reply_claims', agentId: 'agent-x' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/v1/systemone`);
    expect(calls[0].body).toEqual({ model: STANDARD_DECISION_MODEL.tag, state: { reply: 'I will start on it now.' }, questions: QUESTIONS, keep_alive: -1, options: { num_ctx: await decisionWindowTokens() } });
    expect(answers).toEqual({
      only_promises_to_start: { type: 'noul', noul: 0.91 },
      topic: { type: 'choice', choice: 'billing', probabilities: { billing: 0.85, other: 0.15 }, confidence: 0.7 },
      urgency: { type: 'score', score: 1.3, probabilities: { not: 0.2, somewhat: 0.3, very: 0.5 }, confidence: 0.4 },
    });
  });

  it('NB-4: it runs at the window the memory fit sets aside for the decision model — one number, one origin', async () => {
    install();
    await decide({ reply: 'x' }, QUESTIONS, { purpose: 'reply_claims' });
    const window = await decisionWindowTokens();
    expect((calls[0].body.options as { num_ctx: number }).num_ctx).toBe(window);
    expect(window).toBe(await writerJobWindowTokens(null));   // the summary check reads the writer's job text
  });

  it('NB-1: while the Ollama app restarts for the model limit, the rule answers at once (null), nothing dialled', async () => {
    install();
    const release = await holdWhenQuiet('ollama-local');
    expect(await decide({ reply: 'x' }, QUESTIONS, { purpose: 'reply_claims' })).toBeNull();
    expect(calls).toHaveLength(0);
    release();
  });

  it('writes one cost row: the purpose, the latency, the input tokens, $0', async () => {
    install();
    await decide('text', QUESTIONS, { purpose: 'reply_claims', agentId: 'agent-x' });
    const rows = db().prepare('SELECT agent_id, model_id, input_tokens, output_tokens, cost_usd, latency_ms, call_purpose FROM cost_records').all();
    expect(rows).toEqual([expect.objectContaining({ agent_id: 'agent-x', model_id: 'm-decision', input_tokens: 120, output_tokens: 0, cost_usd: 0, call_purpose: 'reply_claims' })]);
    expect(typeof (rows[0] as { latency_ms: unknown }).latency_ms).toBe('number');
  });

  it('REVIEW FOCUS 1: a hung Ollama returns null within the timeout', async () => {
    install();
    respond = (_b, signal) => new Promise((_r, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const t0 = Date.now();
    expect(await decide('text', QUESTIONS, { purpose: 'reply_claims', timeoutMs: 60 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('REVIEW FOCUS 1: no decision model installed → null, and nothing is dialled', async () => {
    expect(getDecisionProvider()).toBeNull();
    expect(await decide('text', QUESTIONS, { purpose: 'reply_claims' })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('more than the 64 questions Ollama accepts → null, and nothing is dialled', async () => {
    install();
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, { type: 'noul', instructions: `q${i}?` } as Question]));
    expect(await decide('text', many, { purpose: 'reply_claims' })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('a non-2xx answer (the model is not pulled) → null', async () => {
    install();
    respond = async () => Response.json({ error: "model 'x' not found" }, { status: 404 });
    expect(await decide('text', QUESTIONS, { purpose: 'reply_claims' })).toBeNull();
  });

  it('an answer that does not parse, or misses a question → null', async () => {
    install();
    respond = async () => new Response('not json', { status: 200 });
    expect(await decide('text', QUESTIONS, { purpose: 'reply_claims' })).toBeNull();
    respond = async () => Response.json({ answers: { only_promises_to_start: { noul: 0.5 } } });
    expect(await decide('text', QUESTIONS, { purpose: 'reply_claims' })).toBeNull();
  });

  it('Ollama refusing the connection → null', async () => {
    install();
    respond = async () => { throw new Error('fetch failed: ECONNREFUSED'); };
    expect(await decide('text', QUESTIONS, { purpose: 'reply_claims' })).toBeNull();
  });
});
