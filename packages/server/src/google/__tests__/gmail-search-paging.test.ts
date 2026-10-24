// v3.5 B3 — gmail_search pages: page_token goes in, next_page_token comes out, max_results up to 500.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const googleRead = vi.fn();
vi.mock('../client.js', () => ({ googleRead: (...a: unknown[]) => googleRead(...a) }));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForRead: () => ({ account: { id: 'acct-1', email: 'agent@example.invalid' }, labelAccount: false }),
}));
vi.mock('../../tools/unified-read.js', () => ({ otherMailboxesCountSection: async () => '' }));

const { executeGoogleReadTool, googleReadToolDefinitions } = await import('../tools-read.js');

const detail = (id: string) => ({
  ok: true,
  data: { id, snippet: 'hello', payload: { headers: [{ name: 'From', value: 'a@example.invalid' }, { name: 'Subject', value: `s-${id}` }, { name: 'Date', value: 'Wed, 20 May 2026 19:00:00 +0000' }] } },
});
function wire(list: unknown): void {
  googleRead.mockImplementation(async (u: string) => {
    if (String(u).includes('/messages?')) return { ok: true, data: list };
    const m = String(u).match(/\/messages\/([^?/]+)/);
    return m ? detail(m[1]) : { ok: true, data: {} };
  });
}
const listUrl = (): URL => new URL(String(googleRead.mock.calls.find((c) => String(c[0]).includes('/messages?'))?.[0]));
const search = (args: Record<string, unknown>) => executeGoogleReadTool('gmail_search', { query: 'in:inbox', ...args }, 'agent-1', 'A Worker');

beforeEach(() => googleRead.mockReset());

describe('gmail_search paging', () => {
  it('page_token is sent as pageToken', async () => {
    wire({ messages: [{ id: 'a', threadId: 't' }] });
    await search({ page_token: 'TOK123' });
    expect(listUrl().searchParams.get('pageToken')).toBe('TOK123');
  });

  it('no page_token means no pageToken on the wire', async () => {
    wire({ messages: [{ id: 'a', threadId: 't' }] });
    await search({});
    expect(listUrl().searchParams.has('pageToken')).toBe(false);
  });

  it('Gmail\'s nextPageToken shows up as a next_page_token line with the re-call instruction', async () => {
    wire({ messages: [{ id: 'a', threadId: 't' }], nextPageToken: 'NEXT456' });
    const out = await search({});
    expect(out).toContain('next_page_token: NEXT456');
    expect(out).toContain('More results exist: re-call with page_token="NEXT456"');
  });

  it('no nextPageToken means no paging line', async () => {
    wire({ messages: [{ id: 'a', threadId: 't' }] });
    expect(await search({})).not.toMatch(/next_page_token/);
  });

  it('a page with no messages but a nextPageToken still prints the token, so a sweep does not stop early', async () => {
    wire({ nextPageToken: 'NEXT789' });
    const out = await search({});
    expect(out).toContain('next_page_token: NEXT789');
    expect(out).toContain('page_token="NEXT789"');
  });

  it('a page with no messages and no token is the end: no paging line', async () => {
    wire({});
    const out = await search({});
    expect(out).toMatch(/No emails found/);
    expect(out).not.toMatch(/next_page_token/);
  });

  it('max_results: 500 is sent as maxResults=500', async () => {
    wire({ messages: [{ id: 'a', threadId: 't' }] });
    await search({ max_results: 500 });
    expect(listUrl().searchParams.get('maxResults')).toBe('500');
  });

  it('the schema offers page_token and says 500 is the most a page returns', () => {
    const def = googleReadToolDefinitions.find((d) => d.name === 'gmail_search')!;
    const props = (def.input_schema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.page_token).toBeDefined();
    expect(props.max_results.description).toMatch(/500/);
  });
});
