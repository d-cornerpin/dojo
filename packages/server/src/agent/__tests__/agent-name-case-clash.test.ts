// ════════════════════════════════════════════════════════════════════════════════════════
// E21 PARKED MINOR — A CREATE OR RENAME MUST NOT MINT A SECOND AGENT THE CASE-INSENSITIVE
// LOOKUP CANNOT TELL APART.
//
// E21 made every name lookup case-insensitive, so an agent called "Helper" answers to
// "helper" too. But nothing stopped a second agent from being created to "helper" — and then
// `liveAgentsNamed` could not tell them apart (the newest wins, silently). This pins the CREATE
// doors: a name that differs from a live agent's name only by capital letters is REFUSED. An
// exact byte-identical duplicate keeps its pre-existing behaviour (still allowed) — that is the
// rule "names are matched without regard to capital letters" must not turn into a uniqueness
// wall the platform never had.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.setConfig({ testTimeout: 30_000 });

const { mockDb } = vi.hoisted(() => ({ mockDb: { current: null as Database.Database | null } }));
vi.mock('../../db/connection.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/connection.js')>('../../db/connection.js');
  return { ...actual, getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; } };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])),
  queueEmbedding: vi.fn(),
}));
const handleMessage = vi.fn(async () => undefined);
vi.mock('../runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runtime.js')>()),
  getAgentRuntime: () => ({ handleMessage }),
}));
// The dashboard route imports `renameAgent`, which resolves `~/.dojo` through `home.js`; point it
// at a per-run scratch dir so a stray call never touches the real home. No soul is written here
// (the refusals happen before any re-fill), so this mock needs no prompts dir and no drift clause.
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-test-homes', `agent-name-clash-w${process.env.VITEST_POOL_ID ?? 'x'}-${process.pid}`);
  return {
    homeDir: () => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { spawnAgent } from '../spawner.js';
import { agentsRouter } from '../../gateway/routes/agents.js';
import { caseVariantClash, caseVariantClashMessage } from '../tool-helpers.js';

function addAgent(id: string, name: string, createdAt: string, status = 'idle'): void {
  mockDb.current!.prepare(
    `INSERT INTO agents (id, name, model_id, status, config, session_started_at, created_at) VALUES (?, ?, 'm', ?, '{}', '1970-01-01', ?)`,
  ).run(id, name, status, createdAt);
}

beforeEach(() => {
  mockDb.current?.close();
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
});

describe('E21 parked minor — the clash helper itself', () => {
  it('a name differing from a live agent only by case IS a clash', () => {
    addAgent('h-1', 'Helper', '2026-01-01 00:00:00');
    expect(caseVariantClash('helper')).not.toBeNull();
    expect(caseVariantClash('HELPER')).not.toBeNull();
    expect(caseVariantClash('helper')?.name).toBe('Helper');
  });

  it('an exact byte-identical duplicate is NOT a clash (pre-existing behaviour unchanged)', () => {
    addAgent('h-1', 'Helper', '2026-01-01 00:00:00');
    expect(caseVariantClash('Helper')).toBeNull();
  });

  it('an agent\'s own name is never its own clash', () => {
    addAgent('h-1', 'Helper', '2026-01-01 00:00:00');
    expect(caseVariantClash('helper', 'h-1')).toBeNull();   // self is excluded
    expect(caseVariantClash('Helper', 'h-1')).toBeNull();
  });

  it('a terminated agent does not block a name', () => {
    addAgent('h-1', 'Helper', '2026-01-01 00:00:00', 'terminated');
    expect(caseVariantClash('helper')).toBeNull();
  });

  it('the message names the existing agent, in the plain door style', () => {
    expect(caseVariantClashMessage('Helper'))
      .toBe('An agent named "Helper" already exists; names are matched without regard to capital letters.');
  });
});

describe('E21 parked minor — the spawn door refuses a case-variant name', () => {
  it('spawnAgent refuses a name that differs from a live agent only by case', async () => {
    addAgent('h-1', 'Helper', '2026-01-01 00:00:00');
    await expect(spawnAgent({
      parentId: 'x', name: 'helper', systemPrompt: 'do the thing',
    })).rejects.toThrow('An agent named "Helper" already exists; names are matched without regard to capital letters.');
  });

  it('spawnAgent refuses under any capitalisation of the clash', async () => {
    addAgent('h-1', 'Helper', '2026-01-01 00:00:00');
    await expect(spawnAgent({
      parentId: 'x', name: 'HELPER', systemPrompt: 'do the thing',
    })).rejects.toThrow('An agent named "Helper" already exists; names are matched without regard to capital letters.');
  });
});

describe('E21 parked minor — the dashboard create door refuses a case-variant name', () => {
  it('POST /api/agents refuses with a 400 and the plain message', async () => {
    addAgent('h-1', 'Helper', '2026-01-01 00:00:00');
    const res = await agentsRouter.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'helper', systemPrompt: 'do the thing' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error)
      .toBe('An agent named "Helper" already exists; names are matched without regard to capital letters.');
  });
});
