// A chat message sent to the dashboard without a saved row is reported as a warning. The warning names
// the message by id only: its words never reach the log or the live log feed.

import { describe, it, expect, vi } from 'vitest';
import type { LogEntry } from '@dojo/shared';

vi.mock('../../db/connection.js', () => ({
  getDb: () => { throw new Error('no database in this test'); },
}));

const { setLogBroadcast } = await import('../../logger.js');
const { stampPersistedRow } = await import('../ws.js');

describe('a warning about an unsaved message', () => {
  it('names the message by id and carries none of its words', () => {
    const seen: LogEntry[] = [];
    setLogBroadcast((entry) => { seen.push(entry); });
    const words = 'the meeting notes say the budget is 4417 dollars';
    const verdict = stampPersistedRow({
      type: 'chat:message', agentId: 'agent-1',
      message: { id: 'msg-unsaved-1', agentId: 'agent-1', role: 'assistant', content: words, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
    } as never);
    expect(verdict).toBe('orphan');
    const warning = seen.find((e) => e.level === 'warn' && e.message.includes('NO persisted row'));
    expect(warning).toBeTruthy();
    expect(JSON.stringify(warning)).toContain('msg-unsaved-1');
    expect(JSON.stringify(warning)).not.toContain('meeting notes');
  });
});
