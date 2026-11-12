// Matches a commitment claim to open board work, so a status of listed work is not read as a new promise.
import { getDb } from '../../db/connection.js';

/** Words of 6+ letters or digits outside ORDINARY, by stem; a claim names a row when they share one. */
const ORDINARY = new Set(['commitment', 'commitments', 'promise', 'tomorrow', 'reminder', 'follow', 'followup', 'tracker', 'recorded', 'logged', 'tracked', 'added', 'before', 'after', 'there', 'their', 'these', 'those', 'about', 'should', 'would', 'could', 'still', 'items', 'today']);
function distinctiveWords(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]{6,}/g) ?? []).filter((w) => !ORDINARY.has(w)).map(stem));
}

// A word and its English plural reduce to the same stem, so the match is plural-blind.
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

/** Titles of this agent's board work opened before this turn and still open; a failed read returns none. */
export function openBoardTitlesBefore(agentId: string, sinceMs: number): readonly string[] {
  try {
    return (getDb().prepare(
      `SELECT title FROM work WHERE agent_id = ? AND opened_at < ? AND kind IN ('commitment','task','project')
         AND state NOT IN ('done','abandoned','failed') AND title IS NOT NULL`,
    ).all(agentId, sinceMs) as Array<{ title: string }>).map((r) => r.title);
  } catch { return []; }
}

