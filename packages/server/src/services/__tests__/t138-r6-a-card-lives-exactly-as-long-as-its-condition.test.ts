// ════════════════════════════════════════════════════════════════════════════════════════
// t138 round 6 — ONE RULE FOR EVERY CARD: IT LIVES EXACTLY AS LONG AS ITS CONDITION'S OWN RECORD
// SAYS THE CONDITION IS LIVE; THE SAME RECORD DECIDES THE TEXT, THE CARD AND THE CLEAR.
//
// The round 2-5 review (overhaul-plans/t138-r2-5-review.md) found the clearing signals wrong:
//   C1 a budget card for a NEW crossing was killed by the next cost record whenever an older,
//      higher latch was still set (P1);
//   I1 a Healer self-watchdog reset counted as recovery, so a Healer that keeps failing texted
//      "broken" every cycle (P2);
//   I2 the 30-minute cooldown sweep (a clock) ended the stuck card (P3);
//   I3 cards whose subject is gone (agent terminated or purged, account removed, watcher
//      disabled) stood forever and could render a raw id (P5/P6);
//   minors: the engine's own pause card used other words (two cards), and some endings sent no
//   live END (window turnover, account deleted, agent deleted).
// Driven through the real doors: the cost door and the scheduler tick, the Healer's injury,
// recovery and watchdog doors, the status writer, the purge door, the accounts' writers, the
// watcher-status door, and the two routes.
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 9eecf35e: clauses marked `it.fails` are the witness, failing before the fix;
// the fix commits flip them to `it`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t138-r6-cards');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-r6-cards');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-r6-cards', 'dojo.db'),
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
    purge: await import('../../agent/purge.js'),
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
/** Every budget latch told `seconds` earlier: the passage of a window, as the rows record it. */
const ageLatches = (seconds: number): void => {
  for (const f of ['alert_50_sent', 'alert_75_sent', 'alert_90_sent']) {
    db().prepare(`UPDATE budgets SET ${f} = ${f} - ? WHERE ${f} > 0`).run(seconds);
  }
  db().prepare("UPDATE cost_records SET created_at = datetime(created_at, ?)").run(`-${seconds} seconds`);
};

describe('C1: a budget card is the CURRENT window\'s incident', () => {
  it.fails('P1: a new 50% crossing after an earlier 90% day keeps its card through the next record', async () => {
    const m = await boot();
    m.budget.setGlobalBudget(10);
    spend(m.recordCost, 9.2); // day 1: 90%
    ageLatches(2 * 86_400);   // two days on
    (await import('../../costs/tracker.js')).invalidateDailySpendCache();
    spend(m.recordCost, 5.1); // day 3: 50%
    const card = (await m.cards())[0]?.words;
    expect(card).toContain('50%');
    spend(m.recordCost, 0.1); // the next agent call
    expect(ended(), 'nothing ended: the condition is live').not.toContain(card);
    expect((await m.cards()).map((c) => c.words)).toEqual([card]);
  });

  it.fails('window turnover is the clear: the scheduler tick ends the card live; the next crossing is a new text and card', async () => {
    const m = await boot();
    m.budget.setGlobalBudget(10);
    spend(m.recordCost, 5.1);
    const card = (await m.cards())[0].words;
    spend(m.recordCost, 0.1);
    expect(ended()).toEqual([]); // spend moving inside the window ends nothing
    ageLatches(2 * 86_400);
    await m.tick();
    expect(ended()).toEqual([card]);
    expect(await m.cards()).toEqual([]);
    (await import('../../costs/tracker.js')).invalidateDailySpendCache();
    spend(m.recordCost, 5.2);
    expect(texts()).toHaveLength(2);
    expect(await m.cards()).toHaveLength(1);
  });
});

describe('I1: only the Healer working ends "Healer broken"', () => {
  it.fails('P2: three failing watchdog cycles are ONE text; a clean Healer turn ends the card; breaking again texts again', async () => {
    const m = await boot();
    vi.useFakeTimers();
    db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('setup_completed', 'true')").run();
    m.healerAgent.startHealerSelfWatchdog();
    for (let cycle = 0; cycle < 3; cycle++) {
      db().prepare("UPDATE agents SET status = 'error' WHERE id = 'hl'").run(); // its provider is still down
      m.healer.onAgentInjured('hl', 'provider down');
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000); // the watchdog resets it to idle
    }
    const broken = (): string[] => texts().filter((t) => t.includes('Healer agent is broken'));
    expect(broken(), 'one text for one unchanged condition').toHaveLength(1);
    const card = (await m.cards()).find((c) => c.words.includes('Healer agent is broken'))?.words;
    expect(card).toBeDefined();
    m.errors.clearErrors('hl'); // the Healer completed a healthy model turn
    expect(ended()).toContain(card);
    db().prepare("UPDATE agents SET status = 'error' WHERE id = 'hl'").run();
    m.healer.onAgentInjured('hl', 'provider down');
    expect(broken()).toHaveLength(2);
  });
});

