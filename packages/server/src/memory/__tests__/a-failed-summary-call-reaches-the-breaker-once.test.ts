// A failed summary call reaches the provider breaker once, through the transport's own catch (`settleFailedCall`),
// with the SDK's facts: model.ts wraps every failure, so the wrapped prose alone cannot say a 402 is permanent.
// The summary door adds nothing, so one refused summary is one failure, not two.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-d4b', 'dojo.db'),
  };
});

const frames: Array<{ type: string; code?: string; error?: string }> = [];
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: { type: string; code?: string; error?: string }) => { frames.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

vi.mock('../../gateway/routes/services.js', () => ({ recordProviderError: () => undefined, recordProviderSuccess: () => undefined }));

/** The model call as model.ts makes it: the failure is settled in the transport's catch, then thrown wrapped. */
let thrower: () => AgentError = () => { throw new Error('not configured'); };
vi.mock('../../agent/model.js', async () => {
  const { settleFailedCall } = await import('../../agent/failed-call.js');
  return {
    callModel: async () => {
      const err = thrower();
      settleFailedCall('Model call', err.message, {}, { providerId: 'prov-wrapped-402', agentId: 'agent-d4b', facts: err.provider ?? undefined });
      throw err;
    },
  };
});

import { runMigrations } from '../../db/migrations.js';
import { generateSummary } from '../summarize.js';
import { AgentError } from '../../agent/errors.js';
import { classifyProviderError } from '../../agent/provider-error.js';
import { providerBreaker, mayDialProvider, __resetBreakersForTests } from '../../providers/billing-breaker.js';

const AGENT = 'agent-d4b';
const PROVIDER = 'prov-wrapped-402';
const MODEL = 'm-wrapped-402';

function wrappedAs(sdkMessage: string, status: number): AgentError {
  const facts = classifyProviderError({ status, message: sdkMessage });
  return new AgentError(`OpenAI call failed: ${sdkMessage}`, AGENT, {
    code: 'MODEL_CALL_FAILED', retryable: false, provider: facts,
  });
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES (?, 'Wrapped', 'openai-compatible', 'api_key')").run(PROVIDER);
  db.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, context_window, pricing_unit, cost_per_unit)
     VALUES (?, ?, 'Wrapped 402', 'wrapped/402', '["text"]', 1, 65536, 'token', 0)`,
  ).run(MODEL, PROVIDER);
  db.prepare("INSERT INTO agents (id, name, model_id, status, session_started_at) VALUES (?, 'D4b Box', ?, 'idle', '1970-01-01')")
    .run(AGENT, MODEL);
  frames.length = 0;
  __resetBreakersForTests();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

async function summarise(): Promise<void> {
  await generateSummary({ content: 'filler conversation body', depth: 0, targetTokens: 500, agentId: AGENT, modelId: MODEL });
}

describe('a failed summary call reaches the provider breaker once', () => {
  it('one refused summary is one failure; the second opens the breaker', async () => {
    thrower = () => wrappedAs('402 Payment Required', 402);

    expect(await summarise(), 'a refusal is never a summary').toBeUndefined();
    expect(providerBreaker(PROVIDER), 'one 402 can race a top-up, so it only counts').toBeNull();

    await summarise();

    const open = providerBreaker(PROVIDER);
    expect(open?.reason).toBe('no_balance');
    expect(mayDialProvider(PROVIDER), 'a provider with no balance stops being a candidate').toBe(false);
    expect(frames.filter(f => f.code === 'QUOTA_EXHAUSTED').length, 'the owner is carded once').toBe(1);
    expect(frames.find(f => f.code === 'QUOTA_EXHAUSTED')!.error).toContain('out of balance');
  });

  it('a gateway body with no billing prose is decided by the status the SDK read', async () => {
    thrower = () => wrappedAs('402 {"error":{"message":"requires more credits"}}', 402);
    await summarise();
    await summarise();
    expect(providerBreaker(PROVIDER)?.reason).toBe('no_balance');
  });

  it('a transient wrapped failure opens nothing', async () => {
    thrower = () => wrappedAs('503 upstream overloaded, try again', 503);
    await summarise();
    await summarise();
    await summarise();
    expect(providerBreaker(PROVIDER), 'a bad minute is not a wall').toBeNull();
    expect(mayDialProvider(PROVIDER)).toBe(true);
    expect(frames.filter(f => f.code === 'QUOTA_EXHAUSTED'), 'and no card for it').toEqual([]);
  });

  it('a throw with no facts is read from its prose alone', async () => {
    thrower = () => new AgentError('OpenAI call failed: 402 Payment Required', AGENT, { code: 'MODEL_CALL_FAILED', retryable: false });
    await summarise();
    await summarise();
    expect(providerBreaker(PROVIDER), 'the wrapped prose alone carries no evidence').toBeNull();
  });
});
