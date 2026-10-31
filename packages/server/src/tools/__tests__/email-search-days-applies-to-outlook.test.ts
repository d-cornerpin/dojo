import { describe, it, expect, vi, beforeEach } from 'vitest';

const searchMs = vi.fn();
vi.mock('../../google/tools-read.js', () => ({ searchMailForAccount: vi.fn() }));
vi.mock('../../microsoft/tools-read.js', () => ({ searchMailForAccountMs: (...a: unknown[]) => searchMs(...a) }));
vi.mock('../../google/accounts.js', () => ({ listGoogleAccounts: () => [] }));
vi.mock('../../microsoft/accounts.js', () => ({
  listMicrosoftAccounts: (kind: string) =>
    kind === 'user' ? [{ id: 'ms1', email: 'owner@ms.test', connected: true, enabledServices: ['outlook'] }] : [],
}));

import { unifiedEmailSearch, otherMailboxesCountSection } from '../unified-read.js';

const DAY = 86400000;
function item(id: string, ageDays: number) {
  return {
    id, from: 'S <s@ex.test>', subject: `subj-${id}`, snippet: '', read: true,
    dateDisplay: `d-${id}`, dateSortMs: Date.now() - ageDays * DAY,
  };
}

describe('email_search days applies to Outlook', () => {
  beforeEach(() => {
    searchMs.mockReset();
    searchMs.mockResolvedValue({ ok: true, items: [item('recent', 2), item('ancient', 400)] });
  });

  it('drops Outlook mail older than days', async () => {
    const out = await unifiedEmailSearch({ query: 'invoice', days: 30 }, 'a1', 'Agent');
    expect(out).toContain('subj-recent');
    expect(out).not.toContain('subj-ancient');
  });

  it('keeps everything when days is 0', async () => {
    const out = await unifiedEmailSearch({ query: 'invoice', days: 0 }, 'a1', 'Agent');
    expect(out).toContain('subj-recent');
    expect(out).toContain('subj-ancient');
  });

  it('other-mailbox count only counts the window', async () => {
    const out = await otherMailboxesCountSection(
      { provider: 'google', accountId: 'g-none' }, 'invoice', 30, 'a1', 'Agent');
    expect(out).toContain('1 in');
  });
});
