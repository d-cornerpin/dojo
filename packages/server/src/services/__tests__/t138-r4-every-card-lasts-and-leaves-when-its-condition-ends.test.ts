// ════════════════════════════════════════════════════════════════════════════════════════
// t138 round 4 — EVERY CARD LASTS, AND A CARD LEAVES THE MOMENT ITS CONDITION ENDS.
//
// Round 3 left four kinds of card living only in an open tab (a Google or Microsoft sign-in
// expired, a mail watcher failing, rate-limit retries exhausted), and every card waited for the
// next page load to notice that its condition had ended. Orchestrator rulings (round 4):
//   1. those cards last the same way — re-derived on load from the incident's own row;
//   2. when the server records a condition clearing (agent resumed, balance back above the line,
//      spend dropped, sign-in restored, Healer back, memory recovered) it broadcasts the card's
//      removal on the frame path the all-clears already use — one mechanism for every kind;
//   3. the Healer's broken/missing state is re-checked on the Healer's own watchdog, and memory
//      on the scheduler's existing tick, not only on the next injury or spawn;
//   4. a manual resume ends the paused agent's incident, so its card cannot come back.
// Driven through the real doors (the Google token door and its connect writer, the watcher
// status door, the rate-limit retry ladder, the cost door, the scheduler tick, the status writer,
// the Healer's watchdog) and the two real routes.
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 7145d73b (plus a no-behaviour refactor of the door's frame and 193's three empty columns): clauses marked `it.fails` are the witness, failing before the fix;
// the fix commits flip them to `it`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t138-r4-cards');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-r4-cards');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-r4-cards', 'dojo.db'),
  };
});

const { broadcasts, transport, memory, runtime } = vi.hoisted(() => ({
  broadcasts: [] as Array<Record<string, unknown>>,
  transport: [] as string[],
  /** Free memory as `vm_stat` reports it, MB of a 16 GB box. */
  memory: { freeMb: 8000 },
  /** What the agent runtime does when the rate-limit ladder retries: still limited, or through. */
  runtime: { limited: true },
}));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { broadcasts.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({
    notifyPrimaryOfInjury: vi.fn(async () => undefined),
    handleMessage: vi.fn(async () => {
      if (runtime.limited) throw Object.assign(new Error('429 rate limited'), { provider: { class: 'rate_limit' } });
    }),
  }),
}));
vi.mock('../../agent/a2a-transport.js', () => ({ deliverA2AMessage: vi.fn(async () => ({ delivered: true })) }));
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const record = (...a: unknown[]): string => {
    if (a[0] === 'vm_stat') {
      const usedPages = Math.round(((16384 - memory.freeMb) * 1024 * 1024) / 16384);
      return `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active: ${usedPages}.\nPages wired down: 0.\nPages occupied by compressor: 0.\n`;
    }
    transport.push(JSON.stringify(a));
    return '';
  };
  return { ...orig, default: { ...orig, execSync: record, execFileSync: record }, execSync: record, execFileSync: record };
});

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  const totalmem = (): number => 16384 * 1024 * 1024;
  return { ...orig, default: { ...orig, totalmem }, totalmem };
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
  memory.freeMb = 8000;
  runtime.limited = true;
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
    status: await import('../../agent/agent-status.js'),
    rateLimit: await import('../../agent/rate-limit-retry.js'),
    resources: await import('../resource-monitor.js'),
    healerAgent: await import('../../healer/healer-agent.js'),
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

/** The removals broadcast so far: each names the card that leaves. */
const ended = (): string[] => frames().filter((f) => f.severity === 'info').map((f) => f.error);

