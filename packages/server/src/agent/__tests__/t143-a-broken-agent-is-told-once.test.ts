// ════════════════════════════════════════════════════════════════════════════════════════
// t143 (v3.3.3, OR-LONG-JOBS, OR-V333-SET (3)) — BROKEN: THE OWNER IS TOLD AT ONCE, ONCE.
//
// A provider that refuses an agent in a way only the owner can fix — out of credit (402), a key
// that stopped working (401), access denied, no network — is the platform's "Tier D" condition
// (`agent/v2/recovery.ts`, `tryPlatformErrorRecovery`). It locks the agent to `error`, writes a
// chat card, and hands the agent to the Healer. Its own comment says it "sends iMessage"; it never
// did, and the Healer texts only after three failed recoveries. So at 4cb9ed61 a sub-agent that
// ran out of credit was never reported to the owner's phone (v3.3.3 kit scenario 5, leg (c), row-
// verified on the dev box: five "Tier D (locking agent, alerting user)" log lines, no alert).
//
// Driven through the real recovery door (`recoverFromError`, what the turn's teardown calls with
// the thrown model error), the real Healer injury door it calls, and the real owner-notice door
// down to the `deliveries` ledger. Only the phone (`child_process`), the socket and the engine
// downstream of the Healer are replaced; the Healer's timers are fake and never fire.
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 4cb9ed61: clauses marked `it.fails` are the witness; the fix commit flips them.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t143-broken');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t143-broken');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t143-broken', 'dojo.db'),
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

// Each clause boots the real module graph and runs the full migration chain; an import cost, not
// a timing assertion. Nothing here measures time.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { recoverFromError } from '../v2/recovery.js';
import { initState } from '../v2/state.js';
import { AgentError, clearErrors } from '../errors.js';
import { onAgentInjured } from '../../healer/injury-recovery.js';
import { configRouter } from '../../gateway/routes/config.js';
import { classifyProviderErrorText } from '../provider-error.js';

