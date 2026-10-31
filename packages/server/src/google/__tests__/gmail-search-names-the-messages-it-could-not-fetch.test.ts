// A detail fetch that fails must not drop the message silently: the result names the missing ids.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const googleRead = vi.fn();
vi.mock('../client.js', () => ({ googleRead: (...a: unknown[]) => googleRead(...a) }));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForRead: () => ({ account: { id: 'acct-1', email: 'agent@example.invalid' }, labelAccount: false }),
}));
vi.mock('../../tools/unified-read.js', () => ({ otherMailboxesCountSection: async () => '' }));

const { executeGoogleReadTool } = await import('../tools-read.js');

const detail = (id: string) => ({
  ok: true,
  data: { id, snippet: 'hello', payload: { headers: [{ name: 'From', value: 'a@example.invalid' }, { name: 'Subject', value: `s-${id}` }, { name: 'Date', value: 'Wed, 20 May 2026 19:00:00 +0000' }] } },
});
function wire(list: unknown, failIds: string[] = []): void {
  googleRead.mockImplementation(async (u: string) => {
    if (String(u).includes('/messages?')) return { ok: true, data: list };
    const m = String(u).match(/\/messages\/([^?/]+)/);
    if (!m) return { ok: true, data: {} };
    if (failIds.includes(m[1])) return { ok: false, error: 'HTTP 429' };
    return detail(m[1]);
  });
}
const search = (args: Record<string, unknown>) => executeGoogleReadTool('gmail_search', { query: 'in:inbox', ...args }, 'agent-1', 'A Worker');

beforeEach(() => googleRead.mockReset());

describe('gmail_search names the messages it could not fetch', () => {
  it('a failed detail fetch names the missing id instead of dropping it silently', async () => {
    wire({ messages: [{ id: 'a', threadId: 't' }, { id: 'b', threadId: 't' }, { id: 'c', threadId: 't' }] }, ['b']);
    const out = await search({});
    expect(out).toContain('Found 3 email(s)');
    expect(out).toContain('ID: a');
    expect(out).toContain('ID: c');
    expect(out).toContain('Note: 1 of 3 messages on this page could not be fetched and are not shown (ids b); read one with gmail_read(message_id=<id>) or search again.');
  });

  it('every detail failed: the old line stays and names all the ids', async () => {
    wire({ messages: [{ id: 'a', threadId: 't' }, { id: 'b', threadId: 't' }, { id: 'c', threadId: 't' }] }, ['a', 'b', 'c']);
    const out = await search({});
    expect(out).toContain('could not fetch details');
    expect(out).toContain('(ids a, b, c)');
  });

  it('nothing failed: no Note line', async () => {
    wire({ messages: [{ id: 'a', threadId: 't' }] });
    const out = await search({});
    expect(out).not.toContain('Note:');
  });
});