describe('ruling 1: the remaining cards last too', () => {
  it.fails('an expired Google sign-in: a card on load in the text\'s words; dismissed stays dismissed; a restored sign-in ends it, live', async () => {
    let m = await boot();
    const acc = m.googleAccounts.insertGoogleAccount({
      kind: 'agent', email: 'helper@example.test', connected: true,
      accessToken: 'at-old', refreshToken: 'rt-1', tokenExpiresAt: Date.now() - 1000,
    });
    account.googleToken = 'dead';
    await m.google.getValidAccessTokenForAccount(acc.id);
    m = await boot(); // reload after a restart
    let shown = await m.cards();
    expect(shown).toHaveLength(1);
    expect(texts()[0]).toContain(shown[0].words);
    // The owner reconnects in Settings: the connect flow's writer marks it connected.
    m.googleAccounts.updateGoogleAccount(acc.id, { connected: true, accessToken: 'at-new' });
    expect(ended(), 'the card leaves open dashboards at once').toEqual([shown[0].words]);
    expect(await m.cards()).toEqual([]);
    // Benched again later: a new incident, a new card; dismissed, it stays gone.
    m.googleAccounts.updateGoogleAccount(acc.id, { tokenExpiresAt: Date.now() - 1000 });
    account.googleToken = 'dead';
    await m.google.getValidAccessTokenForAccount(acc.id);
    shown = await m.cards();
    expect(shown).toHaveLength(1);
    await m.dismiss(shown[0].words);
    m = await boot();
    expect(await m.cards()).toEqual([]);
  });

  it.fails('a watcher failing: a card on load; a restart mid-failure does not text again; recovery ends it', async () => {
    let m = await boot();
    const failing = (): boolean => m.watcher.maybeAlertOnFailure({
      name: 'gmail', consecutiveFailures: 3, firstFailureAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      lastError: 'boom', alreadyAlerted: false,
    });
    expect(failing()).toBe(true);
    m = await boot(); // restart: the watcher's memory of "already alerted" is gone, the failure is not
    expect(failing()).toBe(true);
    expect(texts(), 'one text for one failure').toHaveLength(1);
    const shown = await m.cards();
    expect(shown).toHaveLength(1);
    expect(texts()[0]).toContain(shown[0].words);
    m.watcher.maybeAlertOnRecovery({ name: 'gmail', alreadyAlerted: false, totalNotificationsSinceFailure: 0 });
    expect(texts(), 'the all-clear still reaches him after the restart').toHaveLength(2);
    expect(await m.cards()).toEqual([]);
  });

  it.fails('rate-limit retries exhausted: a card on load; the agent getting through ends it, live', async () => {
    const m = await boot();
    vi.useFakeTimers();
    m.rateLimit.scheduleRateLimitRetry('ag', null, 'hello');
    await vi.runAllTimersAsync();
    const exhausted = texts().filter((t) => t.includes('rate-limited for'));
    expect(exhausted).toHaveLength(1);
    const shown = (await m.cards()).filter((c) => c.words.includes('rate-limited for'));
    expect(shown).toHaveLength(1);
    expect(exhausted[0]).toContain(shown[0].words);
    m.status.writeAgentStatus('ag', 'working'); // its next turn goes through
    expect(ended()).toContain(shown[0].words);
    expect((await m.cards()).filter((c) => c.words.includes('rate-limited for'))).toEqual([]);
  });
});

