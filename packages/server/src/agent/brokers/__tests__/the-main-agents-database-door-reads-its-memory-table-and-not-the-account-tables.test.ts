// The main agent's read-only sqlite3 door reads its own memory table; the credential and account
// tables stay refused. Decisions only: nothing runs.

import { describe, it, expect, vi } from 'vitest';

const PRIMARY = 'primary-agent';
vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()),
  isPrimaryAgent: (id: string) => id === PRIMARY,
}));

const { authorizeExecShapedCall } = await import('../exec-seam.js');
const { grantForManifest } = await import('../grants.js');
const { PRIMARY_AGENT_PERMISSIONS } = await import('../../manifest.js');

const main = grantForManifest(PRIMARY, PRIMARY_AGENT_PERMISSIONS);
const select = (table: string): boolean =>
  authorizeExecShapedCall(main, 'shell', `sqlite3 -readonly ~/.dojo/data/dojo.db "SELECT * FROM ${table} LIMIT 5"`).allowed;

describe("the main agent's database door reads its memory table and not the account tables", () => {
  it('reads vault_entries', () => {
    expect(select('vault_entries')).toBe(true);
  });

  it.each(['agent_credentials', 'google_accounts', 'microsoft_accounts', 'twilio_config', 'github_account', 'plaud'])('refuses %s', (table) => {
    expect(select(table)).toBe(false);
  });
});
