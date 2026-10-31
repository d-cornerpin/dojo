import { describe, it, expect, vi, beforeEach } from 'vitest';

const searchMock = vi.fn();

vi.mock('../../google/accounts.js', () => ({
  listGoogleAccounts: (kind: string) =>
    kind === 'agent'
      ? [{ id: 'g1', email: 'box@ex.test', connected: true, enabledServices: ['gmail'] }]
      : [],
}));
vi.mock('../../microsoft/accounts.js', () => ({ listMicrosoftAccounts: () => [] }));
vi.mock('../../google/tools-read.js', () => ({
  searchMailForAccount: (...a: unknown[]) => searchMock(...a),
}));
vi.mock('../../microsoft/tools-read.js', () => ({ searchMailForAccountMs: vi.fn() }));

import { unifiedEmailSearch } from '../unified-read.js';

const item = (id: string) => ({
  id, from: 'Sender <s@ex.test>', to: '', subject: `subject-${id}`,
  dateDisplay: 'today', dateSortMs: 1, snippet: '', read: undefined,
});

describe('email_search names Gmail matches it could not fetch', () => {
  beforeEach(() => searchMock.mockReset());

  it('all detail fetches failed: says unreadable, not "no matching email"', async () => {
    searchMock.mockResolvedValue({ ok: true, total: 3, items: [], unfetched: ['a', 'b', 'c'] });
    const out = await unifiedEmailSearch({ query: 'invoice' }, 'ag', 'Agent');
    expect(out).toContain('could not be read');
    expect(out).not.toContain('No matching email in any connected mailbox');
    expect(out).not.toContain('Empty in this window');
  });

  it('partial: lists the readable item and names the unread count', async () => {
    searchMock.mockResolvedValue({ ok: true, total: 3, items: [item('x1')], unfetched: ['b', 'c'] });
    const out = await unifiedEmailSearch({ query: 'invoice' }, 'ag', 'Agent');
    expect(out).toContain('subject-x1');
    expect(out).toContain('2 of 3 matching messages could not be read');
  });

  it('clean empty still says no matching email', async () => {
    searchMock.mockResolvedValue({ ok: true, total: 0, items: [], unfetched: [] });
    const out = await unifiedEmailSearch({ query: 'invoice' }, 'ag', 'Agent');
    expect(out).toContain('No matching email in any connected mailbox');
  });
});
