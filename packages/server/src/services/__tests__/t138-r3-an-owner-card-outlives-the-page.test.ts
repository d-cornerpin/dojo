// ════════════════════════════════════════════════════════════════════════════════════════
// t138 round 3 — AN OWNER CARD OUTLIVES THE PAGE, AND AN ALL-CLEAR TAKES IT AWAY.
//
// Round 2 put every owner text on the dashboard's existing notification cards, but only in a
// tab that was open at that moment: the card list is the tab's memory. Orchestrator ruling
// R-V333-13 (2026-10-13): no new store, table or event type — the server already knows which
// alert conditions are live (the budget latches of migration 190, the provider-balance
// latches, the error-loop's paused row, the Healer's durable state). So a dashboard that
// loads (or reconnects) asks the server for the owner cards, re-derived from that state, and
// shows them through the same cards. Dismiss is ONE route that stamps the incident's own row:
// a dismissed card stays gone for that incident, across reloads and restarts; a NEW incident
// is a new card.
//
// The same ruling: the all-clears ("reconnected on its own", "watcher recovered") and
// "Dojo is online" keep their texts exactly, but raise no card; an all-clear removes the
// trouble card it answers. And the paused agent's own chat card gives way to the owner card
// (one card per incident on screen): both carry the same words, owner card first.
//
// Every clause drives the real doors — the cost recorder, the scheduler tick, the error-loop
// door, the Healer's injury and recovery doors, the watcher-status door, the Google token
// door — and the two real routes on the config router. Only `child_process` (the phone),
// `fetch` (providers and Google), and the engine downstream of the Healer are replaced.
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 71247b35: clauses marked `it.fails` are the witness, failing before the fix;
// the fix commits flip them to `it`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t138-r3-cards');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-r3-cards');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-r3-cards', 'dojo.db'),
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

// Each clause boots the real module graph and runs the full migration chain; an import cost,
// not a timing assertion. Nothing here measures time.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const OWNER = 'owner@example.test';
const db = (): Database.Database => mockDb.current!;

/** What the providers answer right now. */
const account = { openrouter: 50, googleToken: 'ok' as 'ok' | 'dead' };

