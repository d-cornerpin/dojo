// v3.5 DONE IS MEASURED: a task's MEASURE — a read the engine can replay and count, so "how much
// is left" is a number the engine holds, not a claim the model makes.
//
// The registry maps each countable read tool to its counter. Adding a provider (an Outlook search,
// say) is one entry here plus one counter file beside that provider's client.
// The counter is loaded when a count is made, never at import: a static import here put this module on a
// cycle (google/client → … → the runtime → tracker/pm-agent → back here), so any module of the PM's graph that
// read a measure's words saw a half-loaded registry, and a test seam on `countMeasure` stopped being reached.
const gmail = async (): Promise<typeof import('../google/measure-count.js')> => import('../google/measure-count.js');

export interface Measure { tool: 'gmail_search' | 'user_gmail_search'; args: { query: string; account?: string }; unit: string }
export type MeasureCount = { ok: true; count: number } | { ok: false; error: string };
type Counter = (m: Measure, agentId: string, agentName: string) => Promise<MeasureCount>;

const COUNTERS: Record<Measure['tool'], Counter> = {
  gmail_search: async (m, agentId, agentName) => (await gmail()).countGmailSearch(m.args, agentId, agentName, 'agent'),
  user_gmail_search: async (m, agentId, agentName) => (await gmail()).countGmailSearch(m.args, agentId, agentName, 'user'),
};

/** Every tool the engine can count, for readers that must size a line around the longest name. */
export const MEASURE_TOOLS = Object.keys(COUNTERS) as Array<Measure['tool']>;

export function parseMeasure(raw: unknown): { ok: true; measure: Measure } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'measure must be an object {tool, args, unit}' };
  const o = raw as Record<string, unknown>;
  const tool = typeof o.tool === 'string' ? o.tool : '';
  if (!Object.hasOwn(COUNTERS, tool)) return { ok: false, error: `measure.tool "${tool || '(none)'}" cannot be counted by the engine; supported: ${Object.keys(COUNTERS).join(', ')}` };
  const args = (o.args && typeof o.args === 'object' ? o.args : {}) as Record<string, unknown>;
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { ok: false, error: 'measure.args.query must be the search that lists what is STILL to do (it must shrink as you work, e.g. "in:inbox -label:Done")' };
  const account = typeof args.account === 'string' && args.account ? args.account : undefined;
  const unit = typeof o.unit === 'string' && o.unit.trim() ? o.unit.trim() : 'items';
  return { ok: true, measure: { tool: tool as Measure['tool'], args: { query, ...(account ? { account } : {}) }, unit } };
}

/** Never throws: a counter that fails is a reading that could not be made, and says why. */
export async function countMeasure(m: Measure, agentId: string, agentName: string): Promise<MeasureCount> {
  try {
    return await COUNTERS[m.tool](m, agentId, agentName);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function describeMeasure(m: Measure): string {
  return `${m.tool} "${m.args.query}"`;
}
