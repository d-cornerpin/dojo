// A pass that bought almost nothing brakes the next routine pass, never an emergency; a person writing to the agent
// frees its waiting writers but does not lift the brake (only the clock, a reset, a model change, a shrunken history
// or the writer's provider answering again do). Driven through `checkAndCompact`'s own outcome recording.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/one-writer-box.js')).connectionMock());
vi.mock('../../agent/model.js', async () => (await import('./helpers/one-writer-box.js')).modelMock());
vi.mock('../embeddings.js', () => ({ generateEmbedding: async () => new Float32Array([1, 0, 0, 0]), queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e, getWSStatus: () => ({}) }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
vi.mock('../../vault/archive.js', () => ({ archiveMessagesBeforeCompaction: () => 'archive-1', isDreamerIgnored: () => false, getArchiveHighWaterMark: () => null }));

import { box, seedBox, AGENT, OWN } from './helpers/one-writer-box.js';
import { checkAndCompact } from '../compaction.js';
import { compactionIsBraked, __resetBrakesForTests } from '../compaction-brakes.js';
import { clearOn, __resetSummaryWriterHealthForTests } from '../writer.js';

beforeEach(async () => {
  __resetBrakesForTests(); __resetSummaryWriterHealthForTests();
  await seedBox(24, 'Manifest line: crate, bay, weight, seal. '.repeat(6));   // folding it reclaims under the low-yield floor
});
afterEach(() => { box.db?.close(); box.db = null; });

describe('low yield brakes the next pass, and a person speaking does not lift it', () => {
  it('a forced pass that bought almost nothing brakes the routine pass, not an emergency; a person speaking leaves it on', async () => {
    const pass = await checkAndCompact(AGENT, OWN, 8_000, { force: true });
    expect(pass.leafCreated, 'the pass ran and wrote one summary').toBe(1);
    expect(pass.tokensReclaimed).toBeLessThan(2_000);
    expect(compactionIsBraked(AGENT, false), 'the routine pass backs off').toBe(true);
    expect(compactionIsBraked(AGENT, true), 'an emergency still runs').toBe(false);
    clearOn({ kind: 'person-spoke', agentId: AGENT });
    expect(compactionIsBraked(AGENT, false), 'a person speaking does not lift it').toBe(true);
  });
});