describe('ruling 2: a card leaves the moment the server records its condition ending', () => {
  it.fails('a balance back above its line', async () => {
    account.openrouter = 2;
    const m = await boot();
    vi.useFakeTimers({ toFake: ['Date'] });
    let now = Date.now();
    vi.setSystemTime(now);
    await m.tick();
    const words = (await m.cards())[0].words;
    account.openrouter = 40;
    now += 60 * 60_000; vi.setSystemTime(now);
    await m.tick();
    expect(ended()).toEqual([words]);
  });

  it.fails('a budget whose spend dropped back under the line, and a budget whose limit the owner changed', async () => {
    const m = await boot();
    m.budget.setGlobalBudget(10);
    spend(m.recordCost, 9.2);
    const words = (await m.cards())[0].words;
    db().prepare("UPDATE cost_records SET created_at = datetime('now', '-2 days')").run(); // spend ages out
    (await import('../../costs/tracker.js')).invalidateDailySpendCache();
    m.budget.checkBudget('ag', 0.01);
    expect(ended()).toEqual([words]);
    expect(await m.cards()).toEqual([]);

    m.budget.setAgentBudget('ag', 4, 'daily');
    spend(m.recordCost, 3.8);
    const agentWords = (await m.cards())[0].words;
    m.budget.setAgentBudget('ag', 40, 'daily');
    expect(ended()).toContain(agentWords);
  });

  it.fails('ruling 4: a manual resume ends the paused incident, live, and a later manual pause cannot bring it back', async () => {
    const m = await boot();
    let p = false;
    for (let i = 0; i < 10 && !p; i++) p = m.errors.recordError('ag');
    const words = (await m.cards())[0].words;
    m.status.writeAgentStatus('ag', 'idle'); // resumed from its detail page; no turn has run
    expect(ended()).toEqual([words]);
    m.status.writeAgentStatus('ag', 'paused'); // paused by hand
    expect(await m.cards()).toEqual([]);
  });

  it.fails('a stuck agent recovering', async () => {
    const m = await boot();
    vi.useFakeTimers();
    db().prepare("UPDATE agents SET recovery_attempts = 3, status = 'error' WHERE id = 'ag'").run();
    m.healer.onAgentInjured('ag', 'fetch failed: ECONNRESET');
    const words = (await m.cards())[0].words;
    m.healer.onAgentRecovered('ag');
    expect(ended()).toEqual([words]);
  });
});

describe('ruling 3: the clearing is noticed on the existing clocks', () => {
  it.fails('the Healer\'s own watchdog notices it is back: "missing" ends, live, with no injury needed', async () => {
    const m = await boot();
    vi.useFakeTimers();
    db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('setup_completed', 'true')").run();
    db().prepare("UPDATE agents SET status = 'terminated' WHERE id = 'hl'").run();
    db().prepare("UPDATE agents SET status = 'error' WHERE id = 'ag'").run();
    m.healer.onAgentInjured('ag', 'provider down');
    await vi.advanceTimersByTimeAsync(10 * 60_000); // auto-wake, grace, the Healer is looked for
    const words = (await m.cards()).find((c) => c.words.includes('Healer agent is missing'))?.words;
    expect(words).toBeDefined();
    db().prepare("UPDATE agents SET status = 'idle' WHERE id = 'hl'").run(); // restored
    m.healerAgent.startHealerSelfWatchdog();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(ended()).toContain(words);
    expect((await m.cards()).filter((c) => c.words.includes('Healer agent is missing'))).toEqual([]);
  });

  it.fails('the Healer\'s own watchdog notices it healthy again: "broken" ends, live', async () => {
    const m = await boot();
    vi.useFakeTimers();
    db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('setup_completed', 'true')").run();
    db().prepare("UPDATE agents SET status = 'error' WHERE id = 'hl'").run();
    m.healer.onAgentInjured('hl', 'provider down');
    const words = (await m.cards()).find((c) => c.words.includes('Healer agent is broken'))?.words;
    expect(words).toBeDefined();
    db().prepare("UPDATE agents SET status = 'idle' WHERE id = 'hl'").run(); // it came back by itself
    m.healerAgent.startHealerSelfWatchdog();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(ended()).toContain(words);
  });

  it.fails('the scheduler\'s tick re-measures memory while it is low: recovery ends the card with no spawn needed', async () => {
    const m = await boot();
    memory.freeMb = 300;
    m.resources.canSpawnAgent();
    const words = (await m.cards()).find((c) => c.words.includes('512MB'))?.words;
    expect(words).toBeDefined();
    memory.freeMb = 6000;
    await m.tick();
    expect(ended()).toContain(words);
    expect(await m.cards()).toEqual([]);
  });
});
