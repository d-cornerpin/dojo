// A reminder's run is addressed from the request that asked for its task: asked by text, the run's turn carries that
// text's row (so its result is texted back); a run with no such request carries none.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => undefined }));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage, insertEngineEvent } from '../../../../../memory/message-store.js';
import { transition } from '../../../../../work/store.js';
import { runTurnTrigger } from '../turn-trigger.js';
import type { PreflightContext } from '../index.js';
import type { TurnContext } from '../../../../turn-context.js';

const AGENT = 'worker';
const ctx = { agentId: AGENT, setAgentStatus: () => undefined, startStatusHeartbeat: () => undefined } as unknown as PreflightContext;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  mockDb.current.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 40000, 1)`).run();
  mockDb.current.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Worker', 'm', 'idle', '{}', 'sensei')").run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

/** A reminder task asked for by `sourceMessageId` (or nothing), with a run in flight and its clock event due. */
function aReminderRunDue(sourceMessageId: string | null): void {
  const at = Date.now() - 60_000;
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id, state, intent, wakes, closes_thread, title, task_kind, source_message_id, opened_at, updated_at)
     VALUES ('task-r', 'task', ?, 'agent', ?, 'tracker', 'task-r', 'claimed', 'task', 1, 0, 'Take the vitamins', 'reminder', ?, ?, ?)`,
  ).run(AGENT, AGENT, sourceMessageId, at, at);
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, sequence, opened_at, updated_at)
     VALUES ('run-1', 'occurrence', 'task-r', ?, 'schedule', 'schedule', 'task-r', 'open', 'occurrence', 0, 0, 'a run', 1, ?, ?)`,
  ).run(AGENT, at, at);
  insertEngineEvent({ agentId: AGENT, content: 'Time for the reminder', originIntent: 'scheduler', work: { taskId: 'task-r', runId: 'run-1', rootKind: 'occurrence', rootId: 'run-1' } });
}

describe('a reminder is addressed from the request that asked for it', () => {
  it('a reminder asked by text: the run\'s turn carries that text\'s row', () => {
    const m = insertMessage({
      id: 'm-text', agentId: AGENT, role: 'user', content: 'remind me at 8 to take my vitamins', lane: 'owner', channel: 'imessage',
      senderId: '+15550100', authorized: true, inboundMeta: JSON.stringify({ channel: 'imessage', sender: '+15550100', relation: 'owner' }),
    } as never).id;
    transition(`ask:${m}`, { to: 'claimed', by: 'agent', actorId: AGENT, claimedByTurn: 1, reason: 'answered' });
    aReminderRunDue(m);
    const out = runTurnTrigger({} as unknown as TurnContext, ctx);
    if (out.directive !== 'proceed') throw new Error('expected proceed');
    expect(out.outputs.item?.kind).toBe('clock');
    expect(out.outputs.jobRow?.channel).toBe('imessage');
    expect(out.outputs.isHumanContinuation).toBe(false);
  });

  it('a run no request asked for carries no row', () => {
    aReminderRunDue(null);
    const out = runTurnTrigger({} as unknown as TurnContext, ctx);
    if (out.directive !== 'proceed') throw new Error('expected proceed');
    expect(out.outputs.item?.kind).toBe('clock');
    expect(out.outputs.jobRow).toBeUndefined();
  });
});
