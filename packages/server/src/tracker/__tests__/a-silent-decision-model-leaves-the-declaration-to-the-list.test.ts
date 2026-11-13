// With the decision model silent (none on the box, or no answer), a schedule's deliverable declaration is base's word
// list, so twins behave as at base: two unrelated nightly jobs on one cadence are both accepted and owe nobody a message,
// and a schedule the list recognizes is declared. No decision model is installed here.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

/** Every frame the seam put on the wire, in order. */
const frames: { type: string; data: Record<string, unknown> }[] = [];

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (f: { type: string; data: Record<string, unknown> }) => { frames.push(f); },
}));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../pm-agent.js', () => ({
  ensurePMAgentRunning: () => { /* no-op */ },
}));
vi.mock('../notify.js', () => ({
  injectTaskAssignmentNotification: () => { /* no-op */ },
}));
vi.mock('../../config/platform.js', () => ({
  isSystemServiceAgent: () => false,
  getPrimaryAgentId: () => 'primary',
  isPrimaryAgent: (id: string) => id === 'primary',
  getPMAgentId: () => 'pm',
  getOwnerName: () => 'the owner',
  isPMAgent: (id: string) => id === 'pm',
}));

import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { createWorkTable } from '../../work/__tests__/work-fixture.js';

const AGENT = 'a1';

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, agent_type TEXT, model_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO agents (id, name, status) VALUES ('a1', 'Agent One', 'idle');
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT, outcome TEXT, tool TEXT, created_at INTEGER
    );
  `);
}

/** The tool door the model actually reaches. */
async function openThroughTheDoor(args: Record<string, unknown>, verb = 'work_open:reminder'): Promise<string> {
  const handler = trackerHandlers[verb];
  if (!handler) throw new Error(`no handler for ${verb}`);
  const out = await handler({ agentId: AGENT, args } as Parameters<typeof handler>[0]);
  return typeof out === 'string' ? out : String((out as { content?: string })?.content ?? '');
}

const idFromResult = (text: string): string => {
  const m = /task_id=([0-9a-f-]{36})/.exec(text) ?? /id=([0-9a-f-]{36})/.exec(text);
  if (!m) throw new Error(`no task id in door result: ${text.slice(0, 300)}`);
  return m[1];
};
const kindOf = (id: string): string | null =>
  (mockDb.current!.prepare('SELECT task_kind FROM work WHERE id = ?').get(id) as { task_kind: string | null }).task_kind;
const nightly = (title: string, description: string): Promise<string> => openThroughTheDoor({
  kind: 'task', title, description, goal: 'done each night',
  scheduled_start: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(), repeat_interval: 1, repeat_unit: 'days',
}, 'work_open:task');

beforeEach(() => {
  frames.length = 0;
  const db = new Database(':memory:');
  applySchema(db);
  mockDb.current = db;
});

describe('a silent decision model leaves the declaration to base\'s word list', () => {
  it('two unrelated nightly jobs on one cadence are both accepted, and neither owes a message', async () => {
    const backup = idFromResult(await nightly('Nightly backup', 'back up the database to the NAS'));
    const heating = idFromResult(await nightly('Heating', 'turn the heating down to 16 degrees'));
    expect(kindOf(backup)).toBeNull();
    expect(kindOf(heating)).toBeNull();
  });

  it('a schedule the list recognizes is declared', async () => {
    expect(kindOf(idFromResult(await nightly('Evening update', 'text me what is on tomorrow')))).toBe('notify');
  });
});
