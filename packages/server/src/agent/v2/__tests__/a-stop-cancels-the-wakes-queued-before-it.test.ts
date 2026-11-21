// A turn the owner stopped ends the engine self-wakes queued before it: the clock owes nothing and none is served.
// A wake rooted in a person's request or in a run they scheduled still stands, and a wake queued after the Stop is served.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../../db/migrations.js';
import { insertEngineEvent } from '../../../memory/message-store.js';
import { startTurn, finalizeTurn } from '../turn-record.js';
import { getPendingEngineEvent } from '../counterparty.js';
import { dueOf } from '../owed.js';
import { freshReplyDb, AGENT } from './helpers/reply-sender.js';

const queue = (content: string, rootKind: string | null = null) => insertEngineEvent({
  agentId: AGENT, content, originIntent: 'completion_report', work: rootKind ? { taskId: null, runId: null, rootKind, rootId: 'm-1' } : null,
});
const stoppedTurn = (): void => {
  const n = startTurn({ agentId: AGENT, kind: 'engine', subjectKind: null, subjectId: null, rootKind: null, rootId: null, sourceMessageId: null, convKey: null });
  finalizeTurn(AGENT, n, 'stop', false, null);
};

beforeEach(() => { freshReplyDb(runMigrations); });

describe('a stop cancels the wakes queued before it', () => {
  it('a self-wake queued before the Stop is neither owed nor served', () => {
    queue('report the finished task to the owner');
    expect(dueOf(AGENT).now).toBe(true);
    stoppedTurn();
    expect(getPendingEngineEvent(AGENT)).toBeNull();
    expect(dueOf(AGENT)).toEqual({ now: false, next: null });
  });

  it.each(['ask', 'occurrence'])("a wake rooted in a person's request or schedule (%s) still stands after the Stop", (rootKind) => {
    const tied = queue('the delegated piece never came back', rootKind);
    stoppedTurn();
    expect(getPendingEngineEvent(AGENT)?.id).toBe(tied.id);
  });

  it('a self-wake queued after the Stop is served', async () => {
    queue('report the finished task to the owner');
    stoppedTurn();
    await new Promise((r) => setTimeout(r, 1_100));
    const later = queue('report the next finished task');
    expect(getPendingEngineEvent(AGENT)?.id).toBe(later.id);
  });
});
