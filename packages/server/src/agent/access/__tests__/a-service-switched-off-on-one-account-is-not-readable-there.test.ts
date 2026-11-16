// Two agent mailboxes, Gmail switched off on the second: a helper granted the agent's accounts reads the
// first and is refused the second, before anything reaches Google.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { MOST_RESTRICTIVE_GRANTS, cloneGrants } from '@dojo/shared';

const fetched = vi.fn();
vi.mock('../../../google/client.js', () => {
  const answer = async (...a: unknown[]) => { fetched(...a); return { ok: true, data: { messages: [] }, apiEndpoint: 'x' }; };
  return { googleRead: answer, googleWrite: answer, googleSilentFetch: answer };
});

import { scratchDojo, HELPER, OPEN_SCOPE } from '../../tools/__tests__/scratch-dojo.js';
import { getDb } from '../../../db/connection.js';

const grants = cloneGrants(MOST_RESTRICTIVE_GRANTS);
grants.tools.categories = '*';
grants.integrations.google.agent = 'read';
const dojo = await scratchDojo('service-off-account', {}, { ...OPEN_SCOPE, grants });

beforeAll(() => {
  const add = getDb().prepare("INSERT INTO google_accounts (id, kind, position, email, enabled, connected, enabled_services) VALUES (?, 'agent', ?, ?, 1, 1, ?)");
  add.run('g1', 1, 'one@example.com', null);
  add.run('g2', 2, 'two@example.com', JSON.stringify({ gmail: false }));
});
beforeEach(() => fetched.mockClear());

describe('a service switched off on one account is not readable there', () => {
  it('the switched-off mailbox is refused', async () => {
    const r = await dojo.run(HELPER, 'gmail_search', { query: 'invoice', account: 'two@example.com' });
    expect(dojo.blocked(r)).toBe(true);
    expect(fetched).not.toHaveBeenCalled();
  });

  it('the other mailbox is read', async () => {
    const r = await dojo.run(HELPER, 'gmail_search', { query: 'invoice', account: 'one@example.com' });
    expect(dojo.blocked(r)).toBe(false);
    expect(fetched).toHaveBeenCalled();
  });
});
