// Finalizing is the last step of an imported technique's setup. On a technique that is not in setup it is
// refused, and a published technique stays published.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), refreshEmbedding: vi.fn() }));

const { scratchDojo, MAIN } = await import('../../agent/tools/__tests__/scratch-dojo.js');
const { run } = await scratchDojo('finalize-published');
const { getDb } = await import('../../db/connection.js');
const { toolResultOf } = await import('../../agent/tools/index.js');

const stateOf = (id: string): string =>
  (getDb().prepare('SELECT state FROM techniques WHERE id = ?').get(id) as { state: string }).state;

describe('finalize refuses a published technique', () => {
  it('refuses, and the technique stays published', async () => {
    await run(MAIN, 'save_technique', { name: 'weekly-report', display_name: 'Weekly report', description: 'd', instructions: '# Weekly report\nSend it.', publish: true });
    expect(stateOf('weekly-report')).toBe('published');

    const r = toolResultOf(await run(MAIN, 'technique_finalize', { technique: 'weekly-report' }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not in setup');
    expect(stateOf('weekly-report')).toBe('published');
  });
});
