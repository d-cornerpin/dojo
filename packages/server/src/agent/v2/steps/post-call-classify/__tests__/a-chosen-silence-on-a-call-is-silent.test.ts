// A bare `[no-reply]` on a voice or phone turn ends the turn silently: no words are spoken or persisted as
// the agent's, exactly as on any other channel.
import { describe, it, expect, vi, beforeAll } from 'vitest';

const broadcastSpy = vi.fn();
const insertSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...a) }));
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertMessageIfAbsent: (...a: unknown[]) => insertSpy(...a), insertEngineEventIfAbsent: vi.fn(),
}));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => 'away' }));

import { runMigrations } from '../../../../../db/migrations.js';
import { getDb } from '../../../../../db/connection.js';
import { endTurn, modelSays } from './post-call-kit.js';
import { FXID } from '../../../../../../../../deploy/checks/fixture-vocabulary.mjs';

beforeAll(() => {
  runMigrations();
  getDb().prepare("INSERT OR IGNORE INTO agents (id, name, status, classification) VALUES (?, 'the agent', 'idle', 'sensei')").run(FXID.n4);
});

const assistantWords = (): string[] => [
  ...insertSpy.mock.calls.map(([row]) => row as { role: string; content: string }),
  ...broadcastSpy.mock.calls.map(([e]) => (e as { message?: { role: string; content: string } }).message).filter((m) => !!m),
].filter((m) => m!.role === 'assistant' && m!.content.trim().length > 0).map((m) => m!.content);

describe('a chosen silence on a call', () => {
  it.each([
    ['a voice or plain turn', {}],
    ['a phone turn', { inboundChannel: 'phone' }],
  ])('%s that answers [no-reply] speaks nothing and persists no words', async (_name, over) => {
    insertSpy.mockClear(); broadcastSpy.mockClear();
    modelSays(null);
    const out = await endTurn('[no-reply]', [], undefined, {}, over);
    expect(assistantWords()).toEqual([]);
    expect(out.directive === 'exit' && out.reason).toBe('no-tool-calls-turn-is-done');
  });
});
