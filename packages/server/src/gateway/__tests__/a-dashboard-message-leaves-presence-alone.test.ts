// v3.5 field fix 3, re-review 2 (S9). OWNER RULING (2026-11-04), verbatim: "obviously if a user types a
// message on the dashboard, they get a response on the dashboard." That is the REPLY's binding
// (`agent/v2/reply-destination.ts`), which answers a dashboard ask on the dashboard whatever the
// presence. The test-2 round also flipped presence to in-dojo when he typed there while away, which
// went past his words: every LATER proactive reply then stayed on the dashboard, so an owner who typed
// once from his phone's browser and walked away missed what away mode would have texted him. The flip
// and its `system:presence` frame are removed; presence is his own switch.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-presence-kept', 'dojo.db'),
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

describe('a dashboard message leaves the owner\'s presence as he set it', () => {
  it('THE RED: typed on the dashboard while marked away: presence stays away, and nothing announces a change', async () => {
    setPresence('away');
    const r = await submitUserMessage(AGENT, 'what did the venue say?');
    expect(r.ok).toBe(true);
    expect(getPresence()).toBe('away');
    expect(frames.some((f) => f.type === 'system:presence')).toBe(false);
  });

  it('CONTROL: in the dojo, nothing changes either', async () => {
    setPresence('in_dojo');
    await submitUserMessage(AGENT, 'hello');
    expect(getPresence()).toBe('in_dojo');
  });
});
