// The OUTLOOK counter behind a task's measure (work/measure.ts): counts every message the agent's own
// outlook_search would match (same account kind, read resolver and search text), ids only, every page.
// A failed page is a reading that could not be made, never a partial count.
import { resolveMicrosoftAccountForRead } from './accounts.js';
import { readAllPages } from './graph-pages.js';
import { escapeGraphSearch } from './tools-read.js';

const PAGE = 1000;

export async function countOutlookSearch(
  args: { query?: string; account?: string },
  agentId: string,
  agentName: string,
  kind: 'agent' | 'user',
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const resolved = resolveMicrosoftAccountForRead(kind, args.account);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const query = String(args.query ?? '');
  const first = `me/messages?$search="${encodeURIComponent(escapeGraphSearch(query))}"&$top=${PAGE}&$select=id`;
  const all = await readAllPages<{ id: string }>(first, agentId, agentName, 'measure_count', { query }, resolved.account.id);
  if (!all.ok) return { ok: false, error: all.error };
  return { ok: true, count: all.value.length };
}
