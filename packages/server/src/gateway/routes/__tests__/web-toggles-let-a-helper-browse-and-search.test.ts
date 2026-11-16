// "Web Browsing" and "Search the web" do what they say on both dashboard doors: a helper recruited with the
// toggle on, or an existing helper whose Access panel turns it on, passes every gate the engine asks before
// the tool runs; the untouched form, or turning the toggle off again, leaves it refused.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {}, getAgentUptime: () => 0 }), stopAgent: vi.fn() }));
vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()), isPrimaryAgent: (id: string) => id === 'main', getPrimaryAgentId: () => 'main',
}));

import type { AgentDetail } from '@dojo/shared';
import { DEFAULT_SUBAGENT_PERMISSIONS } from '@dojo/shared';
import { runMigrations } from '../../../db/migrations.js';
import { agentsRouter } from '../agents.js';
import { gatesForCall } from '../../../agent/tools/gates.js';
import { evaluateGate } from '../../../agent/tools/gate-eval.js';
import { getAgentDenySet } from '../../../agent/tools/surface.js';
import { forgetAccessGrants, getAccessGrants } from '../../../agent/access/read.js';
import { buildLegacyAccess, createAgentAccess, readLegacyAccess, type LegacyAccess } from '../../../../../dashboard/src/lib/manifest-edits.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO agents (id, name, status, config) VALUES ('main', 'Main', 'idle', '{}')").run();
});

const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Every gate the engine asks before the handler: the deny set, then each declared gate. */
async function allowed(id: string, tool: 'web_browse' | 'web_search'): Promise<boolean> {
  forgetAccessGrants();
  if (getAgentDenySet(id).has(tool)) return false;
  const args = tool === 'web_browse' ? { action: 'navigate', url: 'https://example.com/' } : { query: 'tides' };
  for (const gate of gatesForCall(tool, args)) {
    if (!(await evaluateGate(gate, { agentId: id, name: tool, args, resolveRef: () => null })).verdict.allowed) return false;
  }
  return true;
}

/** The new-agent form, from its start, with `edit` applied; the untouched form is `edit` = identity. */
async function recruit(edit: (s: LegacyAccess) => LegacyAccess): Promise<string> {
  const initial = readLegacyAccess(DEFAULT_SUBAGENT_PERMISSIONS, undefined, false, null);
  const res = await agentsRouter.request('/', json('POST', { name: `Helper ${Math.random()}`, systemPrompt: 'Help.', ...createAgentAccess(initial, edit(initial)) }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** The Access panel's save of its toggles, read from the agent as the page reads it. */
async function panelSave(id: string, edit: (s: LegacyAccess) => LegacyAccess): Promise<void> {
  const agent = ((await (await agentsRouter.request(`/${id}`)).json()) as { data: AgentDetail }).data;
  const built = buildLegacyAccess(edit(readLegacyAccess(agent.permissions, agent.toolsPolicy ?? undefined, false, agent.effectiveGrants ?? null)));
  const res = await agentsRouter.request(`/${id}`, json('PUT', {
    basePermissions: agent.permissions ?? {}, baseToolsPolicy: agent.toolsPolicy ?? {},
    permissions: built.permissions, toolsPolicy: built.toolsPolicy, config: { shareUserProfile: built.shareUserProfile },
  }));
  expect(res.status, await res.clone().text()).toBe(200);
}

describe('the web toggles let a helper browse and search', () => {
  it('the new-agent form: on lets it, the untouched form does not', async () => {
    const browser = await recruit((s) => ({ ...s, browseOn: true }));
    expect(await allowed(browser, 'web_browse')).toBe(true);
    const searcher = await recruit((s) => ({ ...s, searchOn: true, browseOn: false }));
    expect(await allowed(searcher, 'web_search')).toBe(true);
    const plain = await recruit((s) => s);
    expect(await allowed(plain, 'web_browse')).toBe(false);
    expect(await allowed(plain, 'web_search')).toBe(false);
  });

  it('the Access panel: on lets an existing default helper, off takes it away again', async () => {
    const id = await recruit((s) => s);
    await panelSave(id, (s) => ({ ...s, browseOn: true, searchOn: true }));
    expect(await allowed(id, 'web_browse')).toBe(true);
    expect(await allowed(id, 'web_search')).toBe(true);
    await panelSave(id, (s) => ({ ...s, browseOn: false, searchOn: false }));
    expect(await allowed(id, 'web_browse')).toBe(false);
    expect(await allowed(id, 'web_search')).toBe(false);
    // Off denies the tools and leaves the tool group as it was, as the panel always has.
    expect(getAccessGrants(id).tools.categories).toContain('Web');
  });
});
