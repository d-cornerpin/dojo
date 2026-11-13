// THE ANNOUNCE COUNT, NOT THE WORDS — `recordDispatchAndHold` announces the call at the top of the
// function (the line-41 broadcast), BEFORE any hold decision. The held blocks used to announce it a
// SECOND time next to the refusal result. The dashboard pushes one badge per `chat:tool_call` and
// attaches each `chat:tool_result` to the first badge without one, so a held call rendered a second
// badge that never got a result — it looked like it was still running — and the voice listener's
// `toolsInFlight` was left at +1 for the rest of the turn. A held call needs exactly ONE announce
// (line 41's) and exactly ONE result (the refusal's).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const policyRow = { current: 'gated' as string | null };
const sent: Array<{ type: string; tool?: string }> = [];
const PRIMARY = 'primary-agent';

vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../../../config/platform.js')>()),
  getSudoPolicyRaw: () => policyRow.current,
  isPrimaryAgent: (id: string) => id === PRIMARY,
  getPrimaryAgentId: () => PRIMARY,
}));
vi.mock('../../../../../gateway/ws.js', async (orig) => ({
  ...(await orig<typeof import('../../../../../gateway/ws.js')>()),
  broadcast: (e: { type: string; tool?: string }) => { sent.push(e); },
}));

import { recordDispatchAndHold } from '../dispatch-bookkeeping.js';
import { initState } from '../../../state.js';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE healer_proposals (
      id TEXT PRIMARY KEY, category TEXT, severity TEXT, title TEXT, description TEXT,
      proposed_fix TEXT, status TEXT, agent_id TEXT, evidence_json TEXT, urgency TEXT,
      surface TEXT, notified_at TEXT, approval_token TEXT, approval_signature TEXT,
      approval_args_json TEXT, applied_at TEXT, resolved_at TEXT, user_note TEXT, created_at TEXT
    );
    CREATE TABLE destructive_approvals (
      token TEXT PRIMARY KEY, agent_id TEXT NOT NULL, tool_name TEXT, signature TEXT NOT NULL,
      request_text TEXT, args_json TEXT, root_kind TEXT, root_id TEXT, task_id TEXT,
      turn_number INTEGER, status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at TEXT,
      wake_delivered INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE healer_diagnostics (id TEXT PRIMARY KEY, critical_count INTEGER, created_at TEXT);
  `);
  db.prepare("INSERT INTO agents (id, name) VALUES (?, 'Primary')").run(PRIMARY);
  mockDb.current = db;
  policyRow.current = 'gated';
  sent.length = 0;
});

const held = async () => {
  const state = initState({
    agentId: PRIMARY, contextWindow: 200_000, isAutoRouted: false, configuredModelId: 'test',
    turnNumber: 1, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: null, lastUserMessageId: null, inboundChannel: null,
    inboundContext: null, pendingTechniqueAck: null,
  });
  return recordDispatchAndHold(
    state,
    ({ id: 'tc-1', name: 'shell', arguments: { script: 'sudo whoami' } } as never),
    ({ agentId: PRIMARY, db: mockDb.current, agent: { name: 'Primary' } } as never),
  );
};

describe('a held call is announced once', () => {
  it('⚠ the held sudo call is announced with exactly ONE chat:tool_call', async () => {
    const out = await held();
    expect(out.refusal).not.toBeNull();
    expect(sent.filter((e) => e.type === 'chat:tool_call' && e.tool === 'shell').length).toBe(1);
  });

  it('and the held call still gets its ONE chat:tool_result', async () => {
    await held();
    expect(sent.filter((e) => e.type === 'chat:tool_result' && e.tool === 'shell').length).toBe(1);
  });
});
