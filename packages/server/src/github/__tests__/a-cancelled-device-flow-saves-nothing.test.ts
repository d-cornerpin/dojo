// A sign-in the owner cancelled (or replaced by pressing Connect again) never stores a token.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => ({ frames: [] as Array<Record<string, unknown>> }));

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-cancelled-device-flow', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { h.frames.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

import { runMigrations } from '../../db/migrations.js';
import { GITHUB_DEVICE_CODE_URL, GITHUB_TOKEN_URL, GITHUB_USER_URL, startDeviceFlow, cancelDeviceFlow } from '../device-flow.js';
import { getGithubToken } from '../account.js';

const realFetch = globalThis.fetch;
const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });

let releaseUser: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  h.frames = [];
  cancelDeviceFlow();
  mockDb.current.prepare("INSERT INTO config (key, value) VALUES ('github_client_id', 'Ov23liFIXTURECLIENT') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === GITHUB_DEVICE_CODE_URL) {
      return json({ device_code: 'dc-fixture', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    }
    if (url === GITHUB_TOKEN_URL) return json({ access_token: 't', scope: 'public_repo' });
    if (url === GITHUB_USER_URL) {
      await new Promise<void>((resolve) => { releaseUser = resolve; });
      return json({ login: 'sample-user' });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cancelDeviceFlow();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  mockDb.current?.close();
  mockDb.current = null;
});

/** Start a flow, let it reach the (held) user lookup, return once the lookup is waiting. */
async function reachUserLookup(): Promise<void> {
  const started = await startDeviceFlow();
  expect(started.ok).toBe(true);
  await vi.advanceTimersByTimeAsync(5_100);
  await vi.advanceTimersByTimeAsync(0);
}

describe('a sign-in the owner cancelled', () => {
  it('control: an uncancelled sign-in saves the token and says connected', async () => {
    await reachUserLookup();
    releaseUser();
    await vi.advanceTimersByTimeAsync(0);
    expect(getGithubToken()).toBe('t');
    expect(h.frames.some((f) => f.type === 'github:connected')).toBe(true);
  });

  it('cancelling while the user lookup is in flight saves nothing and announces nothing', async () => {
    await reachUserLookup();
    cancelDeviceFlow();
    releaseUser();
    await vi.advanceTimersByTimeAsync(0);
    expect(getGithubToken()).toBeNull();
    expect(h.frames.some((f) => f.type === 'github:connected')).toBe(false);
  });

  it('pressing Connect again while the old lookup is in flight does not let the old token win', async () => {
    await reachUserLookup();
    const second = await startDeviceFlow(); // cancels the first
    expect(second.ok).toBe(true);
    releaseUser();
    await vi.advanceTimersByTimeAsync(0);
    expect(getGithubToken()).toBeNull();
    expect(h.frames.some((f) => f.type === 'github:connected')).toBe(false);
  });
});
