// ════════════════════════════════════════════════════════════════════════════════════════
// t138 (#8) — A PROVIDER BALANCE BELOW ITS WARNING THRESHOLD IS NOTICED WITH NO PAGE OPEN.
//
// At v3.3.2 the OpenRouter and DeepSeek threshold checks lived INSIDE the two GET routes the
// Ledger page calls (`/api/config/openrouter/credits`, `/api/config/deepseek/balance`). With the
// page closed nothing checked, and when it was open the alert it sent was `'warning'`, which
// `sendAlert` drops before the phone. The check now runs on the scheduler's own clock, and the
// routes only read.
//
// Driven through the real doors: the scheduler's tick (`runSchedulerTick`, the body the 30 s
// interval runs), the real threshold-save routes, the real credential store (in a scratch home),
// the real `sendAlert` and iMessage door. Only the provider's HTTP API (`fetch`) and the
// operating-system transport under iMessage are replaced.
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 00a2b34d: clauses marked `it.fails` are the witness, failing before the fix;
// the fix commits flip them to `it`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t138-balance');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-balance');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-balance', 'dojo.db'),
  };
});

const { transport } = vi.hoisted(() => ({ transport: [] as string[] }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const record = (...a: unknown[]): string => { transport.push(JSON.stringify(a)); return ''; };
  return { ...orig, default: { ...orig, execSync: record, execFileSync: record }, execSync: record, execFileSync: record };
});

import { runMigrations } from '../../db/migrations.js';

const OWNER = 'owner@example.test';
const db = (): Database.Database => mockDb.current!;

/** What each provider's API answers right now. `null` = the call fails (network down). */
const account = { openrouter: 2 as number | null, deepseek: 50 as number | null };
const fetchCalls: string[] = [];

function fakeFetch(url: string | URL): Promise<Response> {
  const u = String(url);
  fetchCalls.push(u);
  if (u.includes('openrouter.ai')) {
    if (account.openrouter === null) return Promise.reject(new Error('network down'));
    return Promise.resolve(new Response(JSON.stringify({
      data: { total_credits: 100, total_usage: 100 - account.openrouter },
    }), { status: 200 }));
  }
  if (u.includes('deepseek.com')) {
    if (account.deepseek === null) return Promise.reject(new Error('network down'));
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
  transport.length = 0;
  fetchCalls.length = 0;
  account.openrouter = 2;
  account.deepseek = 50;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  d.prepare(`INSERT INTO config (key, value) VALUES ('imessage_approved_senders', ?)`)
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true }]));
  d.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
             VALUES ('or', 'Router', 'openai-compatible', 'https://openrouter.ai/api/v1', 'api_key', 1, datetime('now'), datetime('now'))`).run();
  d.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
             VALUES ('ds', 'Deep', 'openai-compatible', 'https://api.deepseek.com/v1', 'api_key', 1, datetime('now'), datetime('now'))`).run();
  const loader = await import('../../config/loader.js');
  loader.clearSecretsCache();
  loader.setProviderCredential('or', 'sk-test-router');
  loader.setProviderCredential('ds', 'sk-test-deep');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
  vi.resetModules();
});

/** A freshly booted process: the scheduler's tick and the config routes, as the server has them. */
async function boot(): Promise<{
  tick: () => Promise<'ran' | 'skipped'>;
  route: (method: string, p: string, body?: unknown) => Promise<Response>;
}> {
  vi.resetModules();
  const clock = await import('../../scheduler/clock.js');
  const { configRouter } = await import('../../gateway/routes/config.js');
  const tick = async (): Promise<'ran' | 'skipped'> => {
    const r = await clock.runSchedulerTick();
    // The balance check rides the tick but must never hold the due scan hostage to a slow
    // provider; let its own promise settle before the clause reads the result.
    await new Promise((res) => setTimeout(res, 50));
    return r;
  };
  const route = (method: string, p: string, body?: unknown): Promise<Response> => configRouter.request(p, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { tick, route };
}

function ownerTexts(): string[] {
  const rows = db().prepare(
    "SELECT recipient_id FROM deliveries WHERE agent_id = 'platform' AND tool = 'alert' ORDER BY rowid",
  ).all() as Array<{ recipient_id: string }>;
  expect(rows.every((r) => r.recipient_id === OWNER)).toBe(true);
  return transport.filter((t) => !t.includes('--help') && !t.includes('which'));
}
const latch = (provider: 'openrouter' | 'deepseek'): string | null =>
  (db().prepare('SELECT value FROM config WHERE key = ?').get(`${provider}_threshold_alerted`) as { value: string } | undefined)?.value ?? null;
const routerChecks = (): number => fetchCalls.filter((u) => u.includes('openrouter.ai')).length;

/** Move the process clock past the balance check's cadence. */
let fakeNow = Date.now();
function advance(ms: number): void {
  fakeNow += ms;
  vi.setSystemTime(fakeNow);
}
const HOUR = 60 * 60_000;

describe('the RED witness (#8): the Ledger page is closed, the balance is below the line', () => {
  it.fails('the scheduler tick checks the balance and tells the owner once', async () => {
    const { tick } = await boot();
    await tick();
    expect(routerChecks(), 'a check happened with no page open').toBe(1);
    const sent = ownerTexts();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('OpenRouter');
    expect(sent[0]).toContain('$2.00');
    expect(latch('openrouter')).not.toBeNull();
  });

  it.fails('DeepSeek is watched the same way', async () => {
    account.openrouter = 50;
    account.deepseek = 1.5;
    const { tick } = await boot();
    await tick();
    const sent = ownerTexts();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('DeepSeek');
    expect(sent[0]).toContain('$1.50');
  });
});

describe('the Ledger page only READS now', () => {
  it.fails('opening the page (the GET routes) returns the balance and decides nothing', async () => {
    const { route } = await boot();
    const r1 = await route('GET', '/openrouter/credits');
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { data: { balance: number } }).data.balance).toBe(2);
    const r2 = await route('GET', '/deepseek/balance');
    expect(((await r2.json()) as { data: { balance: number } }).data.balance).toBe(50);
    expect(latch('openrouter'), 'the route writes no latch').toBeNull();
    expect(ownerTexts()).toHaveLength(0);
  });
});

