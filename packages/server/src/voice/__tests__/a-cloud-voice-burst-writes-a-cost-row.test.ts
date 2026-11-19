// Speech bought from the cloud voice lands in the cost ledger: one row per spoken burst, under the agent that
// spoke, however many sentences the burst carried.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

type Handler = (...a: unknown[]) => void;
const handlers = new Map<string, Handler>();
const fire = (ev: string, ...a: unknown[]): void => handlers.get(ev)?.(...a);
// Hume answers only once asked to close, as on a call: push, flush and close go out back to back.
const pushed: string[] = [];
const socket = {
  on: (ev: string, h: Handler) => { handlers.set(ev, h); },
  waitForOpen: async () => {},
  close: () => {},
  sendPublish: (m: Record<string, unknown>) => {
    if (typeof m.text === 'string') pushed.push(m.text);
    if (m.close) setTimeout(() => { for (const t of pushed.splice(0)) fire('message', audio(t)); fire('close'); }, 0);
  },
};
const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('hume', () => ({ HumeClient: class { tts = { streamInput: { connect: async () => socket } }; } }));
vi.mock('../../config/loader.js', () => ({ getProviderCredential: () => 'stand-in-key' }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }) };
});

const { runMigrations } = await import('../../db/migrations.js');
const { HumeStreamSession } = await import('../hume-engine.js');

function audio(text: string) {
  return {
    type: 'audio', audio: Buffer.from([1, 2, 3, 4]).toString('base64'), generationId: 'g', isLastChunk: true, text,
  };
}

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a cloud voice burst writes a cost row', () => {
  it('two sentences in one burst are one row, under the agent that spoke, priced per character', async () => {
    const s = new HumeStreamSession({ voiceId: 'v', agentId: 'agent-1' });
    await s.open();
    s.push('Milk is on the list.');
    s.push('Anything else?');
    await s.close();
    const rows = mockDb.current!.prepare('SELECT agent_id, model_id, request_type, cost_usd FROM cost_records').all();
    const chars = 'Milk is on the list.'.length + 'Anything else?'.length;
    expect(rows).toEqual([{ agent_id: 'agent-1', model_id: 'hume-octave', request_type: 'speech', cost_usd: expect.closeTo(chars * 0.0001, 10) }]);
  });

  it('a burst that never pushed words writes no row', async () => {
    const s = new HumeStreamSession({ voiceId: 'v', agentId: 'agent-1' });
    await s.open();
    await s.close();
    expect(mockDb.current!.prepare('SELECT COUNT(*) AS n FROM cost_records').get()).toEqual({ n: 0 });
  });
});
