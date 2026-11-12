// A task's MEASURE: a read the engine can replay and count, so "how much is left" is a number the engine holds.
// Each counter is loaded when a count is made, never at import: a static import put this module on a cycle
// (google/client, runtime, tracker/pm-agent) that left the registry half-loaded.
const gmail = async (): Promise<typeof import('../google/measure-count.js')> => import('../google/measure-count.js');
const outlook = async (): Promise<typeof import('../microsoft/measure-count.js')> => import('../microsoft/measure-count.js');
const files = async (): Promise<typeof import('../tools/file-set-count.js')> => import('../tools/file-set-count.js');

export type MeasureTool = 'gmail_search' | 'user_gmail_search' | 'outlook_search' | 'user_outlook_search' | 'file_list';
/** A mailbox measure carries `query` (and optionally `account`); a file-set measure carries `path` and `pattern`. */
export interface Measure { tool: MeasureTool; args: { query?: string; account?: string; path?: string; pattern?: string }; unit: string }
/** `unreadable`: folders a file-set count could not read (named, never silently dropped). */
export type MeasureCount = { ok: true; count: number; unreadable?: string[] } | { ok: false; error: string };
type Counter = (m: Measure, agentId: string, agentName: string) => Promise<MeasureCount>;

const COUNTERS: Record<MeasureTool, Counter> = {
  gmail_search: async (m, agentId, agentName) => (await gmail()).countGmailSearch({ query: m.args.query ?? '', account: m.args.account }, agentId, agentName, 'agent'),
  user_gmail_search: async (m, agentId, agentName) => (await gmail()).countGmailSearch({ query: m.args.query ?? '', account: m.args.account }, agentId, agentName, 'user'),
  outlook_search: async (m, agentId, agentName) => (await outlook()).countOutlookSearch(m.args, agentId, agentName, 'agent'),
  user_outlook_search: async (m, agentId, agentName) => (await outlook()).countOutlookSearch(m.args, agentId, agentName, 'user'),
  file_list: async (m, agentId) => (await files()).countFileSet(m.args, agentId),
};

/** Every tool the engine can count, for readers that must size a line around the longest name. */
export const MEASURE_TOOLS = Object.keys(COUNTERS) as MeasureTool[];

const isFileMeasure = (tool: MeasureTool): boolean => tool === 'file_list';

export function parseMeasure(raw: unknown): { ok: true; measure: Measure } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'measure must be an object {tool, args, unit}' };
  const o = raw as Record<string, unknown>;
  const tool = typeof o.tool === 'string' ? o.tool : '';
  if (!Object.hasOwn(COUNTERS, tool)) return { ok: false, error: `measure.tool "${tool || '(none)'}" cannot be counted by the engine; supported: ${MEASURE_TOOLS.join(', ')}` };
  const args = (o.args && typeof o.args === 'object' ? o.args : {}) as Record<string, unknown>;
  const unit = typeof o.unit === 'string' && o.unit.trim() ? o.unit.trim() : (isFileMeasure(tool as MeasureTool) ? 'files' : 'items');
  if (isFileMeasure(tool as MeasureTool)) {
    const p = typeof args.path === 'string' ? args.path.trim() : '';
    if (!p) return { ok: false, error: 'measure.args.path must be the folder whose files are STILL to do (absolute, or ~), with args.pattern the files to count there, e.g. "*.pdf" or "**/*.pdf"' };
    const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? args.pattern.trim() : '*';
    return { ok: true, measure: { tool: tool as MeasureTool, args: { path: p, pattern }, unit } };
  }
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { ok: false, error: 'measure.args.query must be the search that lists what is STILL to do (it must shrink as you work, e.g. "in:inbox -label:Done")' };
  const account = typeof args.account === 'string' && args.account ? args.account : undefined;
  return { ok: true, measure: { tool: tool as MeasureTool, args: { query, ...(account ? { account } : {}) }, unit } };
}

/** Never throws: a counter that fails is a reading that could not be made, and says why. */
export async function countMeasure(m: Measure, agentId: string, agentName: string): Promise<MeasureCount> {
  try {
    return await COUNTERS[m.tool](m, agentId, agentName);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** What the measure counts, as the board prints it: the quoted search, or the pattern and its folder. */
export function measureSubject(m: Measure): string {
  return isFileMeasure(m.tool) ? `"${m.args.pattern ?? '*'}" under ${m.args.path ?? ''}` : `"${m.args.query ?? ''}"`;
}

export function describeMeasure(m: Measure): string {
  return `${m.tool} ${measureSubject(m)}`;
}
