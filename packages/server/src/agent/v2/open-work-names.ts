// t179 — does a "it's on my list" claim name work ALREADY open on the agent's board? Used by the
// uncommitted-promise floor (recorded-commitment.ts) so a STATUS of listed work is not read as a new,
// unrecorded promise (Run 15 S2: "You there?" forced a duplicate commitment and two silent turns).
import { getDb } from '../../db/connection.js';

/** t179: does the claim name an open row? A shared DISTINCTIVE word (6+ letters or digits, not ordinary
 *  speech) between the claim and a row's title: "the RWNWC0KXA10DEL check" names "Check the handover note
 *  RWNWC0KXA10DEL"; a shared "the", "note" or "list" names nothing. */
const ORDINARY = new Set(['commitment', 'commitments', 'promise', 'tomorrow', 'reminder', 'follow', 'followup', 'tracker', 'recorded', 'logged', 'tracked', 'added', 'before', 'after', 'there', 'their', 'these', 'those', 'about', 'should', 'would', 'could', 'still', 'items', 'today']);
function distinctiveWords(s: string): Set<string> {
  // t182: compared by stem, so "receipt" names a title's "receipts" (Run 16 S2 a2); t24: a word and its
  // plural stem the same, by ordinary English plural rules in `stem`.
  return new Set((s.toLowerCase().match(/[a-z0-9]{6,}/g) ?? []).filter((w) => !ORDINARY.has(w)).map(stem));
}

// t24: a word and its English plural reduce to the same stem, so the match is plural-blind.
function stem(w: string): string {
  if (/(ss|us|is)$/.test(w)) return w;                  // irregular: buses, classes, theses keep their s
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';    // studies → study
  if (/(sses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2); // sibilant 'es' (a -ss/x/z/ch/sh base): processes→process, boxes→box
  return w.replace(/s$/, '');                            // a single trailing 's': invoices→invoice, licenses→license, receipts→receipt
}
export function namesOpenWork(claim: string, titles: readonly string[]): boolean {
  const said = distinctiveWords(claim);
  return said.size > 0 && titles.some((t) => [...distinctiveWords(t)].some((w) => said.has(w)));
}

/** t179: titles of this agent's board work opened BEFORE this turn and still open. A failed read stands down. */
export function openBoardTitlesBefore(agentId: string, sinceMs: number): readonly string[] {
  try {
    return (getDb().prepare(
      `SELECT title FROM work WHERE agent_id = ? AND opened_at < ? AND kind IN ('commitment','task','project')
         AND state NOT IN ('done','abandoned','failed') AND title IS NOT NULL`,
    ).all(agentId, sinceMs) as Array<{ title: string }>).map((r) => r.title);
  } catch { return []; }
}

