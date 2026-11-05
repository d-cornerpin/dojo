// v3.5 field fix 3, test-2 round. OWNER RULING (2026-11-04), verbatim: "obviously if a user types a
// message on the dashboard, they get a response on the dashboard." The owner typing on the dashboard
// is proof he is at it, so a dashboard message sent while presence says "away" flips presence back
// to in-dojo, and the dashboard's presence pill is told (`system:presence`). Away keeps forwarding
// everything else to the phone until then.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-presence-flip', 'dojo.db'),
  };
});
const frames: Array<Record<string, unknown>> = [];
vi.mock('../ws.js', () => ({ broadcast: (e: Record<string, unknown>) => { frames.push(e); }, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({
  injectAttachmentBlocks: vi.fn(), enforceModelCapabilities: () => ({ useTools: true }),
  getAgentRuntime: () => ({ handleMessage: async () => undefined }), clearConsumedOneShotFlags: vi.fn(),
}));
vi.mock('../../memory/embeddings.js', () => ({
  queueEmbedding: vi.fn(), generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  storeEmbedding: async () => { /* not exercised */ }, refreshEmbedding: () => { /* not exercised */ },
}));

import { runMigrations } from '../../db/migrations.js';
import { submitUserMessage } from '../routes/chat.js';
import { getPresence, setPresence } from '../../services/presence.js';

const AGENT = 'agent-primary';

beforeEach(() => {
  mockDb.current?.close();
  const d = new Database(':memory:');
  mockDb.current = d;
  runMigrations();
  d.prepare(`INSERT INTO agents (id, name, status) VALUES (?, 'Primary', 'idle')`).run(AGENT);
  frames.length = 0;
});

describe('a dashboard message means the owner is here', () => {
  it('THE RED: typed on the dashboard while marked away: presence flips to in-dojo and the pill is told', async () => {
    setPresence('away');
    const r = await submitUserMessage(AGENT, 'what did the venue say?');
    expect(r.ok).toBe(true);
    expect(getPresence()).toBe('in_dojo');
    expect(frames.some((f) => f.type === 'system:presence' && (f.data as { status?: string })?.status === 'in_dojo')).toBe(true);
  });

  it('CONTROL: already in the dojo, nothing changes and nothing is announced', async () => {
    setPresence('in_dojo');
    await submitUserMessage(AGENT, 'hello');
    expect(getPresence()).toBe('in_dojo');
    expect(frames.some((f) => f.type === 'system:presence')).toBe(false);
  });
});
