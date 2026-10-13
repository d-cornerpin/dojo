// ════════════════════════════════════════════════════════════════════════════════════════
// t138 round 2 — EVERY TEXT THE DOJO SENDS THE OWNER ALSO WAITS ON THE DASHBOARD.
//
// Owner, 2026-10-13: "we should have dashboard banners but use our existing alert/notification
// system." So a missed text is not a missed warning: whatever `sendAlert` (the owner-notice
// door, services/imessage-bridge.ts) puts on his phone also arrives on the dashboard's
// EXISTING notification cards. Those cards are fed by `chat:error` frames, which the dashboard
// renders by severity; the owner's copy is spoken by the platform (`PLATFORM_SENDER`), not by
// an agent, and the dashboard pins it until he dismisses it (dashboard suite,
// t138-an-owner-alert-stays-until-dismissed).
//
// One alert = one card: a card is born exactly where a text is born, so every rule that decides
// "tell him again or not" (a budget window turning over, a balance topped up and falling again,
// the Healer's backoff entry) decides the card too. An unchanged condition makes no card.
//
// Every clause drives the REAL doors: the cost recorder, the scheduler tick that checks provider
// balances, the error-loop door, the Healer's injury door, and the real `sendAlert` / iMessage
// door. Only the operating-system transport (`child_process`), the providers' HTTP API
// (`fetch`), and the engine downstream of the Healer are replaced. The broadcast is captured at
// `gateway/ws.js`, which is what the dashboard's socket would have been handed.
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST at f33af0e8: clauses marked `it.fails` are the witness, failing before the fix;
// the fix commit flips them to `it`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t138-r2-cards');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-r2-cards');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-r2-cards', 'dojo.db'),
  };
});

const { broadcasts, transport, transportFails } = vi.hoisted(() => ({
  /** Every frame handed to the dashboard's socket. */
  broadcasts: [] as Array<Record<string, unknown>>,
  /** The operating-system transport under the iMessage door: one entry per text that left. */
  transport: [] as string[],
  transportFails: { on: false },
}));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { broadcasts.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
// The engine downstream of the Healer (it would wake the Healer agent); only the notice is measured.
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({
    notifyPrimaryOfInjury: vi.fn(async () => undefined),
    handleMessage: vi.fn(async () => undefined),
  }),
}));
vi.mock('../../agent/a2a-transport.js', () => ({ deliverA2AMessage: vi.fn(async () => ({ delivered: true })) }));
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const record = (...a: unknown[]): string => {
    const line = JSON.stringify(a);
    transport.push(line);
    if (transportFails.on && !line.includes('--help')) throw new Error('transport down');
    return '';
  };
  return { ...orig, default: { ...orig, execSync: record, execFileSync: record }, execSync: record, execFileSync: record };
});

import { runMigrations } from '../../db/migrations.js';

// Each clause boots the real module graph (the iMessage door pulls in the engine) and runs the
// full migration chain; that is an import cost, not a timing assertion. Nothing here measures time.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const OWNER = 'owner@example.test';
const db = (): Database.Database => mockDb.current!;

/** What each provider's balance API answers right now. */
const account = { openrouter: 50, deepseek: 50 };

function fakeFetch(url: string | URL): Promise<Response> {
  const u = String(url);
  if (u.includes('openrouter.ai')) {
    return Promise.resolve(new Response(JSON.stringify({
      data: { total_credits: 100, total_usage: 100 - account.openrouter },
    }), { status: 200 }));
  }
  if (u.includes('deepseek.com')) {
    return Promise.resolve(new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: String(account.deepseek), granted_balance: '0', topped_up_balance: String(account.deepseek) }],
    }), { status: 200 }));
  }
  return Promise.reject(new Error(`unexpected fetch ${u}`));
}

