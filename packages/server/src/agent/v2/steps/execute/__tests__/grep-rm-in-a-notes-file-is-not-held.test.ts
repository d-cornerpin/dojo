// A helper's line that only mentions "rm" (a search for the word) is not held; a line that runs rm,
// directly or through xargs, is. Driven through the turn loop's dispatch step; nothing runs.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../../approval-decision.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), deliverGateWake: async () => true }));

const { scratchDojo, HELPER } = await import('../../../../tools/__tests__/scratch-dojo.js');
const { dispatch } = await scratchDojo('grep-rm');

describe('grep rm in a notes file is not held', () => {
  it.each(['grep rm notes.txt', 'grep -n "rm -rf" notes.txt', 'echo rm'])('%s is not held', async (script) => {
    expect(await dispatch(HELPER, 'shell', { script })).toBeNull();
  });

  it.each(['rm notes.txt', 'ls *.tmp | xargs rm', 'git push --force origin main'])('%s is held', async (script) => {
    expect((await dispatch(HELPER, 'shell', { script }))?.content).toContain('[HELD by engine');
  });
});
