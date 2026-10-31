// P44 (lane t280): the agent chooses "the sender" or "everyone on the thread" with `reply_all`. Outlook builds the
// everyone-list itself (Graph's replyAll: the sender, every To and Cc, minus the replying mailbox, no new people), so
// the requirement here is that the choice reaches the right Graph call — the plain reply endpoint when the flag is
// absent or false, replyAll only when the agent set it true — for the reply and for the reply draft.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({
  msGraphRead: vi.fn(), msGraphWrite: vi.fn(), graphFetch: vi.fn(),
  calendarPrefix: () => 'me/', drivePrefix: () => 'me/drive/',
}));
vi.mock('../accounts.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../accounts.js');
  const account = { id: 'agent', kind: 'agent', position: 1, email: 'agent@example.com', connected: true, sendEmail: true };
  return { ...actual, resolveMicrosoftAccountForTool: vi.fn(() => ({ account })), resolveMicrosoftAccountForRead: vi.fn(() => ({ account, labelAccount: false })) };
});
vi.mock('../../tools/unified-read.js', () => ({ otherMailboxesCountSection: vi.fn(async () => '') }));

import { msGraphWrite } from '../client.js';
import { executeMicrosoftWriteTool } from '../tools-write.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
const endpoints = (): string[] => vi.mocked(msGraphWrite).mock.calls.map((c) => String(c[1]));

beforeEach(() => { vi.mocked(msGraphWrite).mockReset(); vi.mocked(msGraphWrite).mockResolvedValue(ok({}) as never); });

describe('P44 — outlook_reply: the sender or everyone, as the agent chooses', () => {
  it('no flag and reply_all false answer the sender only', async () => {
    await executeMicrosoftWriteTool('outlook_reply', { message_id: 'm1', body: 'ok' }, 'a1', 'A Worker');
    await executeMicrosoftWriteTool('outlook_reply', { message_id: 'm1', body: 'ok', reply_all: false }, 'a1', 'A Worker');
    expect(endpoints().every((e) => e === 'me/messages/m1/reply')).toBe(true);
  });

  it('reply_all true answers everyone through Graph\'s replyAll', async () => {
    await executeMicrosoftWriteTool('outlook_reply', { message_id: 'm1', body: 'ok', reply_all: true }, 'a1', 'A Worker');
    expect(endpoints()).toEqual(['me/messages/m1/replyAll']);
  });
});
