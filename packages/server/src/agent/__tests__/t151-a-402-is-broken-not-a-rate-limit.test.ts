// ════════════════════════════════════════════════════════════════════════════════════════
// t151 (C) — A REAL HTTP 402 ON A PINNED MODEL IS "OUT OF CREDIT", NOT A RATE LIMIT.
//
// The t143 live walk (item 4) pointed a scratch agent at a provider answering 402 and saw no
// card, no text, and the chat line "[System: The model provider returned a rate limit error ...
// retrying automatically]" on every wake. The classifier (`provider-error.ts`) was RIGHT: it says
// `quota`. The model layer then folded `quota` into "rate limited" (`isRateLimited = rate_limit ||
// quota`) and armed the 10-second silent retry (`scheduleRateLimitRetry`), whose existence makes the
// recovery cascade's step 0 hand the error to the retry manager instead of the platform's honest
// Tier-D path (one text, the card). Waiting never fixes an empty balance.
//
// Driven through the real model door against a real HTTP server (the idiom of
// `an-edited-provider-is-the-one-that-gets-called.test.ts`), then through the real recovery door
// with the error `callModel` actually threw. Two 402 bodies: the one the walk's fake served and the
// short one a real box logged. CONTROL: a genuine 429 still takes the silent retry.
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 50b921db: clauses marked `it.fails` are the witness; the fix commit flips them.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t151-402');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t151-402');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t151-402', 'dojo.db'),
  };
});

const { broadcasts, transport } = vi.hoisted(() => ({
  broadcasts: [] as Array<Record<string, unknown>>,
  transport: [] as string[],
}));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { broadcasts.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({
    notifyPrimaryOfInjury: vi.fn(async () => undefined),
    handleMessage: vi.fn(async () => undefined),
  }),
}));
vi.mock('../../agent/a2a-transport.js', () => ({ deliverA2AMessage: vi.fn(async () => ({ delivered: true })) }));
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const record = (...a: unknown[]): string => { transport.push(JSON.stringify(a)); return ''; };
  return { ...orig, default: { ...orig, execSync: record, execFileSync: record }, execSync: record, execFileSync: record };
});

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache, setProviderCredential } from '../../config/loader.js';
import { callModel, clearClientCache } from '../model.js';
import { hasActiveRateLimitRetry } from '../rate-limit-retry.js';
import { recoverFromError, classifyError } from '../v2/recovery.js';
import { initState } from '../v2/state.js';
import { AgentError } from '../errors.js';
import { configRouter } from '../../gateway/routes/config.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const OWNER = 'owner@example.test';
const db = (): Database.Database => mockDb.current!;
/** The retry manager is process memory: each clause gets an agent of its own. */
let AGENT = 'helper';
let seq = 0;

/** What the stub provider answers with. */
const answer: { status: number; body: unknown } = { status: 402, body: {} };
let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      // x-should-retry: the client's own back-off sleep is not what is under test
      res.writeHead(answer.status, { 'content-type': 'application/json', 'x-should-retry': 'false' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => {
  fs.rmSync(path.join(HOME, '.dojo'), { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  clearSecretsCache();
  clearClientCache();
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  transport.length = 0;
  broadcasts.length = 0;
  d.prepare(`INSERT INTO config (key, value) VALUES ('imessage_approved_senders', ?)`)
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true }]));
  d.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
             VALUES ('prov-a', 'Cloud Provider', 'openai-compatible', ?, 'api_key', 1, datetime('now'), datetime('now'))`).run(baseUrl);
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
             VALUES ('m-a', 'prov-a', 'Model A', 'model-a', '["text"]', 32768, 4096, 1, datetime('now'), datetime('now'))`).run();
  AGENT = `helper${++seq}`;
  d.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Helper', 'working', 'm-a', '{}'), ('hl', 'Healer', 'idle', 'm-a', '{}')").run(AGENT);
  d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', 'hl')").run();
  setProviderCredential('prov-a', 'sk-test-key', 'api_key');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

const ownerTexts = (): number => (db().prepare(
  "SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = 'platform' AND tool = 'alert' AND recipient_id = ?",
).get(OWNER) as { n: number }).n;
const cards = (): string[] => broadcasts
  .filter((b) => b.type === 'chat:error' && b.agentId === 'platform' && b.severity !== 'info')
  .map((b) => String(b.error));

