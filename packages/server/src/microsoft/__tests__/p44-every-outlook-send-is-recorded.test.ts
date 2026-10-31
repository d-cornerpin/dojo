// P44 review C2: Outlook `sendMail` carries a recorded x- send id; a reply or forward cannot, so the Sent Items
// copy's Message-ID is recorded once it is found. Mail the platform sends is then recognisable on arrival.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));
vi.mock('../client.js', () => ({
  msGraphRead: vi.fn(), msGraphWrite: vi.fn(), graphFetch: vi.fn(), calendarPrefix: () => 'me/', drivePrefix: () => 'me/drive/',
}));
vi.mock('../accounts.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../accounts.js');
  const account = { id: 'user', kind: 'user', position: 1, email: 'owner@home.test', connected: true, sendEmail: true };
  return { ...actual, resolveMicrosoftAccountForTool: vi.fn(() => ({ account })), resolveMicrosoftAccountForRead: vi.fn(() => ({ account, labelAccount: false })) };
});
vi.mock('../../tools/unified-read.js', () => ({ otherMailboxesCountSection: vi.fn(async () => '') }));
import { runMigrations } from '../../db/migrations.js';
import { msGraphRead, msGraphWrite } from '../client.js';
import { executeMicrosoftWriteTool } from '../tools-write.js';
import { isPlatformSent } from '../../services/platform-sends.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
beforeEach(() => {
  mockDb.current = new Database(':memory:'); runMigrations();
  vi.mocked(msGraphWrite).mockReset(); vi.mocked(msGraphRead).mockReset();
  vi.mocked(msGraphWrite).mockResolvedValue(ok({}) as never);
  vi.mocked(msGraphRead).mockResolvedValue(ok({ value: [{ id: 'sent-1', subject: 'x', sentDateTime: new Date().toISOString(), internetMessageId: '<AAMk-copy@outlook.test>', toRecipients: [{ emailAddress: { address: 'agent@x.test' } }] }] }) as never);
});

describe('P44 C2 — every Outlook send is recorded', () => {
  it('sendMail carries a recorded x-platform-send-id header', async () => {
    await executeMicrosoftWriteTool('user_outlook_send', { to: 'agent@x.test', subject: 'x', body: 'close it' }, 'a1', 'A Worker');
    const sent = vi.mocked(msGraphWrite).mock.calls.find((c) => String(c[1]) === 'me/sendMail')![2] as { message: { internetMessageHeaders: Array<{ name: string; value: string }> } };
    expect(sent.message.internetMessageHeaders[0].name).toBe('x-platform-send-id');
    expect(isPlatformSent(sent.message.internetMessageHeaders)).toBe(true);
  });

  it('a forward is recorded from its Sent Items copy', async () => {
    await executeMicrosoftWriteTool('user_outlook_forward', { message_id: 'orig1', to: 'agent@x.test', body: 'close it' }, 'a1', 'A Worker');
    expect(isPlatformSent([{ name: 'Message-ID', value: '<aamk-copy@outlook.test>' }])).toBe(true);
  });
});
