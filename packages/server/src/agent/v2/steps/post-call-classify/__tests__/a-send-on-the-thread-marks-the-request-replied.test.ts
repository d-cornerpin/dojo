// An agent asked by another agent that already wrote on the request's thread (its own send, or the engine's
// hand-in relay) is never told the asker "got nothing": the asker's store is the one record of a reply. A send that
// names the thread by the short token it is shown, or by that token with an invented ending, lands on the full thread,
// and so does an asker's follow-up by token on a thread it opened itself.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const mem: { db: Database.Database | null } = { db: null };
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => mem.db!, closeDb: () => {}, getDbPath: () => ':memory:' }));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {}, isRunning: () => false }), stopAgent: () => {} }));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { advance, initState } from '../../../state.js';
import type { AgentRequest } from '../../../owed.js';
import { runMissedReply } from '../missed-reply.js';
import { executeTool, toolResultOf } from '../../../../tools/index.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

let helper = '', asker = '', thread = '';

beforeEach(() => {
  mem.db = new Database(':memory:');
  runMigrations();
  helper = randomUUID(); asker = randomUUID(); thread = `thread-${randomUUID()}`;
  for (const [id, name] of [[helper, 'Helper'], [asker, 'Asker']]) {
    mem.db.prepare(`INSERT INTO agents (id, name, status, config, session_started_at) VALUES (?, ?, 'idle', '{}', '1970-01-01')`).run(id, name);
  }
});

/** The helper's turn on the asker's request ends with prose and no send; returns the steer it was given. */
function proseInsteadOfASend(): string {
  const req = insertMessage({
    agentId: helper, role: 'user', lane: 'a2a', sourceAgentId: asker, a2aThreadId: thread, a2aIntent: 'QUESTION',
    a2aRequiresResponse: true, content: `[A2A:QUESTION thread:${thread.slice(0, 8)} from:Asker] the figure, please`,
  });
  const request: AgentRequest = {
    messageId: req.id, rowid: req.seq, threadId: thread, threadShort: thread.slice(0, 8), intent: 'QUESTION',
    fromId: asker, fromName: 'Asker', createdAt: Date.now() - 60_000, attempts: 1, dueAt: 0,
  };
  const state = advance(initState({
    agentId: helper, contextWindow: 128_000, isAutoRouted: false, configuredModelId: 'm', turnNumber: 3,
    triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: 'the figure, please', lastUserMessageId: req.id,
  } as Parameters<typeof initState>[0]), { loopCount: 1 });
  const ctx = {
    agentId: helper, turnNumber: 3, unrepliedAssign: request, a2aReplyAssignMessageId: req.id,
    a2aReplyContext: { intent: 'QUESTION', threadShort: request.threadShort, fromName: 'Asker' },
    result: { content: 'The figure is 42.', toolCalls: [] },
  } as unknown as PostCallClassifyContext;
  const out = runMissedReply(state, ctx, { persistedContent: null } as unknown as PostCallScratch);
  return out.state.steerQueue.pending.map((e) => e.content).join('\n');
}

/** A row from `from` on `onThread` in the asker's store, as the transport or the engine relay lands it. */
const replyLands = (from: string, onThread: string): void => {
  insertMessage({
    agentId: asker, role: 'user', lane: 'a2a', sourceAgentId: from, a2aThreadId: onThread, a2aIntent: 'COMPLETE',
    a2aRequiresResponse: false, content: `[A2A:COMPLETE thread:${onThread.slice(0, 8)} from:Helper] done`,
  });
};

describe('a send on the thread marks the request replied', () => {
  it('the engine relayed the helper\'s hand-in on the thread: the helper is told it already replied', () => {
    replyLands(helper, thread);
    const steer = proseInsteadOfASend();
    expect(steer).toContain('You already replied to Asker');
    expect(steer).not.toContain('got nothing');
  });

  it('nothing from the helper in the asker\'s store: the helper is told the asker got nothing', () => {
    expect(proseInsteadOfASend()).toContain('Asker got nothing');
  });

  it('a row from the helper on another thread does not count', () => {
    replyLands(helper, `thread-${randomUUID()}`);
    expect(proseInsteadOfASend()).toContain('Asker got nothing');
  });

  it('a send naming the thread by its short token lands on the full thread: the helper is told it already replied', async () => {
    thread = randomUUID();
    insertMessage({ agentId: helper, role: 'user', lane: 'a2a', sourceAgentId: asker, a2aThreadId: thread, a2aIntent: 'QUESTION', a2aRequiresResponse: true, content: 'the figure, please' });
    const sent = toolResultOf(await executeTool(helper, { id: 'tc-1', name: 'send_to_agent', arguments: { agent: asker, intent: 'ANSWER', thread_id: thread.slice(0, 8), payload: 'It is 42.' } }));
    expect(sent.isError, String(sent.content)).toBeFalsy();
    expect(mem.db!.prepare('SELECT a2a_thread_id AS t FROM messages WHERE agent_id = ? AND source_agent_id = ?').all(asker, helper)).toEqual([{ t: thread }]);
    expect(proseInsteadOfASend()).toContain('You already replied to Asker');
  });

  it('a send naming the token with an invented ending lands on the full thread', async () => {
    thread = randomUUID();
    insertMessage({ agentId: helper, role: 'user', lane: 'a2a', sourceAgentId: asker, a2aThreadId: thread, a2aIntent: 'QUESTION', a2aRequiresResponse: true, content: 'the figure, please' });
    const invented = `${thread.slice(0, 8)}-ffd9-4a76-b4dd-9e57a4a0c8b7`;
    toolResultOf(await executeTool(helper, { id: 'tc-1', name: 'send_to_agent', arguments: { agent: asker, intent: 'ANSWER', thread_id: invented, payload: 'It is 42.' } }));
    expect(mem.db!.prepare('SELECT a2a_thread_id AS t FROM messages WHERE agent_id = ? AND source_agent_id = ?').all(asker, helper)).toEqual([{ t: thread }]);
    expect(proseInsteadOfASend()).toContain('You already replied to Asker');
  });

  it('the asker opens a thread, then follows up by its token: the follow-up is on the full thread', async () => {
    const first = toolResultOf(await executeTool(asker, { id: 'tc-1', name: 'send_to_agent', arguments: { agent: helper, intent: 'QUESTION', payload: 'Pack the camping list?' } }));
    const full = (mem.db!.prepare('SELECT a2a_thread_id AS t FROM messages WHERE agent_id = ?').get(helper) as { t: string }).t;
    expect(String(first.content)).toContain(full.slice(0, 8));
    await executeTool(asker, { id: 'tc-2', name: 'send_to_agent', arguments: { agent: helper, intent: 'QUESTION', thread_id: full.slice(0, 8), payload: 'Cancel the camping list.' } });
    expect(mem.db!.prepare('SELECT DISTINCT a2a_thread_id AS t FROM messages WHERE agent_id = ?').all(helper)).toEqual([{ t: full }]);
  });
});
