// After a tight-memory moment refuses the Dojo's small writer for an agent ("no room") and its full-context turn
// parks on a writer coming back, the Healer's frequent sweep measures the memory again: once a summary fits, the
// wait ends and the parked turn's wake fires, with nobody speaking to the agent. Driven through the real refusal
// and `runFrequentAutoFixes`; the free-memory reading is faked at its one seam.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/one-writer-box.js')).connectionMock());
vi.mock('../../agent/model.js', async () => (await import('./helpers/one-writer-box.js')).modelMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const memory = vi.hoisted(() => ({ free: 0 as number | null, reads: 0 }));
vi.mock('../../agent/local-model-fit.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  freeWriterWindowTokens: async () => { memory.reads++; return memory.free; },
}));

import { box, seedBox, AGENT, OWN, WRITER } from './helpers/one-writer-box.js';
import { generateSummary } from '../summarize.js';
import { markWaiting, waiting, spanWaitsForAWriter, whenAWriterCanRun, EVERY_AGENT, __resetSummaryWriterHealthForTests } from '../writer.js';
import { runFrequentAutoFixes } from '../../healer/auto-fix.js';

let woke = false;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  __resetSummaryWriterHealthForTests();
  await seedBox(2);
  memory.free = 1_000; memory.reads = 0; woke = false;
  markWaiting(EVERY_AGENT, OWN, '', 'not-answering');   // the own model is down: the small writer is the fallback
  const r = await generateSummary({ content: 'Manifest line: crate, bay, weight. '.repeat(50), depth: 0, targetTokens: 500, agentId: AGENT, modelId: WRITER });
  expect(r).toMatchObject({ ok: false, noRoom: true });
  expect(waiting(AGENT, WRITER), 'precondition: the writer waits for room').toBe('no-room');
  expect(spanWaitsForAWriter(AGENT), 'precondition: a full-context turn parks on a writer coming back').toBe(true);
  void whenAWriterCanRun(AGENT).then(() => { woke = true; });
  memory.reads = 0;
});
afterEach(() => { vi.useRealTimers(); box.db?.close(); box.db = null; });

const sweep = async (): Promise<void> => { runFrequentAutoFixes(); for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('tidy-up starts again when memory is free', () => {
  it('memory free: the next sweep ends the wait and the parked turn wakes, nobody speaking', async () => {
    memory.free = 200_000;
    await sweep();
    expect(waiting(AGENT, WRITER)).toBeNull();
    expect(woke).toBe(true);
  });

  it('memory still tight: the sweep leaves the wait and wakes nothing', async () => {
    await sweep();
    expect(memory.reads, 'it measured').toBe(1);
    expect(waiting(AGENT, WRITER)).toBe('no-room');
    expect(woke).toBe(false);
  });

  it('no wait: the sweep reads no memory', async () => {
    box.db!.prepare("DELETE FROM healer_state WHERE scope LIKE 'writer_wait.no-room'").run();
    await sweep();
    expect(memory.reads).toBe(0);
  });
});
