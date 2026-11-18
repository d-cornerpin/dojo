// A worksheet called "Bob's Sheet" broke every OneDrive worksheet operation: the name was only
// URL-encoded into `worksheets('...')`, but `encodeURIComponent` leaves `'` as it is, so Graph
// received an OData string closed early by the apostrophe and answered a syntax error. The same
// happened when no sheet was named and the workbook's first sheet had the apostrophe. Inside a
// single-quoted OData string the apostrophe is written twice before the text is URL-encoded, as
// elsewhere in this folder.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../auth.js', () => ({ getValidAccessTokenForAccount: vi.fn(async () => 'token') }));
vi.mock('../accounts.js', () => ({ listMicrosoftAccounts: () => [{ id: 'agent-acct', kind: 'agent', email: 'agent@example.com', connected: true }] }));
vi.mock('../activity-log.js', () => ({ logMicrosoftActivity: vi.fn() }));
vi.mock('../graph-fetch.js', () => ({
  GRAPH_BASE: 'https://graph.test/v1.0',
  graphFetch: vi.fn(),
}));

import { graphFetch } from '../graph-fetch.js';
import { executeOfficeTool } from '../tools-office.js';

const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' }) as unknown as Response;

/** Answers the sheet list, the used range and the file name; everything else is an empty success. */
function mockGraph(firstSheet: string) {
  vi.mocked(graphFetch).mockImplementation((async (_agent: unknown, url: string) => {
    if (url.endsWith('/workbook/worksheets')) return reply({ value: [{ name: firstSheet }] });
    if (url.includes('/usedRange?')) return reply({ rowIndex: 0, rowCount: 2 });
    if (url.includes('?$select=name,parentReference')) return reply({ name: 'book.xlsx' });
    return reply({ values: [] });
  }) as never);
}

/** Every URL the tool asked Graph for, bar the sheet list and the file-name lookup. */
const sheetUrls = () =>
  vi.mocked(graphFetch).mock.calls
    .map(c => String(c[1]))
    .filter(u => u.includes('worksheets(') || u.includes('worksheets/$'));

beforeEach(() => {
  vi.mocked(graphFetch).mockReset();
});

const NAMED = "worksheets('Bob''s%20Sheet')";

describe('a sheet name with an apostrophe — the apostrophe is written twice', () => {
  it('office_get_spreadsheet_range, named sheet', async () => {
    mockGraph('Other');
    await executeOfficeTool('office_get_spreadsheet_range', { file_id: 'f1', sheet_name: "Bob's Sheet", range: 'A1:B2' }, 'a1', 'Agent');
    expect(sheetUrls()).toEqual([`https://graph.test/v1.0/me/drive/items/f1/workbook/${NAMED}/range(address='A1%3AB2')`]);
  });

  it('office_get_spreadsheet_range, named sheet and no range', async () => {
    mockGraph('Other');
    await executeOfficeTool('office_get_spreadsheet_range', { file_id: 'f1', sheet_name: "Bob's Sheet" }, 'a1', 'Agent');
    expect(sheetUrls()).toEqual([`https://graph.test/v1.0/me/drive/items/f1/workbook/${NAMED}/usedRange`]);
  });

  it('office_get_spreadsheet_range, first sheet has the apostrophe', async () => {
    mockGraph("Bob's Sheet");
    await executeOfficeTool('office_get_spreadsheet_range', { file_id: 'f1', range: 'A1' }, 'a1', 'Agent');
    expect(sheetUrls()).toEqual([`https://graph.test/v1.0/me/drive/items/f1/workbook/${NAMED}/range(address='A1')`]);
  });

  it('office_get_spreadsheet_range, first sheet has the apostrophe and no range', async () => {
    mockGraph("Bob's Sheet");
    await executeOfficeTool('office_get_spreadsheet_range', { file_id: 'f1' }, 'a1', 'Agent');
    expect(sheetUrls()).toEqual([`https://graph.test/v1.0/me/drive/items/f1/workbook/${NAMED}/usedRange`]);
  });

  it('office_write_spreadsheet_range, named sheet', async () => {
    mockGraph('Other');
    await executeOfficeTool('office_write_spreadsheet_range', { file_id: 'f1', sheet_name: "Bob's Sheet", range: 'A1', values: [['x']] }, 'a1', 'Agent');
    expect(sheetUrls()).toEqual([`https://graph.test/v1.0/me/drive/items/f1/workbook/${NAMED}/range(address='A1')`]);
  });

  it('office_write_spreadsheet_range, first sheet has the apostrophe', async () => {
    mockGraph("Bob's Sheet");
    await executeOfficeTool('office_write_spreadsheet_range', { file_id: 'f1', range: 'A1', values: [['x']] }, 'a1', 'Agent');
    expect(sheetUrls()).toEqual([`https://graph.test/v1.0/me/drive/items/f1/workbook/${NAMED}/range(address='A1')`]);
  });

  it('office_append_spreadsheet_rows, named sheet', async () => {
    mockGraph('Other');
    await executeOfficeTool('office_append_spreadsheet_rows', { file_id: 'f1', sheet_name: "Bob's Sheet", rows: [['x']] }, 'a1', 'Agent');
    expect(sheetUrls()).toEqual([
      `https://graph.test/v1.0/me/drive/items/f1/workbook/${NAMED}/usedRange?$select=address,rowCount,columnCount`,
      `https://graph.test/v1.0/me/drive/items/f1/workbook/${NAMED}/range(address='A3%3AA3')`,
    ]);
  });

  it('office_append_spreadsheet_rows, first sheet has the apostrophe', async () => {
    mockGraph("Bob's Sheet");
    await executeOfficeTool('office_append_spreadsheet_rows', { file_id: 'f1', rows: [['x']] }, 'a1', 'Agent');
    expect(sheetUrls()).toEqual([
      `https://graph.test/v1.0/me/drive/items/f1/workbook/${NAMED}/usedRange?$select=address,rowCount,columnCount`,
      `https://graph.test/v1.0/me/drive/items/f1/workbook/${NAMED}/range(address='A3%3AA3')`,
    ]);
  });

  it('office_delete_sheet', async () => {
    mockGraph('Other');
    await executeOfficeTool('office_delete_sheet', { file_id: 'f1', sheet_name: "Bob's Sheet" }, 'a1', 'Agent');
    expect(sheetUrls()).toEqual([`https://graph.test/v1.0/me/drive/items/f1/workbook/${NAMED}`]);
  });
});

describe('a sheet name without an apostrophe — the request is unchanged', () => {
  it('reads, writes, appends and deletes as before', async () => {
    mockGraph('My Data');
    await executeOfficeTool('office_get_spreadsheet_range', { file_id: 'f1', range: 'A1' }, 'a1', 'Agent');
    await executeOfficeTool('office_write_spreadsheet_range', { file_id: 'f1', sheet_name: 'Plain', range: 'A1', values: [['x']] }, 'a1', 'Agent');
    await executeOfficeTool('office_delete_sheet', { file_id: 'f1', sheet_name: 'Plain' }, 'a1', 'Agent');
    expect(sheetUrls()).toEqual([
      "https://graph.test/v1.0/me/drive/items/f1/workbook/worksheets('My%20Data')/range(address='A1')",
      "https://graph.test/v1.0/me/drive/items/f1/workbook/worksheets('Plain')/range(address='A1')",
      "https://graph.test/v1.0/me/drive/items/f1/workbook/worksheets('Plain')",
    ]);
  });
});