describe('once per real crossing', () => {
  it.fails('runs on a cadence, not every 30 s tick; a later check while still low says nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    fakeNow = Date.now();
    vi.setSystemTime(fakeNow);
    const { tick } = await boot();
    await tick();
    advance(30_000);
    await tick();
    expect(routerChecks(), 'two ticks 30 s apart: one provider call').toBe(1);
    advance(HOUR);
    await tick();
    expect(routerChecks()).toBe(2);
    expect(ownerTexts()).toHaveLength(1);
  });

  it.fails('a restart does not re-alert', async () => {
    let { tick } = await boot();
    await tick();
    expect(ownerTexts()).toHaveLength(1);
    ({ tick } = await boot());
    await tick();
    expect(routerChecks(), 'the fresh process checked').toBe(2);
    expect(ownerTexts()).toHaveLength(1);
  });

  it.fails('a top-up re-arms silently, and the next real drop is told again', async () => {
    let { tick } = await boot();
    await tick();
    account.openrouter = 40;
    ({ tick } = await boot());
    await tick();
    expect(latch('openrouter')).toBeNull();
    expect(ownerTexts()).toHaveLength(1);
    account.openrouter = 3;
    ({ tick } = await boot());
    await tick();
    expect(ownerTexts()).toHaveLength(2);
  });

  it('a failed provider call changes nothing', async () => {
    account.openrouter = null;
    const { tick } = await boot();
    await tick();
    expect(ownerTexts()).toHaveLength(0);
    expect(latch('openrouter')).toBeNull();
  });
});

describe('backwards lifecycle', () => {
  it.fails('threshold lowered below the balance after an alert: silent re-arm', async () => {
    let { tick, route } = await boot();
    await tick();
    expect(ownerTexts()).toHaveLength(1);
    expect((await route('POST', '/openrouter/threshold', { threshold: 1 })).status).toBe(200);
    ({ tick } = await boot());
    await tick();
    expect(latch('openrouter')).toBeNull();
    expect(ownerTexts()).toHaveLength(1);
  });

  it.fails('threshold changed while still below it: not a new crossing, no second text (both providers alike)', async () => {
    account.deepseek = 2;
    let { tick, route } = await boot();
    await tick();
    expect(ownerTexts()).toHaveLength(2);
    await route('POST', '/openrouter/threshold', { threshold: 4 });
    await route('POST', '/deepseek/threshold', { threshold: 4 });
    ({ tick } = await boot());
    await tick();
    expect(ownerTexts()).toHaveLength(2);
  });

  it.fails('threshold raised above a balance that was fine: the next check tells the owner once', async () => {
    account.openrouter = 8;
    let { tick, route } = await boot();
    await tick();
    expect(ownerTexts()).toHaveLength(0);
    await route('POST', '/openrouter/threshold', { threshold: 10 });
    ({ tick } = await boot());
    await tick();
    const sent = ownerTexts();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('$10');
  });

  it.fails('provider key removed: no call, no text, latch cleared; key re-added on a low account: told once', async () => {
    let { tick } = await boot();
    await tick();
    expect(ownerTexts()).toHaveLength(1);

    const secretsPath = path.join(HOME, '.dojo', 'secrets.yaml');
    const loader = await import('../../config/loader.js');
    const y = fs.readFileSync(secretsPath, 'utf-8').replace(/\n\s+or:\n\s+api_key:[^\n]*/, '');
    fs.writeFileSync(secretsPath, y);
    loader.clearSecretsCache();
    expect(loader.getProviderCredential('or')).toBeNull();

    ({ tick } = await boot());
    const before = routerChecks();
    await tick();
    expect(routerChecks(), 'no key, no call').toBe(before);
    expect(latch('openrouter')).toBeNull();
    expect(ownerTexts()).toHaveLength(1);

    (await import('../../config/loader.js')).setProviderCredential('or', 'sk-test-router-2');
    ({ tick } = await boot());
    await tick();
    expect(ownerTexts()).toHaveLength(2);
  });
});
