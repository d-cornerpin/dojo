// A helper that ends with complete_task ends its own apprentice helpers, as a terminated one does;
// a sensei it made stays.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => {}, isRunning: () => false }), stopAgent: () => {},
}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { freshBoard, call, MAIN, WORKER } from '../../work/done/__tests__/helpers/decision-world.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';

const statusOf = (id: string): string => (doneDb().prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string }).status;

describe('a completing helper ends its own helpers', () => {
  it('its apprentice ends with it; its sensei stays', async () => {
    freshBoard();
    doneDb().prepare("UPDATE agents SET classification = 'apprentice', parent_agent = ? WHERE id = ?").run(MAIN, WORKER);
    const add = doneDb().prepare("INSERT INTO agents (id, name, status, classification, parent_agent) VALUES (?, ?, 'idle', ?, ?)");
    add.run('helper-apprentice', 'helper-apprentice', 'apprentice', WORKER);
    add.run('helper-sensei', 'helper-sensei', 'sensei', WORKER);
    const r = await call(WORKER, 'complete_task', { status: 'fallen', summary: 'The source is gone.' });
    expect(r.isError, r.content).toBe(false);
    expect(statusOf(WORKER)).toBe('terminated');
    expect(statusOf('helper-apprentice')).toBe('terminated');
    expect(statusOf('helper-sensei')).not.toBe('terminated');
  });
});
