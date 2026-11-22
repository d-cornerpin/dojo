// A turn whose preflight throws after its record was written, or that abandons, still leaves its row closed: the
// wrapper every turn passes through closes what the turn's own end did not.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const exit = { how: 'throw' as 'throw' | 'abandon' };
vi.mock('../steps/preflight/index.js', async () => {
  const { startTurn } = await import('../turn-record.js');
  return { runPreflight: async (bag: { turnNumber?: number }) => {
    bag.turnNumber = startTurn({ agentId: 'agent-main', kind: 'user', subjectKind: 'conv', subjectId: null, rootKind: null, rootId: null, sourceMessageId: null, convKey: null });
    if (exit.how === 'throw') throw new Error('the model provider could not be reached');
    return { directive: 'abandon' };
  } };
});

import { runMigrations } from '../../../db/migrations.js';
import { freshReplyDb, testDb, AGENT } from './helpers/reply-sender.js';
import { runV2Turn } from '../loop.js';

beforeEach(() => freshReplyDb(runMigrations));
const openRows = (): number => (testDb().prepare('SELECT COUNT(*) AS n FROM turns WHERE agent_id = ? AND ended_at IS NULL').get(AGENT) as { n: number }).n;

describe('every way out of a turn closes its row', () => {
  it('a preflight that throws after the turn was recorded', async () => {
    exit.how = 'throw';
    await expect(runV2Turn(AGENT)).rejects.toThrow('could not be reached');
    expect(openRows()).toBe(0);
  });

  it('a turn that abandons after it was recorded', async () => {
    exit.how = 'abandon';
    await runV2Turn(AGENT);
    expect(openRows()).toBe(0);
  });
});
