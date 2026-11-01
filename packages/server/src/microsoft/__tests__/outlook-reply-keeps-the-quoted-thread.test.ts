// Same defect as the forward (B-3): a reply or draft-reply with attachments put the text in `message.body`, which
// replaces the body Graph builds and drops the quoted thread. The text must ride as `comment`; `message` carries only
// the attachments. Pinned for outlook_reply, reply-all, and the outlook_draft reply branch, with and without files.
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
vi.mock('../../services/outlook-owner-gate.js', () => ({ outlookOwnerConfirmationOpen: () => true }));
vi.mock('../../services/email-attachments.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../services/email-attachments.js');
  return { ...actual, readLocalAttachments: vi.fn(() => ({ ok: true, attachments: [{ path: '/x/a.txt', name: 'a.txt', size: 3, mimeType: 'text/plain', content: Buffer.from('abc') }] })) };
});

import Database from 'better-sqlite3';
import { msGraphWrite, msGraphRead } from '../client.js';
import { runMigrations } from '../../db/migrations.js';
import { executeMicrosoftWriteTool } from '../tools-write.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
type Body = { comment?: string; message?: { body?: unknown; attachments?: unknown[] } };
const createBody = (suffix: string): Body => vi.mocked(msGraphWrite).mock.calls.find((c) => String(c[1]).endsWith(suffix))![2] as Body;

beforeEach(() => {
  mockDb.current = new Database(':memory:'); runMigrations();
  vi.mocked(msGraphWrite).mockReset(); vi.mocked(msGraphRead).mockReset();
  vi.mocked(msGraphWrite).mockResolvedValue(ok({ id: 'draft-1', internetMessageId: '<d@x>' }) as never);
  vi.mocked(msGraphRead).mockResolvedValue(ok({ value: [] }) as never);
});

describe.each([
  ['outlook_reply', { reply_all: false }, '/createReply', 'a reply'],
  ['outlook_reply', { reply_all: true }, '/createReplyAll', 'a reply-all'],
  ['outlook_draft', { reply_to_message_id: 'm1' }, '/createReply', 'a draft reply'],
  ['outlook_draft', { reply_to_message_id: 'm1', reply_all: true }, '/createReplyAll', 'a draft reply-all'],
] as const)('%s (%s) keeps the quoted thread', (tool, extra, suffix, label) => {
  const run = (args: Record<string, unknown>) => executeMicrosoftWriteTool(tool, { message_id: 'm1', body: 'note', ...extra, ...args }, 'a1', 'A Worker');
  it(`${label}, text only: comment, no message`, async () => {
    await run({});
    const b = createBody(suffix);
    expect(b.comment).toBe('note');
    expect(b.message?.body).toBeUndefined();
  });
  it(`${label}, with attachments: text is the comment, message holds only the attachments`, async () => {
    await run({ attachments: ['/x/a.txt'] });
    const b = createBody(suffix);
    expect(b.comment).toBe('note');
    expect(b.message?.body, 'message.body would replace the quoted thread').toBeUndefined();
    expect(b.message?.attachments).toHaveLength(1);
  });
});
