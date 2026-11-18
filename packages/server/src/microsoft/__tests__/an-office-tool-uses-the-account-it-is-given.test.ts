// "Put it in my OneDrive" lands in the owner's: an Office tool given `account` (an email) works on that
// Microsoft account; with no `account` it works on the agent's first connected one. A name that matches
// no connected account is refused before anything reaches Microsoft.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../auth.js', () => ({
  getValidAccessTokenForAccount: vi.fn(async (id: string) => `token-for-${id}`),
}));
vi.mock('../accounts.js', () => ({
  listMicrosoftAccounts: () => [
    { id: 'agent-acct', kind: 'agent', email: 'agent@example.com', connected: true },
    { id: 'owner-acct', kind: 'user', email: 'owner@example.com', connected: true },
  ],
}));
vi.mock('../activity-log.js', () => ({ logMicrosoftActivity: vi.fn() }));
vi.mock('../graph-fetch.js', () => ({
  GRAPH_BASE: 'https://graph.test/v1.0',
  graphFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' })),
}));

import { graphFetch } from '../graph-fetch.js';
import { executeOfficeTool } from '../tools-office.js';

const tokenUsed = (): string => {
  const init = vi.mocked(graphFetch).mock.calls[0][2] as RequestInit;
  return (init.headers as Record<string, string>).Authorization;
};

beforeEach(() => {
  vi.mocked(graphFetch).mockClear();
});

describe('an office tool uses the account it is given', () => {
  it('the owner named by account', async () => {
    const out = await executeOfficeTool('office_add_sheet', { file_id: 'f1', sheet_name: 'Q3', account: 'owner@example.com' }, 'agent-main', 'Main');
    expect(out).toContain('Added worksheet');
    expect(tokenUsed()).toBe('Bearer token-for-owner-acct');
  });

  it("the agent's own account when none is named", async () => {
    await executeOfficeTool('office_add_sheet', { file_id: 'f1', sheet_name: 'Q3' }, 'agent-main', 'Main');
    expect(tokenUsed()).toBe('Bearer token-for-agent-acct');
  });

  it('an account that is not connected is refused before any call', async () => {
    const out = await executeOfficeTool('office_add_sheet', { file_id: 'f1', sheet_name: 'Q3', account: 'nobody@example.com' }, 'agent-main', 'Main');
    expect(out).toBe('Error: No connected Microsoft account matches "nobody@example.com". Connected: agent@example.com, owner@example.com.');
    expect(graphFetch).not.toHaveBeenCalled();
  });
});
