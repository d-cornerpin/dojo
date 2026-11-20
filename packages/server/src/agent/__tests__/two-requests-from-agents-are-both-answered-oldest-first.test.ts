// Two agents ask the same helper: its turns serve the older request first, then the newer one, each in its own
// A2A turn; a request answered on its thread is owed no more.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import { openTurnContext, endTurnContext } from '../turn-context.js';
import { runPreflight } from '../v2/steps/preflight/index.js';
import { freshAgentsDb, preflightCtx, replyLands, HELPER, ASKER, ASKER2 } from './helpers/agent-requests.js';

const asks = (from: string, threadId: string): string => insertMessage({
  agentId: HELPER, role: 'user', lane: 'a2a', sourceAgentId: from, a2aThreadId: threadId, a2aIntent: 'QUESTION',
  a2aRequiresResponse: true, content: `[A2A:QUESTION thread:${threadId.slice(0, 8)} from:${from}] what is the figure?`,
}).id;

async function turnServes(): Promise<string | null> {
  endTurnContext(HELPER);
  const bag = openTurnContext(HELPER);
  const out = await runPreflight(bag, preflightCtx());
  if (out.directive !== 'proceed') throw new Error('preflight abandoned');
  return bag.kind === 'a2a' ? (bag.servedRequest?.messageId ?? null) : null;
}

beforeEach(() => { endTurnContext(HELPER); freshAgentsDb(runMigrations); });

describe('two requests from agents are both answered, oldest first', () => {
  it('the older request is served first, the newer one in the next turn, and nothing after both are answered', async () => {
    const first = asks(ASKER, 'thread-one-aaaa');
    const second = asks(ASKER2, 'thread-two-bbbb');
    expect(await turnServes()).toBe(first);
    await replyLands(HELPER, ASKER, 'thread-one-aaaa');
    expect(await turnServes()).toBe(second);
    await replyLands(HELPER, ASKER2, 'thread-two-bbbb');
    expect(await turnServes()).toBeNull();
  });

  it('a reply on another thread, or to another agent, does not answer a request', async () => {
    const first = asks(ASKER, 'thread-one-aaaa');
    await replyLands(HELPER, ASKER, 'thread-elsewhere');
    await replyLands(HELPER, ASKER2, 'thread-one-aaaa');
    expect(await turnServes()).toBe(first);
  });
});
