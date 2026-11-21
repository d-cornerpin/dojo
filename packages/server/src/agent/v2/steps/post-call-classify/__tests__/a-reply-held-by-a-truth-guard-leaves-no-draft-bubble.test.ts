// A reply a truth guard holds is held like any reply check: its streamed bubble is closed and turned into a
// working note, it is not sent, and the agent is steered once and runs again.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => mockDb.current!, getDbPath: () => ':memory:' }));
const frames: Array<Record<string, unknown>> = [];
vi.mock('../../../../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { frames.push(e); }, stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../../reply-claims.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), askReplyClaims: async () => {} }));

import { runMigrations } from '../../../../../db/migrations.js';
import { writeToolReceipt } from '../../../../../receipts/store.js';
import { advance, initState } from '../../../state.js';
import { runReplyFloors } from '../reply-floors.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

const AGENT = 'agent-under-test';

beforeEach(() => {
  frames.length = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Worker', 'idle', '1970-01-01')`).run(AGENT);
  const receiptId = writeToolReceipt({
    agentId: AGENT, tool: 'gmail_send', tier: 1, verified: true, basis: 'provider-id',
    providerId: 'm-1', recipient: 'joanna@example.com', sentText: 'The invoice is attached.',
  });
  mockDb.current.prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, recipient_id, recipient_display, receipt_id, outcome, created_at)
     VALUES ('d-1', ?, 'gmail_send', 'email', 'joanna@example.com', 'Joanna', ?, 'delivered', datetime('now'))`,
  ).run(AGENT, receiptId);
});

describe('a reply held by a truth guard leaves no draft bubble', () => {
  it('the streamed draft is closed and becomes a working note, and the agent is steered to run again', async () => {
    const reply = "I haven't sent it to Joanna yet.";
    const state = advance(initState({ agentId: AGENT, contextWindow: 128_000, configuredModelId: 'm', turnNumber: 4 } as never), { loopCount: 1 });
    const ctx = {
      agentId: AGENT, db: mockDb.current, turnNumber: 4, messageId: 'msg-draft', triggerRow: null, counterparty: { kind: 'owner', name: 'Owner' },
      result: { content: reply, toolCalls: [] },
    } as unknown as PostCallClassifyContext;
    const sc = { persistedContent: reply, deliberateSurfaceTurn: false, interAgentTurn: false } as unknown as PostCallScratch;

    const out = await runReplyFloors(state, ctx, sc);

    expect(out.directive).toBe('continue');
    expect(sc.persistedContent).toBeNull();
    expect(frames).toContainEqual(expect.objectContaining({ type: 'chat:chunk', messageId: 'msg-draft', done: true }));
    expect(frames).toContainEqual(expect.objectContaining({ type: 'chat:workingnote', messageId: 'msg-draft', content: reply }));
    expect(out.state.steerQueue.pending.map((e) => e.content).join('\n')).toContain('you DID send email to Joanna');
  });
});
