// A waiting writer is asked again when the server boots: a restart is a real change (Ollama or the provider may be
// back), so the boot's memory start lets every writer that was not answering be tried once; a failed try marks it
// again. Driven through the boot's own call (`scheduleLegacyRebuildAtBoot`, as index.ts makes it) and `checkAndCompact`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/one-writer-box.js')).connectionMock());
vi.mock('../../agent/model.js', async () => (await import('./helpers/one-writer-box.js')).modelMock());
vi.mock('../embeddings.js', () => ({ generateEmbedding: async () => new Float32Array([1, 0, 0, 0]), queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e, getWSStatus: () => ({}) }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
vi.mock('../../vault/archive.js', () => ({ archiveMessagesBeforeCompaction: () => 'archive-1', isDreamerIgnored: () => false, getArchiveHighWaterMark: () => null }));

import { box, seedBox, AGENT, OWN } from './helpers/one-writer-box.js';
import { checkAndCompact } from '../compaction.js';
import { markWaiting, EVERY_AGENT, __resetSummaryWriterHealthForTests } from '../writer.js';
import { __resetBrakesForTests } from '../compaction-brakes.js';
import { scheduleLegacyRebuildAtBoot } from '../legacy-rebuild-boot.js';

beforeEach(async () => {
  __resetBrakesForTests(); __resetSummaryWriterHealthForTests();
  await seedBox();
  box.db!.prepare("UPDATE models SET is_enabled = 0 WHERE id != ?").run(OWN);   // the own model is the only writer
  markWaiting(EVERY_AGENT, OWN, '', 'not-answering');                              // it was not answering at shutdown
});
afterEach(() => { box.db?.close(); box.db = null; });

describe('a waiting writer is retried when the server boots', () => {
  it('before the boot nothing is dialled; the boot lets the own model be tried, and it writes', async () => {
    await checkAndCompact(AGENT, OWN, 8_000, { force: true });
    expect(box.calls, 'it still waits').toEqual([]);
    scheduleLegacyRebuildAtBoot();
    await checkAndCompact(AGENT, OWN, 8_000, { force: true });
    expect(box.calls.length).toBeGreaterThan(0);
    expect(box.calls.every((m) => m === OWN)).toBe(true);
  });

  it('a try after the boot that fails marks it again: the next pass dials nothing', async () => {
    box.down.add(OWN);
    scheduleLegacyRebuildAtBoot();
    await checkAndCompact(AGENT, OWN, 8_000, { force: true });
    const tried = box.calls.length;
    expect(tried).toBeGreaterThan(0);
    await checkAndCompact(AGENT, OWN, 8_000, { force: true });
    expect(box.calls.length).toBe(tried);
  });
});