function fakeFetch(url: string | URL): Promise<Response> {
  const u = String(url);
  if (u.includes('openrouter.ai')) {
    return Promise.resolve(new Response(JSON.stringify({
      data: { total_credits: 100, total_usage: 100 - account.openrouter },
    }), { status: 200 }));
  }
  if (u.includes('googleconnect')) {
    if (account.googleToken === 'dead') {
      return Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ access_token: 'at-new', expires_in: 3600 }), { status: 200 }));
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
  account.openrouter = 50;
  account.googleToken = 'ok';
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  d.prepare(`INSERT INTO config (key, value) VALUES ('imessage_approved_senders', ?)`)
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true }]));
  d.prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
             VALUES ('prov', 'Prov', 'openai', 'api_key', 1, datetime('now'), datetime('now'))`).run();
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

/** A freshly booted process over the same database: a dashboard reload after a restart. */
async function boot() {
  vi.resetModules();
  const clock = await import('../../scheduler/clock.js');
  const { configRouter } = await import('../../gateway/routes/config.js');
  return {
    recordCost: (await import('../../costs/tracker.js')).recordCost,
    budget: await import('../../costs/budget.js'),
    errors: await import('../../agent/errors.js'),
    healer: await import('../../healer/injury-recovery.js'),
    watcher: await import('../watcher-status.js'),
    google: await import('../../google/auth.js'),
    googleAccounts: await import('../../google/accounts.js'),
    tick: async () => { await clock.runSchedulerTick(); await clock.balanceCheckSettled(); },
    /** What a dashboard that just loaded is shown. */
    cards: async (): Promise<Array<{ words: string; severity: string }>> => {
      const r = await configRouter.request('/owner-notices');
      expect(r.status).toBe(200);
      return ((await r.json()) as { data: Array<{ words: string; severity: string }> }).data;
    },
    /** The card's X. */
    dismiss: async (words: string): Promise<number> => {
      const r = await configRouter.request('/owner-notices/dismiss', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ words }),
      });
      expect(r.status).toBe(200);
      return ((await r.json()) as { data: { dismissed: number } }).data.dismissed;
    },
  };
}

function spend(recordCost: (r: Parameters<typeof import('../../costs/tracker.js').recordCost>[0]) => unknown, dollars: number): void {
  recordCost({ agentId: 'ag', modelId: 'mdl', providerId: 'prov', inputTokens: Math.round(dollars * 1_000_000), outputTokens: 0 });
}

const texts = (): string[] => transport.filter((t) => !t.includes('--help') && !t.includes('which'));
/** Live frames spoken by the platform: severity info = an all-clear's removal, else a card. */
const frames = (): Array<{ error: string; severity: unknown }> => broadcasts
  .filter((b) => b.type === 'chat:error' && b.agentId === 'platform')
  .map((b) => ({ error: String(b.error), severity: b.severity }));
const liveCards = () => frames().filter((f) => f.severity !== 'info');

describe('a budget card outlives the page', () => {
  it('it is there on load and after a restart, carries the text\'s words, and a dismissal survives both', async () => {
    let m = await boot();
    m.budget.setGlobalBudget(10);
    spend(m.recordCost, 5.1);
    expect(texts()).toHaveLength(1);
    let shown = await m.cards();
    expect(shown).toHaveLength(1);
    expect(shown[0].severity).toBe('notice');
    expect(texts()[0], 'the card is the words the phone got').toContain(shown[0].words);
    expect(shown[0].words).toBe(liveCards()[0].error);

    m = await boot(); // restart, reload
    shown = await m.cards();
    expect(shown).toHaveLength(1);
    expect(await m.dismiss(shown[0].words)).toBe(1);
    expect(await m.cards()).toEqual([]);
    m = await boot();
    expect(await m.cards(), 'a dismissal survives the restart').toEqual([]);
    spend(m.recordCost, 0.2); // the same incident, still over 50%
    expect(await m.cards()).toEqual([]);
  });

  it('a NEW crossing after dismissal is a new card', async () => {
    const m = await boot();
    m.budget.setGlobalBudget(10);
    spend(m.recordCost, 5.1);
    await m.dismiss((await m.cards())[0].words);
    spend(m.recordCost, 2.5); // 76%: a new threshold, a new text
    expect(texts()).toHaveLength(2);
    const shown = await m.cards();
    expect(shown).toHaveLength(1);
    expect(shown[0].words).toContain('75%');
  });

  it('once the budget window turns over, the incident is over: no card', async () => {
    const m = await boot();
    m.budget.setGlobalBudget(10);
    spend(m.recordCost, 9.2);
    for (const f of ['alert_50_sent', 'alert_75_sent', 'alert_90_sent']) {
      db().prepare(`UPDATE budgets SET ${f} = ${f} - 2 * 86400 WHERE ${f} > 0`).run();
    }
    expect(await m.cards()).toEqual([]);
  });
});

describe('a balance card outlives the page', () => {
  it('shown on load with the text\'s words; dismissed stays dismissed; a top-up ends it; falling again is a new card', async () => {
    account.openrouter = 2;
    let m = await boot();
    vi.useFakeTimers({ toFake: ['Date'] });
    let now = Date.now();
    const later = async (): Promise<void> => { now += 60 * 60_000; vi.setSystemTime(now); await m.tick(); };
    vi.setSystemTime(now);
    await m.tick();
    let shown = await m.cards();
    expect(shown).toHaveLength(1);
    expect(texts()[0]).toContain(shown[0].words);
    expect(shown[0].words).toBe(liveCards()[0].error);
    await m.dismiss(shown[0].words);
    m = await boot();
    expect(await m.cards()).toEqual([]);
    await later(); // still low: the same incident
    expect(await m.cards()).toEqual([]);
    account.openrouter = 40;
    await later();
    account.openrouter = 3;
    await later();
    shown = await m.cards();
    expect(shown).toHaveLength(1);
    expect(shown[0].words).toContain('$3.00');
  });
});

describe('an agent-trouble card outlives the page', () => {
  it('a paused agent: card on load with the text\'s words; dismissed stays dismissed; a clean turn ends it; a new trip is a new card', async () => {
    let m = await boot();
    const trip = (): void => { let p = false; for (let i = 0; i < 10 && !p; i++) p = m.errors.recordError('ag'); };
    trip();
    let shown = await m.cards();
    expect(shown).toHaveLength(1);
    expect(texts()[0]).toContain(shown[0].words);
    await m.dismiss(shown[0].words);
    m = await boot();
    expect(await m.cards()).toEqual([]);
    m.errors.clearErrors('ag'); // a clean turn
    db().prepare("UPDATE agents SET status = 'idle' WHERE id = 'ag'").run();
    trip();
    shown = await m.cards();
    expect(shown).toHaveLength(1);
    expect(shown[0].words).toContain('Helper');
  });

  it('the paused agent\'s own chat card carries the owner card\'s words, after it (one card on screen)', async () => {
    const m = await boot();
    let p = false;
    for (let i = 0; i < 10 && !p; i++) p = m.errors.recordError('ag');
    const owner = broadcasts.findIndex((b) => b.type === 'chat:error' && b.agentId === 'platform');
    const own = broadcasts.findIndex((b) => b.type === 'chat:error' && b.agentId === 'ag' && b.code === 'ERROR_LOOP');
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(own).toBeGreaterThan(owner);
    expect(broadcasts[own].error).toBe(broadcasts[owner].error);
  });

  it('a stuck agent (auto-recovery gave up): card on load; dismissed stays dismissed; recovery ends it; stuck again is a new card', async () => {
    let m = await boot();
    vi.useFakeTimers();
    db().prepare("UPDATE agents SET recovery_attempts = 3, status = 'error' WHERE id = 'ag'").run();
    m.healer.onAgentInjured('ag', 'fetch failed: ECONNRESET');
    let shown = await m.cards();
    expect(shown).toHaveLength(1);
    expect(texts()[0]).toContain(shown[0].words);
    await m.dismiss(shown[0].words);
    m = await boot();
    expect(await m.cards()).toEqual([]);
    m.healer.onAgentRecovered('ag');
    expect(await m.cards()).toEqual([]);
    db().prepare("UPDATE agents SET recovery_attempts = 3, status = 'error' WHERE id = 'ag'").run();
    m.healer.onAgentInjured('ag', 'fetch failed: ECONNRESET');
    expect(texts()).toHaveLength(2);
    expect(await m.cards()).toHaveLength(1);
  });
});

describe('all-clears keep their texts, raise no card, and take the trouble card away', () => {
  it('a watcher recovering: the text is unchanged, no card, and a removal for the failure card', async () => {
    const m = await boot();
    m.watcher.maybeAlertOnFailure({
      name: 'gmail', consecutiveFailures: 3, firstFailureAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      lastError: 'boom', alreadyAlerted: false,
    });
    expect(liveCards()).toHaveLength(1);
    const failure = liveCards()[0].error;
    m.watcher.maybeAlertOnRecovery({ name: 'gmail', alreadyAlerted: true, totalNotificationsSinceFailure: 2 });
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toContain('Gmail watcher has recovered and is polling normally again. 2 new emails delivered since recovery.');
    expect(liveCards(), 'the all-clear raises no card').toHaveLength(1);
    expect(frames().filter((f) => f.severity === 'info').map((f) => f.error)).toEqual([failure]);
  });

  it('a Google account reconnecting on its own: the text is unchanged, no card, and the expired card is removed', async () => {
    const m = await boot();
    const acc = m.googleAccounts.insertGoogleAccount({
      kind: 'agent', email: 'helper@example.test', connected: true,
      accessToken: 'at-old', refreshToken: 'rt-1', tokenExpiresAt: Date.now() - 1000,
    });
    account.googleToken = 'dead';
    await m.google.getValidAccessTokenForAccount(acc.id); // benched: the expired text
    expect(liveCards()).toHaveLength(1);
    const expired = liveCards()[0].error;
    expect(expired).toContain('connection expired');
    account.googleToken = 'ok';
    expect(await m.google.attemptGoogleReconnect(acc.id)).toBe('reconnected');
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toContain('Google account (helper@example.test) reconnected on its own, no action needed.');
    expect(liveCards()).toHaveLength(1);
    expect(frames().filter((f) => f.severity === 'info').map((f) => f.error)).toEqual([expired]);
  });
});
