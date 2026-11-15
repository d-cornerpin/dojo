// The boot resumes the open memory catch-ups of live agents only; a terminated agent's record is passed over.
import { it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/one-writer-box.js')).connectionMock());
vi.mock('../../agent/model.js', async () => (await import('./helpers/one-writer-box.js')).modelMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { box, seedBox, AGENT, OWN } from './helpers/one-writer-box.js';
import { openCatchUps } from '../out-of-view.js';

beforeEach(async () => { await seedBox(); });
afterEach(() => { box.db?.close(); box.db = null; });

it('an agent that is terminated is not among the open catch-ups', () => {
  box.db!.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES ('agent-gone', 'A gone agent', 'terminated', ?, '{}')").run(OWN);
  for (const id of [AGENT, 'agent-gone']) {
    box.db!.prepare("INSERT INTO config (key, value) VALUES (?, '{\"at\":1}')").run(`memory_catch_up.${id}`);
  }
  expect(openCatchUps()).toEqual([AGENT]);
});
