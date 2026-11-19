// Appending rows to an Excel file on OneDrive writes below the last used row, wherever the data starts,
// and never over existing rows. When the used range cannot be read, nothing is written.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../auth.js', () => ({
  getValidAccessTokenForAccount: vi.fn(async () => 'token'),
}));
vi.mock('../accounts.js', () => ({
  listMicrosoftAccounts: () => [{ id: 'agent-acct', kind: 'agent', email: 'agent@example.com', connected: true }],
}));
vi.mock('../activity-log.js', () => ({ logMicrosoftActivity: vi.fn() }));
vi.mock('../graph-fetch.js', () => ({ GRAPH_BASE: 'https://graph.test/v1.0', graphFetch: vi.fn() }));

import { graphFetch } from '../graph-fetch.js';
import { executeOfficeTool } from '../tools-office.js';

const reply = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body, text: async () => '' }) as unknown as Response;

/** Data starts on row 5 and fills rows 5 to 7. Graph returns only the fields `$select` names. */
function graphWithUsedRange(usedOk: boolean) {
  vi.mocked(graphFetch).mockImplementation((async (_agent: unknown, url: string) => {
    if (url.includes('/usedRange')) {
      if (!usedOk) return reply({}, false);
      const select = decodeURIComponent(url.split('$select=')[1] ?? '').split(',');
      const full: Record<string, unknown> = { address: 'Sheet1!A5:B7', rowIndex: 4, rowCount: 3, columnCount: 2 };
      return reply(Object.fromEntries(Object.entries(full).filter(([k]) => select.includes(k))));
    }
    if (url.includes('?$select=name,parentReference')) return reply({ name: 'book.xlsx' });
    return reply({});
  }) as never);
}

const patches = () => vi.mocked(graphFetch).mock.calls
  .filter((c) => (c[2] as RequestInit | undefined)?.method === 'PATCH')
  .map((c) => decodeURIComponent(String(c[1])));

beforeEach(() => {
  vi.mocked(graphFetch).mockReset();
});

describe('an Excel append', () => {
  it('writes on the first empty row below the data', async () => {
    graphWithUsedRange(true);
    const out = await executeOfficeTool('office_append_spreadsheet_rows', { file_id: 'f1', sheet_name: 'Sheet1', rows: [['x', 'y']] }, 'agent-main', 'Main');
    expect(out).toContain('A8:B8');
    expect(patches()).toHaveLength(1);
    expect(patches()[0]).toContain("range(address='A8:B8')");
  });

  it('writes nothing when the used range cannot be read', async () => {
    graphWithUsedRange(false);
    const out = await executeOfficeTool('office_append_spreadsheet_rows', { file_id: 'f1', sheet_name: 'Sheet1', rows: [['x', 'y']] }, 'agent-main', 'Main');
    expect(out).toBe("Error appending rows: the sheet's used range could not be read (HTTP 500), so no rows were written.");
    expect(patches()).toHaveLength(0);
  });
});
