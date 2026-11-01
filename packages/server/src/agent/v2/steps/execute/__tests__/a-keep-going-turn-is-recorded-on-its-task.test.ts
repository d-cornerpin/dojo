// An owner-chat "keep going" turn works a task only through exec: it neither serves the task nor touches it
// in the tracker, but the effort charge knows the task, so the turn is recorded against it and the task's
// timeline shows its calls (`work/task-turns.ts`).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => ({ db: null as unknown, file: '' }));
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => h.db, getReadOnlyDb: () => h.db, closeDb: () => {}, getDbPath: () => h.file,
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../../../db/migrations.js';
import { timeline } from '../../../../../inspect/timeline.js';
import { countTrackerWorkThisIteration } from '../tracker-counting.js';
import { initState } from '../../../state.js';

const sqlTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const WORKER = 'agent-worker';
const TASK = 'task-m-0000-1111-2222-333344445555';
const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  h.db = db;
  runMigrations();
  db.prepare("INSERT INTO agents (id, name, classification) VALUES (?, 'worker', 'apprentice')").run(WORKER);
  db.prepare(`INSERT INTO work (id, kind, agent_id, assignee_agent, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
    VALUES (?, 'task', ?, ?, 'owner', 'tracker', 'root-x', 'claimed', 'DO', 1, 0, 'sort the inbox', ?, ?)`).run(TASK, WORKER, WORKER, T0, T0);
  db.prepare("INSERT INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered, effectful_calls) VALUES (?, 9, 'conv', ?, ?, 'answered', 1, 1)")
    .run(WORKER, sqlTime(T0 + 20 * 60_000), sqlTime(T0 + 21 * 60_000));
  db.prepare("INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at, turn_number) VALUES ('aud-c', ?, 'tool_call', 'exec', 'success', 'ls the inbox export', ?, 9)")
    .run(WORKER, sqlTime(T0 + 20 * 60_000 + 30_000));
});

describe('an owner-chat "keep going" turn that works the task only through exec', () => {
  it('is recorded at the effort-charge site, and the task timeline shows its calls', () => {
    const calls = [{ id: 'x1', name: 'exec', arguments: { command: 'ls' } }];
    const state = { ...initState({
      agentId: WORKER, contextWindow: 100_000, isAutoRouted: false, configuredModelId: 'm', turnNumber: 9, triggeredByIMessage: false,
      triggeredByA2AReplyIntent: null, lastUserMessageContent: null, lastUserMessageId: null, inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
    }), toolCalls: calls, toolResults: [{ toolCallId: 'x1', name: 'exec', content: 'ok', isError: false }] };
    const ctx = {
      agentId: WORKER, turnNumber: 9,
      turnCtx: { convKey: 'human:owner', startAckSteerArmedThisTurn: false, startAckSteerRequested: false },
      counterparty: { kind: 'user', name: 'Owner', relation: 'owner', channel: 'dashboard', senderId: 'owner', threadId: null, senderIsAgent: false },
      counterpartyIsAgentSender: false, engineStartAckDeliveredThisTurn: true, result: { toolCalls: calls },
    };
    const round = [{ toolCallId: 'x1', name: 'exec', content: 'ok', isError: false }];
    countTrackerWorkThisIteration(state as never, ctx as never, round);
    expect(db.prepare("SELECT json_extract(payload, '$.turn_number') AS t FROM work_events WHERE work_id = ? AND kind = 'claim_turn'").all(TASK)).toEqual([{ t: 9 }]);
    expect(timeline({ task_id: TASK }, db)).toContain('ls the inbox export');   // turn 9's call, with no tracker call or serving
  });
});
