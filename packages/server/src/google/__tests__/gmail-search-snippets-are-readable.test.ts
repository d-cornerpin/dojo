// 3.5 release testing, O4: gmail_search showed Gmail's HTML-escaped snippet raw ("&#39;", "&amp;"), which an agent then
// quotes to the owner. Gmail escapes the snippet field; the tool must show the text the way the mail reads.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({ googleRead: vi.fn(), googleWrite: vi.fn() }));
import { googleRead } from '../client.js';
import { searchMailForAccount } from '../gmail-search.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
beforeEach(() => { vi.mocked(googleRead).mockReset(); });

describe('gmail_search snippets', () => {
  it('decode HTML entities', async () => {
    vi.mocked(googleRead).mockImplementation((async (url: string) => String(url).includes('/messages?')
      ? ok({ messages: [{ id: 'm1' }] })
      : ok({ id: 'm1', snippet: 'Don&#39;t miss Q&amp;A &mdash; caf&eacute; &lt;3', payload: { headers: [{ name: 'Subject', value: 'hi' }] } })) as never);
    const out = await searchMailForAccount('acct', 'in:inbox', 5, 'a1', 'A');
    expect(out.ok && out.items[0].snippet).toBe('Don\'t miss Q&A — café <3');
  });
});
