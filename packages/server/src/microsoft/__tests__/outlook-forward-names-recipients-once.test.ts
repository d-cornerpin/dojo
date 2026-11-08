// D3 (3.5 release testing): Graph's createForward takes the recipients EITHER as the action's own `toRecipients`
// OR inside the `message` object, never both ("ToRecipients specified both in message object and in the action").
// A forward with extra attachments used to send both. The request body must name the recipients exactly once, and
// still carry the custom body and the attachments.
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
vi.mock('../../services/email-attachments.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../services/email-attachments.js');
  return { ...actual, readLocalAttachments: vi.fn(() => ({ ok: true, attachments: [{ path: '/x/a.txt', name: 'a.txt', size: 3, mimeType: 'text/plain', content: Buffer.from('abc') }] })) };
});

import Database from 'better-sqlite3';
import { msGraphWrite, msGraphRead } from '../client.js';
import { runMigrations } from '../../db/migrations.js';
import { executeMicrosoftWriteTool } from '../tools-write.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
type Body = { toRecipients?: unknown[]; comment?: string; message?: { toRecipients?: unknown[]; body?: { content: string }; attachments?: unknown[] } };
const createBody = (): Body => vi.mocked(msGraphWrite).mock.calls.find((c) => String(c[1]).endsWith('/createForward'))![2] as Body;

beforeEach(() => {
  mockDb.current = new Database(':memory:'); runMigrations();
  vi.mocked(msGraphWrite).mockReset(); vi.mocked(msGraphRead).mockReset();
  vi.mocked(msGraphWrite).mockResolvedValue(ok({ id: 'draft-1', internetMessageId: '<d@x>' }) as never);
  vi.mocked(msGraphRead).mockResolvedValue(ok({ value: [] }) as never);
});

describe('outlook_forward names the recipients in exactly one place', () => {
  it('with extra attachments: recipients once, custom body and attachments kept', async () => {
    const out = await executeMicrosoftWriteTool('outlook_forward', { message_id: 'm1', to: 'x@y.test', body: 'see attached', attachments: ['/x/a.txt'] }, 'a1', 'A Worker');
    expect(out).toMatch(/forwarded/);
    const b = createBody();
    const places = [b.toRecipients, b.message?.toRecipients].filter((r) => r !== undefined);
    expect(places, 'Graph refuses recipients in both the action and the message').toHaveLength(1);
    expect(places[0]).toHaveLength(1);
    expect(b.comment).toContain('see attached');
    expect(b.message?.attachments).toHaveLength(1);
  });

  it('without attachments: recipients once, the comment rides as the action\'s comment', async () => {
    await executeMicrosoftWriteTool('outlook_forward', { message_id: 'm1', to: 'x@y.test', body: 'fyi' }, 'a1', 'A Worker');
    const b = createBody();
    expect(b.toRecipients).toHaveLength(1);
    expect(b.message?.toRecipients).toBeUndefined();
    expect(b.comment).toBe('fyi');
  });
});

// B-3 (3.5 paid proof): a forward with an added attachment and a custom body lost the original quoted text because
// the text went in `message.body`, which replaces Graph's body. Graph keeps the quote only with `comment`, and takes
// `comment` OR `message.body`, never both.
describe('outlook_forward keeps the original quoted message', () => {
  const run = (args: Record<string, unknown>) => executeMicrosoftWriteTool('outlook_forward', { message_id: 'm1', to: 'x@y.test', ...args }, 'a1', 'A Worker');
  it('body only: text is the comment, no message body', async () => {
    await run({ body: 'note' });
    const b = createBody();
    expect(b.comment).toBe('note');
    expect(b.message?.body).toBeUndefined();
    expect(b.message?.attachments).toBeUndefined();
  });
  it('attachments only: no comment, no message body, attachments in message', async () => {
    await run({ attachments: ['/x/a.txt'] });
    const b = createBody();
    expect(b.comment).toBeUndefined();
    expect(b.message?.body).toBeUndefined();
    expect(b.message?.attachments).toHaveLength(1);
  });
  it('body plus attachments: text is the comment, attachments in message, never message.body', async () => {
    await run({ body: 'note', attachments: ['/x/a.txt'] });
    const b = createBody();
    expect(b.comment).toBe('note');
    expect(b.message?.body, 'message.body would replace the quoted original').toBeUndefined();
    expect(b.message?.attachments).toHaveLength(1);
    expect(b.toRecipients).toHaveLength(1);
    expect(b.message?.toRecipients).toBeUndefined();
  });
});