beforeEach(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  broadcasts.length = 0;
  transport.length = 0;
  transportFails.on = false;
  account.openrouter = 50;
  account.deepseek = 50;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  setPhone(OWNER);
  d.prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
             VALUES ('prov', 'Prov', 'openai', 'api_key', 1, datetime('now'), datetime('now'))`).run();
  // $1 per million input tokens: a call of N million input tokens costs exactly $N.
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                                 max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled,
                                 created_at, updated_at)
             VALUES ('mdl', 'prov', 'Mdl', 'mdl-1', '["text","tools"]', 65536, 8192, 1.0, 0, 1,
                     datetime('now'), datetime('now'))`).run();
  d.prepare(`INSERT INTO agents (id, name, model_id, status, created_at, updated_at)
             VALUES ('ag', 'Helper', 'mdl', 'idle', datetime('now'), datetime('now')),
                    ('hl', 'Mender', NULL, 'idle', datetime('now'), datetime('now'))`).run();
  d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', 'hl')").run();
  d.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
             VALUES ('or', 'Router', 'openai-compatible', 'https://openrouter.ai/api/v1', 'api_key', 1, datetime('now'), datetime('now'))`).run();
  const loader = await import('../../config/loader.js');
  loader.clearSecretsCache();
  loader.setProviderCredential('or', 'sk-test-router');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
  vi.resetModules();
});

function setPhone(address: string | null): void {
  db().prepare("DELETE FROM config WHERE key = 'imessage_approved_senders'").run();
  if (address === null) return;
  db().prepare(`INSERT INTO config (key, value) VALUES ('imessage_approved_senders', ?)`)
    .run(JSON.stringify([{ address, name: 'Owner', is_primary: true }]));
}

/** A freshly booted process over the same database. */
async function boot(): Promise<{
  recordCost: typeof import('../../costs/tracker.js').recordCost;
  budget: typeof import('../../costs/budget.js');
  errors: typeof import('../../agent/errors.js');
  healer: typeof import('../../healer/injury-recovery.js');
  bridge: typeof import('../imessage-bridge.js');
  tick: () => Promise<void>;
  PLATFORM_SENDER: string;
}> {
  vi.resetModules();
  const tracker = await import('../../costs/tracker.js');
  const clock = await import('../../scheduler/clock.js');
  return {
    recordCost: tracker.recordCost,
    budget: await import('../../costs/budget.js'),
    errors: await import('../../agent/errors.js'),
    healer: await import('../../healer/injury-recovery.js'),
    bridge: await import('../imessage-bridge.js'),
    tick: async () => { await clock.runSchedulerTick(); await clock.balanceCheckSettled(); },
    PLATFORM_SENDER: (await import('../../agent/v2/outbound.js')).PLATFORM_SENDER,
  };
}

function spend(recordCost: typeof import('../../costs/tracker.js').recordCost, dollars: number): void {
  recordCost({
    agentId: 'ag', modelId: 'mdl', providerId: 'prov',
    inputTokens: Math.round(dollars * 1_000_000), outputTokens: 0,
  });
}

/** What left for the owner's phone. */
const texts = (): string[] => transport.filter((t) => !t.includes('--help') && !t.includes('which'));
/** The owner's dashboard cards: notification frames spoken by the platform, not an agent. */
const cards = (): Array<{ error: string; severity: unknown; retryable: unknown }> =>
  broadcasts
    .filter((b) => b.type === 'chat:error' && b.agentId === 'platform')
    .map((b) => ({ error: String(b.error), severity: b.severity, retryable: b.retryable }));

/** Each text has its card, in order, carrying the same words. */
function expectPaired(n: number): void {
  const t = texts();
  const c = cards();
  expect(c, 'one dashboard card per text').toHaveLength(n);
  expect(t).toHaveLength(n);
  c.forEach((card, i) => {
    expect(card.error.length).toBeGreaterThan(20);
    expect(t[i], 'the card carries the words the phone got').toContain(card.error);
  });
}

describe('the RED witness: a text reaches the phone and nothing waits on the dashboard', () => {
  it('a budget crossing (50%, through the real cost door) texts AND leaves one card', async () => {
    const { recordCost, budget, PLATFORM_SENDER } = await boot();
    expect(PLATFORM_SENDER).toBe('platform');
    budget.setGlobalBudget(10);
    spend(recordCost, 5.1);
    expectPaired(1);
    expect(cards()[0].error).toContain('50%');
    expect(cards()[0]).toMatchObject({ severity: 'warning', retryable: false });
  });

  it('an agent paused after repeated errors (the real error-loop door) texts AND leaves one card', async () => {
    const { errors } = await boot();
    let paused = false;
    for (let i = 0; i < 10 && !paused; i++) paused = errors.recordError('ag');
    expect(paused).toBe(true);
    expectPaired(1);
    expect(cards()[0].error).toContain('Helper');
    expect(cards()[0].error).toContain('paused');
  });

  it('auto-recovery giving up on a stuck agent (the real injury door) texts AND leaves one card', async () => {
    const { healer } = await boot();
    vi.useFakeTimers();
    db().prepare("UPDATE agents SET recovery_attempts = 3, status = 'error' WHERE id = 'ag'").run();
    healer.onAgentInjured('ag', 'fetch failed: ECONNRESET');
    healer.onAgentInjured('ag', 'fetch failed: ECONNRESET'); // inside the backoff window: unchanged
    expectPaired(1);
    expect(cards()[0].error).toContain('Helper');
  });

  it('a provider balance at its warning line (the real scheduler tick) texts AND leaves one card', async () => {
    account.openrouter = 2;
    const { tick } = await boot();
    await tick();
    expectPaired(1);
    expect(cards()[0].error).toContain('OpenRouter');
  });

  it('a critical alert is a critical card; the phone gets the [CRITICAL] prefix, the card its tier', async () => {
    const { bridge } = await boot();
    bridge.sendAlert('The box is nearly out of memory. Close something.', 'critical');
    expectPaired(1);
    expect(texts()[0]).toContain('[CRITICAL]');
    expect(cards()[0]).toMatchObject({ error: 'The box is nearly out of memory. Close something.', severity: 'error' });
  });
});

describe('one alert = one card: every "tell him again?" rule decides the card too', () => {
  it('a budget climbing through 50, 75 and 90 is three cards; staying over, or a restart, is none', async () => {
    let mods = await boot();
    mods.budget.setGlobalBudget(10);
    spend(mods.recordCost, 5.1);
    spend(mods.recordCost, 0.2);
    spend(mods.recordCost, 2.5);
    spend(mods.recordCost, 1.5);
    spend(mods.recordCost, 0.3);
    expectPaired(3);
    expect(cards().map((c) => c.error.match(/(\d+)%/)?.[1])).toEqual(['50', '75', '90']);

    mods = await boot(); // a fresh process: the crossing is already told
    spend(mods.recordCost, 0.1);
    mods.budget.checkBudget('ag', 0.01);
    expectPaired(3);
  });

  it('a budget whose window has turned over and crosses again is a NEW card', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(10);
    spend(recordCost, 9.2);
    expectPaired(1);
    db().prepare("UPDATE cost_records SET created_at = datetime('now', '-2 days')").run();
    for (const f of ['alert_50_sent', 'alert_75_sent', 'alert_90_sent']) {
      db().prepare(`UPDATE budgets SET ${f} = ${f} - 2 * 86400 WHERE ${f} > 0`).run();
    }
    spend(recordCost, 9.1);
    expectPaired(2);
  });

  it('a balance still under its line is no second card; topped up and falling again is a new one', async () => {
    account.openrouter = 2;
    const { tick } = await boot();
    vi.useFakeTimers({ toFake: ['Date'] });
    let now = Date.now();
    const later = async (): Promise<void> => { now += 60 * 60_000; vi.setSystemTime(now); await tick(); };
    vi.setSystemTime(now);
    await tick();
    expectPaired(1);
    await later(); // unchanged
    expectPaired(1);
    account.openrouter = 40; // the owner topped up: re-armed silently
    await later();
    expectPaired(1);
    account.openrouter = 3; // and it fell again
    await later();
    expectPaired(2);
  });

  it('no phone set up: no text, and the card is still there', async () => {
    setPhone(null);
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(10);
    spend(recordCost, 9.2);
    expect(texts()).toHaveLength(0);
    expect(cards()).toHaveLength(1);
    expect(cards()[0].error).toContain('90%');
  });

  it('the phone send failed: the card is still there', async () => {
    transportFails.on = true;
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(10);
    spend(recordCost, 9.2);
    expect(cards()).toHaveLength(1);
  });

  it('what never reaches the phone makes no card either (the "will retry" rate-limit notice)', async () => {
    const { errors, bridge } = await boot();
    errors.notifyRateLimitHit('ag', 'rate_limit');
    bridge.sendAlert('An informational line.', 'info');
    expect(texts()).toHaveLength(0);
    expect(cards()).toHaveLength(0);
  });
});

describe('the old budget path is gone: the card is the ONLY budget notification', () => {
  it('a crossing emits no `cost:alert` frame (its toast consumer was the second, fading copy)', async () => {
    const { recordCost, budget } = await boot();
    budget.setGlobalBudget(10);
    spend(recordCost, 9.5);
    expect(broadcasts.filter((b) => b.type === 'cost:alert')).toEqual([]);
    expect(cards()).toHaveLength(1);
  });
});
