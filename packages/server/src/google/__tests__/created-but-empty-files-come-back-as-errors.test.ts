// docs_create and sheets_create both create the file first and then write its
// first content into it. The create succeeds, so the file exists; but when that
// first write fails the tool used to report a plain success, so the engine (which
// fails a turn only when the text starts with "Error") counted an empty doc or a
// header-less sheet as done. A failed first write must come back as an error that
// still hands back the id (and link) so the agent fills the existing file instead
// of creating a second one.
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

const DOCS_CREATE_URL = 'https://docs.googleapis.com/v1/documents';
const SHEETS_CREATE_URL = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Create a Google Doc (optionally with content), with the :batchUpdate write
 *  answering `writeResult`, and return the tool's text. */
async function createDoc(
  content: string | undefined,
  writeResult: unknown,
): Promise<string> {
  googleWrite.mockReset();
  googleWrite.mockImplementation((...a: unknown[]): Promise<unknown> => {
    const method = a[0] as string;
    const url = a[1] as string;
    if (method === 'POST' && url === DOCS_CREATE_URL) {
      return Promise.resolve({ ok: true, data: { documentId: 'd1' } });
    }
    return Promise.resolve(writeResult);
  });

  const args: Record<string, unknown> = { title: 'Notes' };
  if (content) args.content = content;
  return executeGoogleWriteTool('docs_create', args, 'agent-1', 'Agent');
}

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
    if (method === 'POST' && url === SHEETS_CREATE_URL) {
      return Promise.resolve({ ok: true, data: { spreadsheetId: 'sp1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sp1/edit' } });
    }
    return Promise.resolve(putResult);
  });

  const args: Record<string, unknown> = { title: 'Budget' };
  if (headers) args.headers = headers;
  return executeGoogleWriteTool('sheets_create', args, 'agent-1', 'Agent');
}

describe('docs_create reports a failed content write as an error', () => {
  beforeEach(() => googleWrite.mockReset());

  it('starts with "Error:" but keeps the doc id when the content write fails', async () => {
    const out = await createDoc('Meeting notes', { ok: false, error: 'HTTP 500' });
    expect(out).toMatch(/^Error:/);
    expect(out).toContain('d1');
  });

  it('starts with "Google Doc " when the content write succeeds', async () => {
    const out = await createDoc('Meeting notes', { ok: true, data: {} });
    expect(out).toMatch(/^Google Doc "/);
  });
});

describe('sheets_create reports a failed header write as an error', () => {
  beforeEach(() => googleWrite.mockReset());

  it('starts with "Error:" but keeps the sheet id and link when the header write fails', async () => {
    const out = await createSpreadsheet(['Name', 'Amount'], { ok: false, error: 'Unable to parse range: Sheet1!A1' });
    expect(out).toMatch(/^Error:/);
    expect(out).toContain('sp1');
    expect(out).toContain('writing the header row failed');
  });

  it('starts with "Spreadsheet " when the header write succeeds', async () => {
    const out = await createSpreadsheet(['Name', 'Amount'], { ok: true, data: {} });
    expect(out).toMatch(/^Spreadsheet "/);
  });
});
