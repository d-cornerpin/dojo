// The owner recruits a helper on the dashboard with Web Browsing turned on: the helper the create route makes
// is not denied the tool and holds browsing at the engine's system-control gate. With the toggle off, it is refused.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {}, getAgentUptime: () => 0 }), stopAgent: vi.fn() }));
vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()), isPrimaryAgent: (id: string) => id === 'main', getPrimaryAgentId: () => 'main',
}));

import { DEFAULT_SUBAGENT_PERMISSIONS } from '@dojo/shared';
import { runMigrations } from '../../../db/migrations.js';
import { agentsRouter } from '../agents.js';
import { gatesForCall } from '../../../agent/tools/gates.js';
import { evaluateGate } from '../../../agent/tools/gate-eval.js';
import { getAgentDenySet } from '../../../agent/tools/surface.js';
import { createAgentAccess, readLegacyAccess } from '../../../../../dashboard/src/lib/manifest-edits.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO agents (id, name, status, config) VALUES ('main', 'Main', 'idle', '{}')").run();
});

/** What the form sends with its browsing toggle as given (off is the untouched form), then the engine's
 *  verdict on browsing itself: the executor's deny set and the system-control gate web_browse meets. */
async function browses(browseOn: boolean): Promise<boolean> {
  const initial = readLegacyAccess(DEFAULT_SUBAGENT_PERMISSIONS, undefined, false);
  const res = await agentsRouter.request('/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Researcher ${browseOn}`, systemPrompt: 'Read the docs.', ...createAgentAccess(initial, { ...initial, browseOn }) }),
  });
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { data: { id: string } }).data.id;
  const gate = gatesForCall('web_browse', {}).find((g) => g.kind === 'system_control')!;
  if (getAgentDenySet(id).has('web_browse')) return false;
  return (await evaluateGate(gate, { agentId: id, name: 'web_browse', args: {}, resolveRef: () => null })).verdict.allowed;
}

describe('web browsing turned on in the form lets the helper browse', () => {
  it('on: the engine lets it browse', async () => { expect(await browses(true)).toBe(true); });
  it('off: the engine refuses it', async () => { expect(await browses(false)).toBe(false); });
});
