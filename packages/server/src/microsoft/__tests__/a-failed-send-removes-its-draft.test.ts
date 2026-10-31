// A failed `/send` leaves a finished reply sitting in the Drafts folder, and the agent's natural reaction to
// the error is to call the tool again — so retries pile up half-made replies in the mailbox. The failure branch
// therefore deletes the draft best-effort and says honestly in the error whether that removal worked.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({
  msGraphRead: vi.fn(), msGraphWrite: vi.fn(), graphFetch: vi.fn(),
  calendarPrefix: () => 'me/', drivePrefix: () => 'me/drive/',
}));
const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));

import { msGraphWrite } from '../client.js';
import { sendMarkedDraft } from '../send-as-draft.js';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrations.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
const calls = (): Array<[string, string]> => vi.mocked(msGraphWrite).mock.calls.map((c) => [String(c[0]), String(c[1])] as [string, string]);

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(); vi.mocked(msGraphWrite).mockReset(); vi.mocked(msGraphWrite).mockResolvedValue(ok({ id: 'draft-1', internetMessageId: '<AAMk-draft@outlook.test>' }) as never); });

const reply = () => sendMarkedDraft('reply', 'm1', { comment: 'ok' }, 'a1', 'A', 'outlook_reply', {}, 'slot');

/** The draft is created, the send fails with 503, the delete answers `del`. */
const createThenFailToSend = (del: unknown) => vi.mocked(msGraphWrite).mockImplementation((async (method: string, endpoint: string) => {
  if (endpoint.endsWith('createReply')) return ok({ id: 'draft-1', internetMessageId: '<d1@x.test>' });
  if (endpoint.endsWith('/send')) return { ok: false, data: null, error: 'HTTP 503', apiEndpoint: 'x' };
  if (method === 'DELETE') return del;
  return ok(null);
}) as never);

describe('a failed Outlook send — no half-made reply is left behind', () => {
  it('the failed send removes its draft and says so', async () => {
    createThenFailToSend(ok(undefined));
    const out = await reply();
    expect(calls()).toEqual([['POST', 'me/messages/m1/createReply'], ['POST', 'me/messages/draft-1/send'], ['DELETE', 'me/messages/draft-1']]);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('HTTP 503');
    expect(out.error).toContain('its draft was removed');
  });

  it('when even the delete fails, the error says where the draft still is', async () => {
    createThenFailToSend({ ok: false, data: null, error: 'x', apiEndpoint: 'x' });
    const out = await reply();
    expect(out.error).toContain("still in the mailbox's Drafts folder");
  });

  it('a send that succeeds deletes nothing', async () => {
    vi.mocked(msGraphWrite).mockImplementation((async (_method: string, endpoint: string) => {
      if (endpoint.endsWith('createReply')) return ok({ id: 'draft-1', internetMessageId: '<d1@x.test>' });
      return ok(undefined);
    }) as never);
    const out = await reply();
    expect(out.ok).toBe(true);
    expect(calls()).toEqual([['POST', 'me/messages/m1/createReply'], ['POST', 'me/messages/draft-1/send']]);
  });
});