describe('I2: a clock is never evidence of recovery', () => {
  it.fails('P3: the cooldown sweep leaves the stuck card standing; real recovery ends it', async () => {
    const m = await boot();
    vi.useFakeTimers();
    db().prepare("UPDATE agents SET recovery_attempts = 3, status = 'error' WHERE id = 'ag'").run();
    m.healer.onAgentInjured('ag', 'fetch failed: ECONNRESET');
    const card = (await m.cards())[0].words;
    m.healer.onAgentRecovered('ag', 'cooldown');
    expect(ended()).toEqual([]);
    expect((await m.cards()).map((c) => c.words)).toEqual([card]);
    m.healer.onAgentRecovered('ag'); // evidence
    expect(ended()).toEqual([card]);
  });
});

describe('I3: a card whose subject is gone leaves, live, and never shows a raw id', () => {
  it.fails('P5: a stuck agent that is terminated, and one that is purged', async () => {
    const m = await boot();
    vi.useFakeTimers();
    db().prepare("UPDATE agents SET recovery_attempts = 3, status = 'error' WHERE id = 'ag'").run();
    m.healer.onAgentInjured('ag', 'fetch failed: ECONNRESET');
    const card = (await m.cards())[0].words;
    m.status.writeAgentStatus('ag', 'terminated');
    expect(ended()).toEqual([card]);
    expect(await m.cards()).toEqual([]);

    db().prepare(`INSERT INTO agents (id, name, model_id, status, recovery_attempts, created_at, updated_at)
                  VALUES ('ag2', 'Second', 'mdl', 'error', 3, datetime('now'), datetime('now'))`).run();
    m.healer.onAgentInjured('ag2', 'fetch failed: ECONNRESET');
    const second = (await m.cards())[0].words;
    m.purge.purgeAgentRows('ag2');
    expect(ended()).toContain(second);
    const after = await m.cards();
    expect(after).toEqual([]);
    expect(after.some((c) => c.words.startsWith('ag2 '))).toBe(false);
  });

  it.fails('a paused agent that is purged: its card leaves live', async () => {
    const m = await boot();
    let p = false;
    for (let i = 0; i < 10 && !p; i++) p = m.errors.recordError('ag');
    const card = (await m.cards())[0].words;
    m.purge.purgeAgentRows('ag');
    expect(ended()).toContain(card);
  });

  it.fails('P6: a failing Gmail account that is removed, and one whose watching is turned off', async () => {
    const m = await boot();
    const a = m.googleAccounts.insertGoogleAccount({ kind: 'agent', email: 'one@example.test', connected: true, watchEmail: true });
    const b = m.googleAccounts.insertGoogleAccount({ kind: 'user', email: 'two@example.test', connected: true, watchEmail: true });
    const fail = (accountId: string): unknown => m.watcher.maybeAlertOnFailure({
      name: 'gmail', accountId, consecutiveFailures: 3, firstFailureAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      lastError: 'boom', alreadyAlerted: false,
    } as Parameters<typeof m.watcher.maybeAlertOnFailure>[0]);
    fail(a.id);
    const card = (await m.cards())[0].words;
    m.googleAccounts.deleteGoogleAccount(a.id);
    expect(ended()).toEqual([card]);
    expect(await m.cards()).toEqual([]);
    fail(b.id);
    m.googleAccounts.updateGoogleAccount(b.id, { watchEmail: false });
    expect(ended()).toHaveLength(2);
    expect(await m.cards()).toEqual([]);
  });

  it.fails('M3: an expired Google account that is deleted: its card leaves live', async () => {
    const m = await boot();
    const acc = m.googleAccounts.insertGoogleAccount({
      kind: 'agent', email: 'helper@example.test', connected: true,
      accessToken: 'at-old', refreshToken: 'rt-1', tokenExpiresAt: Date.now() - 1000,
    });
    account.googleToken = 'dead';
    await m.google.getValidAccessTokenForAccount(acc.id);
    const card = (await m.cards())[0].words;
    m.googleAccounts.deleteGoogleAccount(acc.id);
    expect(ended()).toEqual([card]);
  });
});

describe('M1: on the real engine pause path the owner card is the one card', () => {
  it.fails('the engine\'s own pause notice carries the owner card\'s words (the dashboard folds them into one)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../agent/v2/recovery.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(src).not.toContain("'Agent paused after repeated errors.");
    expect(src).toMatch(/:\s*paused\s*\?\s*pausedWords\(agentId\)/);
  });
});
