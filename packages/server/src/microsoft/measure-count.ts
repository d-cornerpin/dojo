// v3.5 field fix 3, audit #5: the OUTLOOK counter behind a task's measure (work/measure.ts).
//
// It reads the mailbox the agent's own `outlook_search` / `user_outlook_search` would read (the same
// account kind and the same read resolver), with the same search text, and counts every message the
// search matches: ids only, every page (`@odata.nextLink`), no per-message fetch. A page that fails is
// a reading that could not be made, never a partial count.
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
