// THE OWNER'S CARDS FOR AN AGENT'S OWN TROUBLE, and the records that are their truth (`healer/owner-notice-kinds.ts`):
//   paused after repeated errors (`paused:<id>`): the error loop's latest open `paused` row while the agent is paused;
//     `owner_card_closed_at` is stamped when the agent leaves `paused` by any road, so the trip is over;
//   rate-limit retries exhausted (`ratelimit:<id>`): `agents.rate_limit_notice` while the agent stays rate limited;
//   broken and silent (`broken:<id>`, `silent:<id>`): `agents.broken_notice` / `silent_notice`, cleared by the
//     condition's own end. The record IS the incident: the text goes once, when it is first written.
// "Leaves" is observed at the one status writer (`agent-status.ts` calls `agentStatusMoved`).

import { endJobCarry } from '../work/task-freshness.js';
import { getDb } from '../db/connection.js';
import { ownerConditionCleared, ownerConditionsOnAgentGone, tellOwner } from '../healer/owner-notices.js';
import { formatErrorForHuman, type ErrorKind } from './v2/error-format.js';

type Notice = { at: number; words: string; since?: number };
/** The three per-agent incident records an owner text writes (193, 191). */
export type NoticeColumn = 'rate_limit_notice' | 'broken_notice' | 'silent_notice';
const KIND: Record<NoticeColumn, string> = { rate_limit_notice: 'ratelimit', broken_notice: 'broken', silent_notice: 'silent' };

const nameOf = (agentId: string): string => {
  try {
    return (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined)?.name ?? agentId;
  } catch { return agentId; /* the id is still a name the owner can find */ }
};

/** The words of a trip: the text, the owner card and the agent's own chat card all carry them. */
export function pausedWords(agentId: string): string {
  return `${nameOf(agentId)} has been paused after repeated errors. Open the Vitals page to investigate, or resume it from its detail page.`;
}

/** The trip is over: its open rows are closed and its card leaves. Never throws: it runs on every status move. */
export function closePausedCards(agentId: string): void {
  try {
    const closed = getDb().prepare(`UPDATE error_loop_state SET owner_card_closed_at = ?
      WHERE agent_id = ? AND kind = 'paused' AND owner_card_closed_at IS NULL`).run(Date.now(), agentId).changes;
    if (closed > 0) ownerConditionCleared(`paused:${agentId}`);
  } catch { /* a card left open is shown once more, never a failed status write */ }
}

/** The incident this column records for the agent, or null. */
export function readNotice(agentId: string, col: NoticeColumn): Notice | null {
  try {
    const row = getDb().prepare(`SELECT ${col} AS raw FROM agents WHERE id = ?`).get(agentId) as { raw: string | null } | undefined;
    return row?.raw ? JSON.parse(row.raw) as Notice : null;
  } catch { return null; }
}

/** Record the incident, unless one already stands: true exactly when the owner has NOT yet been
 *  told about it (the caller texts then). An unreadable record tells him rather than stay silent. */
export function noteNoticeOnce(agentId: string, col: NoticeColumn, words: string, since?: number): boolean {
  let changed = true;
  try {
    changed = getDb().prepare(`UPDATE agents SET ${col} = ? WHERE id = ? AND ${col} IS NULL`)
      .run(JSON.stringify({ at: Date.now(), words, ...(since !== undefined ? { since } : {}) }), agentId).changes === 1;
  } catch { /* an unreadable record tells him rather than stay silent */ }
  if (changed) tellOwner(`${KIND[col]}:${agentId}`, words);
  return changed;
}

/** Retries exhausted and the owner is being told: the record and its card. Returns the words. */
export function noteRateLimitExhausted(agentId: string, words: string): string {
  try {
    getDb().prepare('UPDATE agents SET rate_limit_notice = ? WHERE id = ?').run(JSON.stringify({ at: Date.now(), words }), agentId);
  } catch { /* the text still goes */ }
  tellOwner(`ratelimit:${agentId}`, words);
  return words;
}

/** The incident is over: forget it, and its card leaves every open dashboard. */
export function endNotice(agentId: string, col: NoticeColumn): void {
  try {
    if (!readNotice(agentId, col)) return;
    getDb().prepare(`UPDATE agents SET ${col} = NULL WHERE id = ?`).run(agentId);
    ownerConditionCleared(`${KIND[col]}:${agentId}`);
  } catch { /* best-effort, as above */ }
}

/** The Tier D platform kinds (`agent/v2/classifiers/provider.ts`), as `recovery.ts` tags them on
 *  the injury it hands the Healer and on `agents.last_error`: `[<kind>] …`. */
const BROKEN_TAG = /^\[(auth_invalid|access_denied|quota_exhausted|dns_failure)\]/;

/** BROKEN (t143): the words for an injury only the owner can fix, or null for any other injury.
 *  Composed from the kind and the agent's own names, never from the provider's raw text. */
export function brokenWords(agentId: string, injury: string): string | null {
  const kind = BROKEN_TAG.exec(injury)?.[1] as ErrorKind | undefined;
  if (!kind) return null;
  let names: { agent: string; provider: string | null } = { agent: agentId, provider: null };
  try {
    const r = getDb().prepare(`SELECT a.name AS agent, p.name AS provider FROM agents a
      LEFT JOIN models m ON m.id = a.model_id LEFT JOIN providers p ON p.id = m.provider_id WHERE a.id = ?`)
      .get(agentId) as { agent: string; provider: string | null } | undefined;
    if (r) names = r;
  } catch { /* the id is still a name the owner can find */ }
  const words = formatErrorForHuman(kind, { agentName: names.agent, providerName: names.provider ?? undefined });
  return words.includes(names.agent) ? words : `${names.agent} has stopped: ${words}`;
}

/** The one status writer moved this agent: an incident whose status it left is over, and a
 *  terminated agent is the subject of nothing any more (t138 r6, review I3; t143 BROKEN/SILENT). */
export function agentStatusMoved(agentId: string, status: string): void {
  if (['error', 'paused', 'rate_limited', 'terminated'].includes(status)) endJobCarry(agentId); // t143 r6: its job's chain is over
  if (status !== 'paused') closePausedCards(agentId);
  if (status !== 'rate_limited') endNotice(agentId, 'rate_limit_notice');
  if (status === 'terminated') {
    ownerConditionsOnAgentGone(agentId);
    endNotice(agentId, 'broken_notice');
    endNotice(agentId, 'silent_notice');
  }
}

/** The purge door is about to delete this agent: every card it is the subject of ends, live,
 *  while its name can still be read (never a raw id on a card). */
export function agentPurgedForOwner(agentId: string): void {
  agentStatusMoved(agentId, 'terminated');
}
