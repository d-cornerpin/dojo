// STRING NUMBERS, TWO MORE DOORS — `spawn_timeout_decision` and `dojo_report`'s gather window.
//
// Some providers emit numeric tool args as JSON STRINGS even when the schema says `number`
// (`pagination.ts:coerceNumberArg` exists for exactly that). Two doors still asked
// `typeof v === 'number'`, so `"extend_minutes":"30"` lost the minutes and `"turns":"5"`
// read as "no window asked" — silently widening the evidence window past what the agent
// requested. The cases below drive each door through the handler and assert what the door
// HANDS ON to the service.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

/** The grant source, under the test's control. Keyed by agent id -> tool names. */
const grants: Map<string, string[]> = new Map();

vi.mock('../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-string-numbers-timeout-report-test', 'dojo.db'),
  };
});

// The REAL grant source, stubbed at its own module so importing the doors stays cheap.
vi.mock('../../surface.js', () => ({
  getFilteredTools: (agentId: string) => (grants.get(agentId) ?? []).map((name) => ({ name })),
}));

vi.mock('../../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../spawner.js', async (orig) => ({
  ...(await orig()),
  applySpawnTimeoutDecision: vi.fn(async () => ({ ok: true, message: 'ok' })),
}));

// The report's world, stubbed at each seam; the SIGNATURE module stays real (it is a leaf).
vi.mock('../../../../report/gather.js', () => ({
  gatherEvidence: vi.fn(() => ({
    dominant: { toolFailures: [{ tool: 'x', result: 'error', count: 1 }], turnExits: [] },
    window: { truncated: false, turns: 5, minutes: 30, askedFor: '' },
    bundle: {},
    sources: {},
  })),
}));
vi.mock('../../../../report/store.js', () => ({
  createReport: () => ({ id: 'r1' }),
  getReport: vi.fn(() => undefined),
  attachDraft: vi.fn(),
  submitForApproval: vi.fn(),
}));
vi.mock('../../../../report/signature.js', async (orig) => ({ ...(await orig()) }));
vi.mock('../../../../report/telemetry-build.js', () => ({
  buildTelemetry: vi.fn(() => ({})),
}));
vi.mock('../../../../report/bundle.js', () => ({
  writeBundle: vi.fn(() => ({ path: 'test-bundle.json' })),
}));
vi.mock('../../../../report/bounds.js', () => ({
  ATTACHMENT_ECHO_CHARS: 2_000,
  boundDocumentArrays: vi.fn((x: unknown) => x),
}));
vi.mock('../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { agentsHandlers } from '../agents.js';
import { reportHandlers } from '../report.js';
import { applySpawnTimeoutDecision } from '../../../spawner.js';
import { gatherEvidence } from '../../../../report/gather.js';

const decide = vi.mocked(applySpawnTimeoutDecision);
const gather = vi.mocked(gatherEvidence);

const TARGET = 'target';

async function callTimeoutDecision(args: Record<string, unknown>) {
  const h = agentsHandlers['spawn_timeout_decision'];
  return h({
    agentId: 'caller', name: 'spawn_timeout_decision', args, callId: 'c', toolCall: {} as never,
  } as unknown as Parameters<typeof h>[0]);
}

async function callReport(args: Record<string, unknown>) {
  const h = reportHandlers['dojo_report'];
  return h({
    agentId: 'a1', name: 'dojo_report', args, callId: 'c', toolCall: {} as never,
  } as unknown as Parameters<typeof h>[0]);
}

beforeEach(() => {
  grants.clear();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, classification TEXT,
      group_id TEXT, last_error TEXT, last_error_at TEXT, created_at TEXT,
      permissions TEXT DEFAULT '{}', tools_policy TEXT DEFAULT '{}'
    );
    CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, agent_id TEXT, created_at INTEGER);
  `);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO agents (id, name, status, classification, created_at) VALUES (?, 'Target', 'idle', 'sensei', ?)`).run(TARGET, now);
  decide.mockClear();
  gather.mockClear();
});

// ════════════════════════════════════════════════════════════════════════
// 1 — `spawn_timeout_decision` hands the service the minutes it was ASKED for.
// ════════════════════════════════════════════════════════════════════════

describe('spawn_timeout_decision extends by the minutes asked for', () => {
  it('"extend_minutes":"30" reaches the service as 30', async () => {
    await callTimeoutDecision({ agent_id: TARGET, action: 'extend', extend_minutes: '30' });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]![0].extendMinutes).toBe(30);
  });

  it('the number 30 still reaches the service as 30', async () => {
    await callTimeoutDecision({ agent_id: TARGET, action: 'extend', extend_minutes: 30 });
    expect(decide.mock.calls[0]![0].extendMinutes).toBe(30);
  });

  it('an unparseable string stays "no minutes given", not NaN', async () => {
    await callTimeoutDecision({ agent_id: TARGET, action: 'extend', extend_minutes: 'soon' });
    expect(decide.mock.calls[0]![0].extendMinutes).toBeUndefined();
  });

  it('terminate without minutes is unchanged', async () => {
    await callTimeoutDecision({ agent_id: TARGET, action: 'terminate' });
    expect(decide.mock.calls[0]![0].extendMinutes).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2 — `dojo_report` gather ASKS for the window it ASKED for.
// ════════════════════════════════════════════════════════════════════════

describe('dojo_report gather reads string window numbers', () => {
  it('"turns":"5","minutes":"45" reaches gatherEvidence as { turns: 5, minutes: 45 }', async () => {
    await callReport({ phase: 'gather', turns: '5', minutes: '45' });
    expect(gather).toHaveBeenCalledWith('a1', { turns: 5, minutes: 45 });
  });

  it('the numbers 5 and 45 reach it the same way', async () => {
    await callReport({ phase: 'gather', turns: 5, minutes: 45 });
    expect(gather).toHaveBeenCalledWith('a1', { turns: 5, minutes: 45 });
  });

  it('"turns":"many" is no window asked — not a bogus 5-turn window', async () => {
    await callReport({ phase: 'gather', turns: 'many' });
    expect(gather).toHaveBeenCalledWith('a1', { turns: null, minutes: null });
  });
});
