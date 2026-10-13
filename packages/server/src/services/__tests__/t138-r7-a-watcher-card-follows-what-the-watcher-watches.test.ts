// ════════════════════════════════════════════════════════════════════════════════════════
// t138 round 7 — A WATCHER CARD'S SUBJECT IS EXACTLY WHAT THE WATCHER WATCHES (re-review P7).
//
// A Gmail/Outlook watcher polls an account only while it is enabled, its mail is watched and its
// Gmail/Outlook service is on (and it is connected). Round 6 tied the card to `watch_email`
// alone, so turning the account off, or its mail service off, left the card standing forever:
// the watcher skips such an account with no success and no failure. The card now asks the
// watcher's OWN predicate (minus "connected": a benched account's failure is still live, and
// reconnecting resumes polls that send the all-clear), and a toggle ends it live.
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 4c97c6b9: clauses marked `it.fails` are the witness, failing before the fix;
// the fix commits flip them to `it`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t138-r7-cards');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-r7-cards');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-r7-cards', 'dojo.db'),
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
    msAccounts: await import('../../microsoft/accounts.js'),
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

describe('P7: turning an account or its mail service off ends its watcher card, live', () => {
  const fail = (m: Awaited<ReturnType<typeof boot>>, name: 'gmail' | 'outlook', accountId: string): unknown => m.watcher.maybeAlertOnFailure({
    name, accountId, consecutiveFailures: 3, firstFailureAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    lastError: 'boom', alreadyAlerted: false,
  } as Parameters<typeof m.watcher.maybeAlertOnFailure>[0]);

  it.fails('Gmail: the account disabled; another account\'s Gmail service turned off', async () => {
    const m = await boot();
    const a = m.googleAccounts.insertGoogleAccount({ kind: 'agent', email: 'one@example.test', connected: true, watchEmail: true });
    const b = m.googleAccounts.insertGoogleAccount({ kind: 'user', email: 'two@example.test', connected: true, watchEmail: true });
    fail(m, 'gmail', a.id);
    const card = (await m.cards())[0].words;
    m.googleAccounts.updateGoogleAccount(a.id, { enabled: false });
    expect(ended()).toEqual([card]);
    expect(await m.cards()).toEqual([]);
    fail(m, 'gmail', b.id);
    expect(await m.cards()).toHaveLength(1);
    m.googleAccounts.updateGoogleAccount(b.id, { enabledServices: JSON.stringify({ gmail: false }) });
    expect(ended()).toHaveLength(2);
    expect(await m.cards()).toEqual([]);
  });

  it.fails('Outlook: the account disabled; its Outlook service turned off', async () => {
    const m = await boot();
    const a = m.msAccounts.insertMicrosoftAccount({ kind: 'agent', email: 'one@example.test', connected: true, enabled: true, watchEmail: true });
    const b = m.msAccounts.insertMicrosoftAccount({ kind: 'user', email: 'two@example.test', connected: true, enabled: true, watchEmail: true });
    fail(m, 'outlook', a.id);
    m.msAccounts.updateMicrosoftAccount(a.id, { enabled: false });
    expect(ended()).toHaveLength(1);
    fail(m, 'outlook', b.id);
    m.msAccounts.updateMicrosoftAccount(b.id, { enabledServices: JSON.stringify({ outlook: false }) });
    expect(ended()).toHaveLength(2);
    expect(await m.cards()).toEqual([]);
  });

  it('a benched (disconnected) account\'s failure is still live: its card stands', async () => {
    const m = await boot();
    const a = m.googleAccounts.insertGoogleAccount({ kind: 'agent', email: 'one@example.test', connected: true, watchEmail: true });
    fail(m, 'gmail', a.id);
    m.googleAccounts.updateGoogleAccount(a.id, { connected: false });
    expect(ended()).toEqual([]);
    expect(await m.cards()).toHaveLength(1);
  });

  it.fails('census: the watchers and the card share ONE "is this account watched" predicate', () => {
    const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const read = (rel: string): string => strip(fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8'));
    expect(read('gmail-watcher.ts')).toMatch(/function isMonitored\(v: GoogleAccountView\): boolean \{\s*return v\.connected && watchedForMail\(v, 'gmail'\);/);
    expect(read('outlook-watcher.ts')).toMatch(/function isMonitored\(v: MicrosoftAccountView\): boolean \{\s*return v\.connected && watchedForMail\(v, 'outlook'\);/);
    expect(read('watcher-owner-cards.ts')).toMatch(/watchedForMail\(/);
  });
});
