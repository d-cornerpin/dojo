// ════════════════════════════════════════════════════════════════════════════════════════
// t138 round 5 — THE LAST TWO GAPS: A DISMISSAL REACHES EVERY TAB; A WATCHER SURVIVES A RESTART.
//
// Orchestrator rulings (round 5):
//   1. Dismissing a card in one tab removes it from every open tab: the dismiss route sends the
//      card's END on the one owner-card frame path.
//   2. A failing mail/chat watcher across a server restart: its failing state is recorded per
//      account, so after a restart a still-failing watcher neither texts again nor loses its
//      card, and one that recovered while the server was down clears it (its all-clear still
//      goes). One account's success never clears another account's failure.
// Driven through the real dismiss route, the watcher-status doors the three watchers call, and
// a source census of those three watchers' calls (their poll loops need live mail APIs).
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 7f876014: clauses marked `it.fails` are the witness, failing before the fix;
// the fix commits flip them to `it`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t138-r5-cards');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-r5-cards');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-r5-cards', 'dojo.db'),
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

const ended = (): string[] => frames().filter((f) => f.severity === 'info').map((f) => f.error);
const failing = (m: Awaited<ReturnType<typeof boot>>, accountId: string): boolean => m.watcher.maybeAlertOnFailure({
  name: 'gmail', accountId, consecutiveFailures: 3, firstFailureAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  lastError: 'boom', alreadyAlerted: false,
} as Parameters<typeof m.watcher.maybeAlertOnFailure>[0]);

describe('ruling 1: a dismissal reaches every open tab', () => {
  it('the dismiss route sends the card\'s END on the owner-card frame path', async () => {
    const m = await boot();
    m.budget.setGlobalBudget(10);
    spend(m.recordCost, 5.1);
    const words = (await m.cards())[0].words;
    expect(await m.dismiss(words)).toBe(1);
    expect(ended()).toEqual([words]);
  });

  it('dismissing words that match no card sends nothing', async () => {
    const m = await boot();
    expect(await m.dismiss('No such card.')).toBe(0);
    expect(ended()).toEqual([]);
  });
});

describe('ruling 2: a watcher\'s failing state survives a restart, per account', () => {
  it('a still-failing account after a restart: no second text, and its card is still there', async () => {
    let m = await boot();
    expect(failing(m, 'acct-a')).toBe(true);
    m = await boot(); // restart: the watcher's in-memory flag is gone
    expect(failing(m, 'acct-a')).toBe(true);
    expect(texts()).toHaveLength(1);
    expect(await m.cards()).toHaveLength(1);
  });

  it('an account that recovered while the server was down: its first good poll clears it, and the all-clear goes', async () => {
    let m = await boot();
    failing(m, 'acct-a');
    const words = (await m.cards())[0].words;
    m = await boot();
    // The watcher's first poll after the restart succeeds; its in-memory flag says "not alerted".
    expect(m.watcher.watcherFailingOnRecord('gmail', 'acct-a')).toBe(true);
    m.watcher.maybeAlertOnRecovery({ name: 'gmail', accountId: 'acct-a', alreadyAlerted: false, totalNotificationsSinceFailure: 0 } as Parameters<typeof m.watcher.maybeAlertOnRecovery>[0]);
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toContain('Gmail watcher has recovered');
    expect(ended()).toEqual([words]);
    expect(await m.cards()).toEqual([]);
    expect(m.watcher.watcherFailingOnRecord('gmail', 'acct-a')).toBe(false);
  });

  it('one account recovering does not clear another account\'s failure', async () => {
    const m = await boot();
    failing(m, 'acct-a');
    failing(m, 'acct-b');
    m.watcher.maybeAlertOnRecovery({ name: 'gmail', accountId: 'acct-a', alreadyAlerted: true, totalNotificationsSinceFailure: 0 } as Parameters<typeof m.watcher.maybeAlertOnRecovery>[0]);
    expect(m.watcher.watcherFailingOnRecord('gmail', 'acct-b')).toBe(true);
    expect(await m.cards(), 'acct-b is still failing').toHaveLength(1);
    expect(m.watcher.watcherFailingOnRecord('gmail', 'acct-c'), 'a healthy account has nothing on record').toBe(false);
  });

  it('census: every watcher passes its account and consults the record before deciding "not alerted"', () => {
    const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const read = (rel: string): string => strip(fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8'));
    for (const [file, name, account] of [
      ['gmail-watcher.ts', 'gmail', 'accountId'], ['outlook-watcher.ts', 'outlook', 'accountId'], ['teams-watcher.ts', 'teams', null],
    ] as const) {
      const src = read(file);
      expect(src, `${file}: the recovery gate consults the record`).toMatch(
        new RegExp(`if \\((?:s\\.)?alreadyAlerted \\|\\| watcherFailingOnRecord\\('${name}'${account ? `, ${account}` : ''}\\)\\)`));
      if (account) {
        expect(src, `${file}: the failure door is told the account`).toMatch(new RegExp(`maybeAlertOnFailure\\(\\{\\s*name: '${name}', ${account},`));
        expect(src, `${file}: the recovery door is told the account`).toMatch(new RegExp(`maybeAlertOnRecovery\\(\\{\\s*name: '${name}', ${account},`));
      }
    }
  });
});
