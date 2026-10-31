// With no range given, sheets_read / sheets_append used to assume the first tab is "Sheet1".
// A renamed or translated first tab made Google answer "Unable to parse range". The default range
// is now the first tab's real name, quoted for A1 notation.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));

vi.mock('../client.js', () => ({ googleRead: vi.fn(), googleWrite: vi.fn() }));
const account = {
  id: 'agent', kind: 'agent', position: 1, email: 'agent@example.com',
  enabled: true, connected: true, accessToken: null, refreshToken: null,
  tokenExpiresAt: null, grantedScopes: null, enabledServices: null,
  watchEmail: false, sendEmail: true, lastVerifiedAt: null,
};
vi.mock('../accounts.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveGoogleAccountForTool: vi.fn(() => ({ account })),
  resolveGoogleAccountForRead: vi.fn(() => ({ account, labelAccount: false })),
}));

import { googleRead, googleWrite } from '../client.js';
import { executeGoogleReadTool } from '../tools-read.js';
import { executeGoogleWriteTool } from '../tools-write.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
const urls = () => vi.mocked(googleRead).mock.calls.map((c) => String(c[0]));

function metadata(result: unknown) {
  vi.mocked(googleRead).mockImplementation((async (url: string) => (
    url.includes('fields=sheets.properties.title') ? result : ok({ range: 'x', values: [['a', 'b']] })
  )) as never);
}

beforeEach(() => {
  vi.mocked(googleRead).mockReset();
  vi.mocked(googleWrite).mockReset();
  vi.mocked(googleWrite).mockResolvedValue(ok({}) as never);
});

describe('the default range is the first tab', () => {
  it('reads from a tab with a translated name', async () => {
    metadata(ok({ sheets: [{ properties: { title: 'Hoja 1' } }, { properties: { title: 'Other' } }] }));
    await executeGoogleReadTool('sheets_read', { spreadsheet_id: 's1' }, 'a1', 'A Worker');
    expect(urls().some((u) => u.includes("values/'Hoja%201'"))).toBe(true);
  });

  it('doubles an apostrophe in the tab name', async () => {
    metadata(ok({ sheets: [{ properties: { title: "Bob's Budget" } }] }));
    await executeGoogleReadTool('sheets_read', { spreadsheet_id: 's1' }, 'a1', 'A Worker');
    expect(urls().some((u) => u.includes(`values/${encodeURIComponent("'Bob''s Budget'")}`))).toBe(true);
  });

  it('falls back to Sheet1 when the lookup fails', async () => {
    metadata({ ok: false, data: null, error: 'boom', apiEndpoint: 'x' });
    await executeGoogleReadTool('sheets_read', { spreadsheet_id: 's1' }, 'a1', 'A Worker');
    expect(urls().some((u) => u.endsWith('/values/Sheet1'))).toBe(true);
  });

  it('sheets_append uses the first tab too', async () => {
    metadata(ok({ sheets: [{ properties: { title: 'Hoja 1' } }] }));
    await executeGoogleWriteTool('sheets_append', { spreadsheet_id: 's1', values: 'a,b' }, 'a1', 'A Worker');
    expect(String(vi.mocked(googleWrite).mock.calls[0][1])).toContain("values/'Hoja%201':append");
  });

  it('an explicit range never looks the tab up', async () => {
    metadata(ok({ sheets: [{ properties: { title: 'Hoja 1' } }] }));
    await executeGoogleReadTool('sheets_read', { spreadsheet_id: 's1', range: 'Data!A1:B2' }, 'a1', 'A Worker');
    await executeGoogleWriteTool('sheets_append', { spreadsheet_id: 's1', range: 'Data', values: 'a' }, 'a1', 'A Worker');
    expect(urls().some((u) => u.includes('fields=sheets.properties.title'))).toBe(false);
  });
});
