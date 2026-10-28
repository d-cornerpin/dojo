// sheets_create must write the header row to the first tab by a bare range, and
// must tell the truth when that write fails.
//
// The header row was written to a hard-coded tab name (`Sheet1!A1`) and the write's
// result was thrown away, so a tab whose default name is not "Sheet1" (a non-English
// account) made the write fail silently, and the tool still reported the sheet created
// with its headers. The range is now tab-name-free, and a failed write is reported.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const googleRead = vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve({ ok: true, data: null }));
const googleWrite = vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve({ ok: true, data: {} }));
vi.mock('../client.js', () => ({
  googleRead: (...a: unknown[]) => googleRead(...a),
  googleWrite: (...a: unknown[]) => googleWrite(...a),
}));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForTool: () => ({ account: { id: 'acct-1', email: 'agent@example.invalid', sendEmail: true, connected: true } }),
  getPrimaryGoogleAccount: () => null,
}));
vi.mock('../../receipts/store.js', () => ({ writeToolReceipt: vi.fn() }));

const { executeGoogleWriteTool } = await import('../tools-write.js');

const CREATE_URL = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Create a "Budget" spreadsheet (optionally with a header row), with the PUT
 *  header write answering `putResult`, and return the tool's text. */
async function createSpreadsheet(
  headers: string[] | undefined,
  putResult: unknown,
): Promise<string> {
  googleWrite.mockReset();
  googleWrite.mockImplementation((...a: unknown[]): Promise<unknown> => {
    const method = a[0] as string;
    const url = a[1] as string;
    if (method === 'POST' && url === CREATE_URL) {
      return Promise.resolve({ ok: true, data: { spreadsheetId: 'sp1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sp1/edit' } });
    }
    return Promise.resolve(putResult);
  });

  const args: Record<string, unknown> = { title: 'Budget' };
  if (headers) args.headers = headers;
  return executeGoogleWriteTool('sheets_create', args, 'agent-1', 'Agent');
}

describe('sheets_create writes the header row to the first tab', () => {
  beforeEach(() => googleWrite.mockReset());

  it('targets a bare A1 range, not a hard-coded tab name', async () => {
    await createSpreadsheet(['Name', 'Amount'], { ok: true, data: {} });
    const put = googleWrite.mock.calls.find((c) => c[0] === 'PUT');
    expect(put).toBeDefined();
    expect(put![1]).toBe('https://sheets.googleapis.com/v4/spreadsheets/sp1/values/A1?valueInputOption=USER_ENTERED');
  });

  it('reports a failed header write instead of claiming the headers are in the sheet', async () => {
    const out = await createSpreadsheet(['Name', 'Amount'], { ok: false, error: 'Unable to parse range: Sheet1!A1' });
    expect(out).toContain('writing the header row failed: Unable to parse range: Sheet1!A1');
    expect(out).toContain('Spreadsheet "Budget" created');
  });

  it('omits the failure note when the header write succeeds', async () => {
    const out = await createSpreadsheet(['Name', 'Amount'], { ok: true, data: {} });
    expect(out).not.toContain('header row failed');
    expect(out).toContain('Link: https://docs.google.com/spreadsheets/d/sp1/edit');
  });

  it('makes no header write when no headers are given', async () => {
    const out = await createSpreadsheet(undefined, { ok: true, data: {} });
    const put = googleWrite.mock.calls.find((c) => c[0] === 'PUT');
    expect(put).toBeUndefined();
    expect(out).not.toContain('header row failed');
  });
});
