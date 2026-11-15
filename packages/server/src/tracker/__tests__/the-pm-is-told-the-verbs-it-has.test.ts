// A tool the project manager may not call is refused with the list of what it may call, and that list names the
// note it is told to leave on project decisions.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { freshBoard, call, PM } from '../../work/done/__tests__/helpers/decision-world.js';

describe('the PM is told the verbs it has', () => {
  it('the refusal of a tool outside its list names work_note', async () => {
    freshBoard();
    const r = await call(PM, 'shell_exec', { command: 'ls' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Your overseer verbs are:');
    expect(r.content).toContain('work_note');
  });
});
