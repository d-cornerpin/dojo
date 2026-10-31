// USER.md is saved whole: a save built on an older text, or a blank nobody asked for, is refused and writes nothing.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ text: 'REAL PROFILE', writes: 0 }));
vi.mock('../../../prompt/user-profile.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../prompt/user-profile.js');
  return {
    ...actual,
    readUserProfile: () => store.text,
    readUserProfileForEditor: () => store.text,
    writeUserProfile: (t: string) => { store.text = t; store.writes++; },
  };
});
vi.mock('../../../db/connection.js', () => ({ getDb: () => { throw new Error('no db'); }, getDbPath: () => ':memory:' }));
vi.mock('../../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }), setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [] };
});
vi.mock('../../ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { configRouter } from '../config.js';

const put = (body: unknown) => configRouter.request('/identity/USER.md', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => { store.text = 'REAL PROFILE'; store.writes = 0; });

describe('PUT /identity/USER.md', () => {
  it('refuses a save built on an older text', async () => {
    const res = await put({ content: 'mine', base: 'OLDER' });
    expect(res.status).toBe(409);
    expect(store.writes).toBe(0);
  });
  it('accepts a save built on the stored text', async () => {
    expect((await put({ content: 'mine', base: 'REAL PROFILE' })).status).toBe(200);
    expect(store.text).toBe('mine');
  });
  it('refuses a blank over a real profile when it names no base', async () => {
    expect((await put({ content: '' })).status).toBe(400);
    expect(store.writes).toBe(0);
  });
  it('lets the owner clear it on purpose, from the text he loaded', async () => {
    expect((await put({ content: '', base: 'REAL PROFILE' })).status).toBe(200);
  });
});
