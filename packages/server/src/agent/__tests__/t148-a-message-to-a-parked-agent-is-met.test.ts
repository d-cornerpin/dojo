// t148 round 5 (review minor 3, ruled) — A PERSON WHO MESSAGES A PARKED AGENT IS NOT MET WITH SILENCE.
//
// The park is told to the owner once per condition (notice, text, card). But a NEW message arriving for
// an agent that is still parked used to get nothing at all: the turn it woke hit the same stop and
// re-parked silently. Now each incoming message is answered on arrival with the platform's existing
// owner-visible system line (OWNER_ALERT_HEADS_UP_PREFIX, the idiom the expiry and declared-patience
// lines use): the true cause in plain words, and that the message will be answered when it clears. It
// is a row in THAT message's conversation, posted without a model call, a text or a card, once per
// message (a deterministic row id). The message itself stays queued and is answered on release.
//
// Channel: the existing system-note path is the dashboard's chat (a `role='system'` row and a
// `chat:message` frame); it does not go back out on the iMessage channel, so an iMessage-origin
// message gets the line in its conversation in the dashboard only.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { OWNER_ALERT_HEADS_UP_PREFIX } from '@dojo/shared';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
}));
const broadcastSpy = vi.fn();
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: unknown) => broadcastSpy(e), stampPersistedRow: (e: unknown) => e }));
const runV2TurnSpy = vi.fn(async () => undefined);
vi.mock('../v2/loop.js', () => ({ runV2Turn: (...args: unknown[]) => runV2TurnSpy(...args) }));
const sendAlertSpy = vi.fn();
const imessageSpy = vi.fn();
vi.mock('../../services/imessage-bridge.js', () => ({
  sendAlert: (...a: unknown[]) => sendAlertSpy(...a),
  sendResponseViaIMessage: (...a: unknown[]) => imessageSpy(...a),
  maybeForwardToImessage: (...a: unknown[]) => imessageSpy(...a),
}));

const AGENT = 'parked-desk';
const CAUSE = 'Today\'s spending limit is reached ($2.00 of $1.00), so this agent\'s turn was not run. Your message is kept. It will be answered when the limit resets, or as soon as you raise the limit in Settings.';

beforeEach(async () => {
  vi.resetModules();
  for (const s of [runV2TurnSpy, broadcastSpy, sendAlertSpy, imessageSpy]) s.mockClear();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  const { runMigrations } = await import('../../db/migrations.js');
  runMigrations();
  db.prepare("INSERT INTO agents (id, name, status, last_error, model_id) VALUES (?, 'Desk', 'paused', ?, NULL)").run(AGENT, `[budget_stop] ${CAUSE}`);
  db.prepare("INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at) VALUES ('conv-dash', ?, 'dashboard', NULL, 'owner', datetime('now'))").run(AGENT);
  db.prepare("INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at) VALUES ('conv-im', ?, 'imessage', 'imessage', 'owner', datetime('now'))").run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

async function arrive(id: string, channel: 'dashboard' | 'imessage', conv: string): Promise<void> {
  const { insertMessage } = await import('../../memory/message-store.js');
  insertMessage({
    id, agentId: AGENT, role: 'user', content: 'Is the north dock open today?', turnNumber: 1, channel, senderId: 'owner',
    conversationId: conv, inboundMeta: JSON.stringify({ channel, relation: 'owner' }),
  });
}
const notes = (): Array<{ id: string; content: string; conversation_id: string | null }> =>
  mockDb.current!.prepare("SELECT id, content, conversation_id FROM messages WHERE agent_id = ? AND role = 'system' AND id LIKE 'park-note:%' ORDER BY rowid").all(AGENT) as never;
const askState = (id: string): string => (mockDb.current!.prepare("SELECT state FROM work WHERE kind = 'ask' AND root_id = ?").get(id) as { state: string }).state;

describe('t148 r5 — a message to a parked agent is answered on arrival with the true cause', () => {
  it('a dashboard message gets the plain-words line in its own conversation, once, with no text and no card; it stays queued', async () => {
    await arrive('m-dash', 'dashboard', 'conv-dash');
    const { getAgentRuntime } = await import('../runtime.js');
    await getAgentRuntime().handleMessage(AGENT, '');
    await getAgentRuntime().handleMessage(AGENT, '');   // woken again: still one line for this message
    const n = notes();
    expect(n).toHaveLength(1);
    expect(n[0].id).toBe('park-note:m-dash');
    expect(n[0].conversation_id).toBe('conv-dash');
    expect(n[0].content.startsWith(OWNER_ALERT_HEADS_UP_PREFIX)).toBe(true);
    expect(n[0].content).toContain(CAUSE);
    expect(broadcastSpy.mock.calls.map((c) => c[0] as { type?: string; agentId?: string }).filter((e) => e.type === 'chat:message' && e.agentId === AGENT)).toHaveLength(1);
    expect(broadcastSpy.mock.calls.some((c) => (c[0] as { type?: string }).type === 'chat:error'), 'no new toast or card').toBe(false);
    expect(sendAlertSpy, 'no text').not.toHaveBeenCalled();
    expect(askState('m-dash'), 'the message stays queued, to be answered on release').toBe('open');
  });

  it('an iMessage-origin message gets the line in ITS conversation, dashboard only: nothing goes back out on the phone channel', async () => {
    await arrive('m-im', 'imessage', 'conv-im');
    const { getAgentRuntime } = await import('../runtime.js');
    await getAgentRuntime().handleMessage(AGENT, '');
    const n = notes();
    expect(n.map((r) => [r.id, r.conversation_id])).toEqual([['park-note:m-im', 'conv-im']]);
    expect(imessageSpy, 'the existing system-note path does not go out on iMessage').not.toHaveBeenCalled();
    expect(sendAlertSpy).not.toHaveBeenCalled();
  });

  it('two messages in two conversations each get their own line; an agent that is merely paused (no park tag) gets none', async () => {
    await arrive('m-a', 'dashboard', 'conv-dash');
    await arrive('m-b', 'imessage', 'conv-im');
    const { getAgentRuntime } = await import('../runtime.js');
    await getAgentRuntime().handleMessage(AGENT, '');
    expect(notes().map((r) => r.id).sort()).toEqual(['park-note:m-a', 'park-note:m-b']);
    mockDb.current!.prepare("DELETE FROM messages WHERE id LIKE 'park-note:%'").run();
    mockDb.current!.prepare("UPDATE agents SET last_error = 'repeated errors' WHERE id = ?").run(AGENT);
    await getAgentRuntime().handleMessage(AGENT, '');
    expect(notes(), 'control: an ordinary pause is not a park').toEqual([]);
  });
});