/** One model call to the stub, as a pinned-model agent makes it. Resolves to the error it threw. */
async function pinnedCall(): Promise<AgentError> {
  try {
    await callModel({
      agentId: AGENT, modelId: 'm-a', tools: false,
      messages: [{ role: 'user', content: 'Are you there?' }], systemPrompt: 'You are a test model.',
    });
  } catch (e) {
    return e as AgentError;
  }
  throw new Error('the stub provider answered; the call was expected to fail');
}

/** The thrown error handed to the real recovery cascade, as the turn's teardown does. */
async function recover(err: Error): Promise<void> {
  db().prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(AGENT);
  const state = initState({
    agentId: AGENT, contextWindow: 128_000, isAutoRouted: false, configuredModelId: 'm-a',
    turnNumber: 1, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: null, lastUserMessageId: null, inboundChannel: null, inboundContext: null,
    pendingTechniqueAck: null,
  });
  await recoverFromError(state, err, { isUserFacingTurn: false });
}

// The two shapes of the same fact: the body the walk's fake served, and the short body the
// provider-error classifier cites from a real box.
const BODIES: Array<[string, unknown]> = [
  ['the walk\'s fake body', { error: { message: 'Insufficient Balance', type: 'unknown_error' } }],
  ['a real box\'s short body', { message: 'Insufficient Balance' }],
];

describe('C — a 402 on a pinned model is the platform\'s honest BROKEN path, never the silent retry', () => {
  for (const [label, body] of BODIES) {
    it.fails(`${label}: the call fails as out-of-credit and arms no rate-limit retry`, async () => {
      answer.status = 402; answer.body = body;
      const err = await pinnedCall();
      expect(err.provider?.class).toBe('quota');
      expect(hasActiveRateLimitRetry(AGENT)).toBe(false);
    });

    it.fails(`${label}: through the recovery door it is ONE text, the card, the agent in error; no "rate limit" line, no retry`, async () => {
      answer.status = 402; answer.body = body;
      const err = await pinnedCall();
      await recover(err);
      const agent = db().prepare('SELECT status, last_error FROM agents WHERE id = ?').get(AGENT) as { status: string; last_error: string };
      expect(agent.status).toBe('error');
      expect(agent.last_error).toMatch(/^\[quota_exhausted\]/);
      expect(ownerTexts()).toBe(1);
      expect(cards()).toHaveLength(1);
      expect(hasActiveRateLimitRetry(AGENT)).toBe(false);
      const said = db().prepare("SELECT content FROM messages WHERE agent_id = ? AND content LIKE '%rate limit%'").all(AGENT);
      expect(said).toHaveLength(0);
    });
  }

  it.fails('the card leaves when it is fixed: the next healthy call ends the incident', async () => {
    answer.status = 402; answer.body = BODIES[1][1];
    await recover(await pinnedCall());
    const words = JSON.parse((db().prepare('SELECT broken_notice AS n FROM agents WHERE id = ?').get(AGENT) as { n: string }).n).words as string;
    const shown = async (): Promise<string[]> =>
      ((await (await configRouter.request('/owner-notices')).json()) as { data: Array<{ words: string }> }).data.map((c) => c.words);
    expect(await shown()).toContain(words);
    const { clearErrors } = await import('../errors.js');
    clearErrors(AGENT);
    expect(await shown()).not.toContain(words);
  });

  it.fails('classifyError (the SDK transport\'s reader) does not file out-of-credit as a rate limit either', () => {
    expect(classifyError(new Error('API error 402: {"message":"Insufficient Balance"}')).kind).not.toBe('rate_limit');
  });

  it('CONTROL: a genuine 429 still takes the silent retry (waiting does fix that)', async () => {
    answer.status = 429; answer.body = { error: { message: 'Rate limit reached for requests', type: 'rate_limit_error' } };
    const err = await pinnedCall();
    expect(err.provider?.class).toBe('rate_limit');
    expect(hasActiveRateLimitRetry(AGENT)).toBe(true);
  });
});
