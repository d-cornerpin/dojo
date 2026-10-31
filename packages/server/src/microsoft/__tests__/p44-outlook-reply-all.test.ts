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
const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));
vi.mock('../../tools/unified-read.js', () => ({ otherMailboxesCountSection: vi.fn(async () => '') }));

import { msGraphWrite } from '../client.js';
import { sendMarkedDraft } from '../send-as-draft.js';
import { judgeOwnerEmail } from '../../services/mail-owner-intake.js';
import { isPlatformSent } from '../../services/platform-sends.js';
import Database from 'better-sqlite3';
vi.mock('../../services/outlook-owner-gate.js', () => ({ outlookOwnerConfirmationOpen: () => true }));
import { runMigrations } from '../../db/migrations.js';
import { executeMicrosoftWriteTool } from '../tools-write.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
const endpoints = (): string[] => vi.mocked(msGraphWrite).mock.calls.map((c) => String(c[1]));

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(); vi.mocked(msGraphWrite).mockReset(); vi.mocked(msGraphWrite).mockResolvedValue(ok({ id: 'draft-1', internetMessageId: '<AAMk-draft@outlook.test>' }) as never); });

describe('P44 — outlook_reply: the sender or everyone, as the agent chooses', () => {
  it('no flag and reply_all false answer the sender only', async () => {
    await executeMicrosoftWriteTool('outlook_reply', { message_id: 'm1', body: 'ok' }, 'a1', 'A Worker');
    await executeMicrosoftWriteTool('outlook_reply', { message_id: 'm1', body: 'ok', reply_all: false }, 'a1', 'A Worker');
    expect(endpoints().filter((e) => e.includes('create'))).toEqual(['me/messages/m1/createReply', 'me/messages/m1/createReply']);
    expect(endpoints().some((e) => e.endsWith('/replyAll') || e.includes('createReplyAll'))).toBe(false);
  });

  it('reply_all true answers everyone through Graph\'s replyAll', async () => {
    await executeMicrosoftWriteTool('outlook_reply', { message_id: 'm1', body: 'ok', reply_all: true }, 'a1', 'A Worker');
    expect(endpoints()).toEqual(['me/messages/m1/createReplyAll', 'me/messages/draft-1/send']);
  });

  it('P44 C2: the marker rides in the create call itself (Graph allows custom headers only at creation), so a reply-all that includes the agent\'s own mailbox is recognisable the moment it arrives', async () => {
    await executeMicrosoftWriteTool('outlook_reply', { message_id: 'm1', body: 'ok', reply_all: true }, 'a1', 'A Worker');
    const calls = vi.mocked(msGraphWrite).mock.calls;
    expect(calls.some((c) => c[0] === 'PATCH')).toBe(false);
    const create = calls[0][2] as { comment?: string; message: { body?: unknown; internetMessageHeaders: Array<{ name: string; value: string }> } };
    expect(create.comment).toBe('ok');
    expect(create.message.body, 'a comment is never combined with message.body').toBeUndefined();
    expect(create.message.internetMessageHeaders[0].name).toBe('x-platform-send-id');
    const headers = create.message.internetMessageHeaders;
    expect(isPlatformSent(headers)).toBe(true);
    // The draft's own Message-ID is the second key, recorded before the send.
    expect(isPlatformSent([{ name: 'Message-ID', value: '<aamk-draft@outlook.test>' }])).toBe(true);
    // The mail arrives at the agent's own mailbox from the owner's address, DMARC-passing, with no Sent Items record yet: not the owner.
    mockDb.current!.prepare("INSERT INTO microsoft_accounts (id, kind, position, email, connected) VALUES ('m-user', 'user', 0, 'owner@home.test', 1)").run();
    const arrive = (extra: Array<{ name: string; value: string }>) => judgeOwnerEmail({
      provider: 'outlook', kind: 'agent', placement: 'to', from: 'owner@home.test', deliveryRef: 'test:x:1', newBody: async () => 'close it', isMeeting: async () => false,
      headers: async () => [{ name: 'From', value: 'owner@home.test' }, ...extra, { name: 'Authentication-Results', value: 'BN1PR01CA0001.namprd01.prod.outlook.com; dmarc=pass header.from=home.test' }],
    });
    expect(await arrive([{ name: 'Message-ID', value: '<x@home.test>' }, ...headers])).toEqual({ state: 'none' });
    // Even if Exchange drops the custom header on the delivered copy, the draft's Message-ID still holds.
    expect(await arrive([{ name: 'Message-ID', value: '<AAMk-draft@outlook.test>' }])).toEqual({ state: 'none' });
  });

  it('P44 C2: with a payload message (attachments), the marker is added to it and nothing else is lost', async () => {
    const sent: Array<unknown> = [];
    vi.mocked(msGraphWrite).mockImplementation((async (_m: string, _e: string, body: unknown) => { sent.push(body); return ok({ id: 'draft-1' }); }) as never);
    await sendMarkedDraft('forward', 'm1', { toRecipients: [{ emailAddress: { address: 'a@b.test' } }], message: { body: { contentType: 'Text', content: 'x' }, attachments: [] } }, 'a1', 'A', 'outlook_forward', {}, 'agent');
    const m = (sent[0] as { toRecipients: unknown[]; message: Record<string, unknown> });
    expect(m.toRecipients).toHaveLength(1);
    expect(Object.keys(m.message).sort()).toEqual(['attachments', 'body', 'internetMessageHeaders']);
  });

  it('P44 C2: a refused create sends nothing (no key could be recorded)', async () => {
    vi.mocked(msGraphWrite).mockResolvedValue({ ok: false, data: null, error: 'no', apiEndpoint: 'x' } as never);
    const out = await executeMicrosoftWriteTool('outlook_reply', { message_id: 'm1', body: 'ok', reply_all: true }, 'a1', 'A Worker');
    expect(out).toMatch(/^Error/);
    expect(vi.mocked(msGraphWrite).mock.calls.some((c) => String(c[1]).endsWith('/send'))).toBe(false);
  });
});