const OWNER = 'owner@example.test';
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  transport.length = 0;
  broadcasts.length = 0;
  d.prepare(`INSERT INTO config (key, value) VALUES ('imessage_approved_senders', ?)`)
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true }]));
  d.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-a', 'Cloud Provider', 'openai-compatible', 'api_key')`).run();
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id) VALUES ('m-a', 'prov-a', 'Model A', 'model-a')`).run();
  d.prepare("INSERT INTO agents (id, name, status, model_id) VALUES ('helper', 'Helper', 'working', 'm-a'), ('hl', 'Healer', 'idle', 'm-a')").run();
  d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', 'hl')").run();
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
/** The phone sends (the bridge's own `--help` probe and path lookups are not sends). */
const sent = (): string[] => transport.filter((t) => t.includes('"send"'));
const cards = (): string[] => broadcasts
  .filter((b) => b.type === 'chat:error' && b.agentId === 'platform' && b.severity !== 'info')
  .map((b) => String(b.error));

/** One failed model call, as the model layer raises it, handed to the real recovery cascade. */
async function failedCall(providerWords: string, turnNumber = 1): Promise<void> {
  db().prepare("UPDATE agents SET status = 'working' WHERE id = 'helper'").run();
  const state = initState({
    agentId: 'helper', contextWindow: 128_000, isAutoRouted: false, configuredModelId: 'm-a',
    turnNumber, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: null, lastUserMessageId: null, inboundChannel: null, inboundContext: null,
    pendingTechniqueAck: null,
  });
  const err = new AgentError(providerWords, 'helper', {
    code: 'MODEL_CALL_FAILED', provider: classifyProviderErrorText(providerWords),
  });
  await recoverFromError(state, err, { isUserFacingTurn: false });
}

describe('BROKEN: a provider refuses the agent in a way only the owner can fix', () => {
  it('out of credit (402): the owner gets ONE text and ONE card, naming the agent', async () => {
    await failedCall('API error 402: {"error":{"message":"Insufficient Balance"}}');
    // Precondition: this IS the platform's Tier D lock, not some other path.
    expect((db().prepare("SELECT status, last_error FROM agents WHERE id = 'helper'").get() as { status: string; last_error: string }).last_error)
      .toMatch(/^\[quota_exhausted\]/);
    expect(ownerTexts()).toBe(1);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('Helper');
    expect(cards()).toHaveLength(1);
  });

  it('a key that stopped working (401): the owner gets ONE text naming the agent', async () => {
    await failedCall('API error 401: {"error":{"message":"invalid x-api-key"}}');
    expect((db().prepare("SELECT last_error FROM agents WHERE id = 'helper'").get() as { last_error: string }).last_error)
      .toMatch(/^\[auth_invalid\]/);
    expect(ownerTexts()).toBe(1);
    expect(sent()[0]).toContain('Helper');
  });
});

const ends = (): string[] => broadcasts
  .filter((b) => b.type === 'chat:error' && b.agentId === 'platform' && b.severity === 'info')
  .map((b) => String(b.error));
const cardsOnLoad = async (): Promise<string[]> =>
  ((await (await configRouter.request('/owner-notices')).json()) as { data: Array<{ words: string }> }).data.map((c) => c.words);
const OUT_OF_CREDIT = 'API error 402: {"error":{"message":"Insufficient Balance"}}';

describe('BROKEN: once per incident, and the incident ends on healthy work', () => {
  it('the agent re-woken and refused again (the t136 shape: five Tier D locks) is still ONE text; the Healer\'s "stuck" text does not stack on it', async () => {
    for (let i = 1; i <= 5; i++) await failedCall(OUT_OF_CREDIT, i);
    expect(ownerTexts()).toBe(1);
    // Recovery attempts at their maximum: the Healer's own "stuck" text would fire here.
    db().prepare("UPDATE agents SET recovery_attempts = 3 WHERE id = 'helper'").run();
    onAgentInjured('helper', '[quota_exhausted] Cloud Provider has hit its quota for the day.');
    expect(ownerTexts()).toBe(1);
  });

  it('a restart replays the injury from the row (rehydrate) and does not text again; the card is there on load', async () => {
    await failedCall(OUT_OF_CREDIT);
    const words = JSON.parse((db().prepare("SELECT broken_notice AS n FROM agents WHERE id = 'helper'").get() as { n: string }).n).words as string;
    const lastError = (db().prepare("SELECT last_error FROM agents WHERE id = 'helper'").get() as { last_error: string }).last_error;
    onAgentInjured('helper', lastError); // what `rehydrateInjuredAgents` does on boot
    expect(ownerTexts()).toBe(1);
    expect(await cardsOnLoad()).toContain(words);
  });

  it('dismissed, it stays dismissed for this incident; the next healthy turn ends it; a NEW incident is told again', async () => {
    await failedCall(OUT_OF_CREDIT);
    const words = JSON.parse((db().prepare("SELECT broken_notice AS n FROM agents WHERE id = 'helper'").get() as { n: string }).n).words as string;
    const res = await configRouter.request('/owner-notices/dismiss', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ words }),
    });
    expect(((await res.json()) as { data: { dismissed: number } }).data.dismissed).toBe(1);
    expect(await cardsOnLoad()).not.toContain(words);
    await failedCall(OUT_OF_CREDIT, 2);
    expect(ownerTexts()).toBe(1);
    // The owner tops up; the agent's next turn works (the clean-turn signal).
    clearErrors('helper');
    expect(ends()).toContain(words);
    expect((db().prepare("SELECT broken_notice AS n FROM agents WHERE id = 'helper'").get() as { n: string | null }).n).toBeNull();
    // Out of credit again, later: a new incident.
    await failedCall(OUT_OF_CREDIT, 3);
    expect(ownerTexts()).toBe(2);
  });

  it('an ordinary, unclassified failure is NOT broken: no text (the Healer owns it, as before)', async () => {
    await failedCall('fetch failed: ECONNRESET');
    expect(ownerTexts()).toBe(0);
  });
});
