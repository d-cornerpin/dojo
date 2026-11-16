// The main agent reads any technique with technique_read, a draft another squad is building included.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), refreshEmbedding: vi.fn() }));

const { scratchDojo, MAIN } = await import('../../agent/tools/__tests__/scratch-dojo.js');
const { run } = await scratchDojo('main-reads-draft');
const { toolResultOf } = await import('../../agent/tools/index.js');
const { getDb } = await import('../../db/connection.js');

describe('the main agent reads a draft technique', () => {
  it('technique_read returns the draft', async () => {
    await run(MAIN, 'save_technique', { name: 'weekly-draft', display_name: 'Weekly draft', description: 'd', instructions: '# Weekly draft\nStep one.' });
    getDb().prepare("INSERT INTO agent_groups (id, name, created_by) VALUES ('another-squad', 'another squad', ?)").run(MAIN);
    getDb().prepare("UPDATE techniques SET build_squad_id = 'another-squad' WHERE id = 'weekly-draft'").run();
    const r = toolResultOf(await run(MAIN, 'technique_read', { name: 'weekly-draft', action: 'section', lines: '1-2' }));
    expect(r.isError, r.content).toBe(false);
    expect(r.content).toContain('Step one.');
  });
});
