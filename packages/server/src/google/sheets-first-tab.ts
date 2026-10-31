// The range to use when the caller named none: the spreadsheet's first tab. Its name is whatever
// the owner (or their language) made it, so "Sheet1" is only the answer when Google will not say.

import { googleRead } from './client.js';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/** The first tab's title, quoted for A1 notation (each ' doubled); 'Sheet1' on any failure. */
export async function firstTabRange(
  spreadsheetId: string,
  agentId: string,
  agentName: string,
  slot: string,
): Promise<string> {
  try {
    const result = await googleRead(
      `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`,
      agentId, agentName, 'sheets_first_tab', { spreadsheetId }, slot,
    );
    const title = (result.data as { sheets?: Array<{ properties?: { title?: string } }> } | null)?.sheets?.[0]?.properties?.title;
    if (result.ok && typeof title === 'string' && title.length > 0) return `'${title.replace(/'/g, "''")}'`;
  } catch { /* fall through to today's default */ }
  return 'Sheet1';
}
