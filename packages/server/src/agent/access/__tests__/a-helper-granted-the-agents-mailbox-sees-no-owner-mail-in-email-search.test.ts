// A helper granted only the agent's own Google account searches mail across every mailbox: it sees the
// agent's mail and nothing from the owner's mailbox. The main agent, holding every account, sees both.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { MOST_RESTRICTIVE_GRANTS, cloneGrants } from '@dojo/shared';

vi.mock('../../../google/gmail-search.js', () => ({
  searchMailForAccount: async (accountId: string) => ({
    ok: true, total: 1, unfetched: [],
    items: [{ id: `m-${accountId}`, from: 'S <s@example.com>', to: '', subject: `mail-in-${accountId}`, dateDisplay: 'today', dateSortMs: Date.now(), snippet: '', read: undefined }],
  }),
}));

import { scratchDojo, MAIN, HELPER, OPEN_SCOPE } from '../../tools/__tests__/scratch-dojo.js';
import { getDb } from '../../../db/connection.js';

const grants = cloneGrants(MOST_RESTRICTIVE_GRANTS);
grants.tools.categories = '*';
grants.integrations.google.agent = 'read';
const dojo = await scratchDojo('agents-mailbox-only', {}, { ...OPEN_SCOPE, grants });

beforeAll(() => {
  const add = getDb().prepare("INSERT INTO google_accounts (id, kind, position, email, enabled, connected) VALUES (?, ?, 1, ?, 1, 1)");
  add.run('ga', 'agent', 'agent@example.com');
  add.run('gu', 'user', 'owner@example.com');
});

describe("a helper granted the agent's mailbox sees no owner mail in email_search", () => {
  it('the helper sees only the agent mailbox', async () => {
    const out = await dojo.text(HELPER, 'email_search', { query: 'invoice' });
    expect(out).toContain('mail-in-ga');
    expect(out).not.toContain('mail-in-gu');
  });

  it('the main agent sees both', async () => {
    const out = await dojo.text(MAIN, 'email_search', { query: 'invoice' });
    expect(out).toContain('mail-in-ga');
    expect(out).toContain('mail-in-gu');
  });
});
