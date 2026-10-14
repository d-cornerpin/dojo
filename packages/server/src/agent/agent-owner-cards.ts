// ════════════════════════════════════════════════════════════════════════════════════════
// THE OWNER'S CARDS FOR AN AGENT'S OWN TROUBLE (t138 rounds 3-4, ruling R-V333-13).
//
// Two agent conditions are texted to the owner and wait on his dashboard until he dismisses
// them, re-derived on every load from the agent's own rows — no new store:
//
//   PAUSED AFTER REPEATED ERRORS — the error loop's latest `paused` row (`error_loop_state`)
//   for an agent still `paused`. `owner_card_closed_at` (migration 193) is stamped when he
//   dismisses it or when the agent leaves `paused` by ANY road (a clean turn, a manual resume):
//   the incident is over, so a later manual pause cannot bring the card back. A new trip is a
//   new row, so a new card.
//
//   RATE-LIMIT RETRIES EXHAUSTED — `agents.rate_limit_notice` (193) holds `{ at, words,
//   dismissedAt? }` while the agent stays `rate_limited`; it is cleared when it leaves.
//
//   BROKEN and SILENT (t143, migration 191) — `agents.broken_notice` / `agents.silent_notice`,
//   the same shape. The record IS the incident: the text goes once, when it is first written;
//   the card stands while it stands; it is cleared by the condition's own end (BROKEN: the next
//   healthy turn, `clearErrors`; SILENT: the agent moving again, `tracker/liveness.ts`) or by
//   the agent being terminated or purged.
//
// "Leaves" is observed at the one status writer (`agent-status.ts` calls `agentStatusMoved`),
// so every road out is seen, and the card leaves every open dashboard at that moment
// (`services/owner-card-frames.ts`, the frame path the all-clears use).
// ════════════════════════════════════════════════════════════════════════════════════════

import { endJobCarry } from '../work/task-freshness.js';
import { getDb } from '../db/connection.js';
import { ownerCardEnded } from '../services/owner-card-frames.js';
import { ownerConditionsOnAgentGone } from '../healer/owner-notices.js';
import { formatErrorForHuman, type ErrorKind } from './v2/error-format.js';

type Notice = { at: number; words: string; dismissedAt?: number; since?: number };
/** The three per-agent incident records an owner text writes (193, 191). */
export type NoticeColumn = 'rate_limit_notice' | 'broken_notice' | 'silent_notice';
type Card = { words: string; severity: 'critical' | 'notice'; dismiss: () => void };

const nameOf = (agentId: string): string => {
  try {
    return (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined)?.name ?? agentId;
  } catch { return agentId; /* the id is still a name the owner can find */ }
};

/** The words of a trip: the text, the owner card and the agent's own chat card all carry them. */
export function pausedWords(agentId: string): string {
  return `${nameOf(agentId)} has been paused after repeated errors. Open the Vitals page to investigate, or resume it from its detail page.`;
}

/** End the owner's card for this agent's trip (one row, or every open one). Never throws: it
 *  runs on every status move. `announce` sends the removal frame (not for a dismissal). */
export function closePausedCards(agentId: string, rowId?: number, announce = true): void {
  try {
    const db = getDb();
    const open = db.prepare(`SELECT id FROM error_loop_state
      WHERE agent_id = ? AND kind = 'paused' AND owner_card_closed_at IS NULL AND (? IS NULL OR id = ?)`)
      .all(agentId, rowId ?? null, rowId ?? null) as Array<{ id: number }>;
    if (open.length === 0) return;
    db.prepare(`UPDATE error_loop_state SET owner_card_closed_at = ?
      WHERE agent_id = ? AND kind = 'paused' AND owner_card_closed_at IS NULL AND (? IS NULL OR id = ?)`)
      .run(Date.now(), agentId, rowId ?? null, rowId ?? null);
    if (announce) ownerCardEnded(pausedWords(agentId));
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
  try {
    const changed = getDb().prepare(`UPDATE agents SET ${col} = ? WHERE id = ? AND ${col} IS NULL`)
      .run(JSON.stringify({ at: Date.now(), words, ...(since !== undefined ? { since } : {}) }), agentId).changes;
    return changed === 1;
  } catch { return true; }
}

/** Retries exhausted and the owner is being told: keep the words for his card. Returns them. */
export function noteRateLimitExhausted(agentId: string, words: string): string {
  try {
    getDb().prepare('UPDATE agents SET rate_limit_notice = ? WHERE id = ?').run(JSON.stringify({ at: Date.now(), words }), agentId);
  } catch { /* the text still goes; only the lasting card is lost */ }
  return words;
}

/** The incident is over: forget it, and its card leaves every open dashboard. */
export function endNotice(agentId: string, col: NoticeColumn): void {
  try {
    const notice = readNotice(agentId, col);
    if (!notice) return;
    getDb().prepare(`UPDATE agents SET ${col} = NULL WHERE id = ?`).run(agentId);
    ownerCardEnded(notice.words);
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

/** The agent owner cards a dashboard shows on load. */
export function agentOwnerCards(): Card[] {
  const db = getDb();
  const paused = db.prepare(`SELECT e.id, e.agent_id AS agentId FROM error_loop_state e
    JOIN agents a ON a.id = e.agent_id
    WHERE e.kind = 'paused' AND a.status = 'paused' AND e.owner_card_closed_at IS NULL
      AND e.at_ms = (SELECT MAX(at_ms) FROM error_loop_state WHERE agent_id = e.agent_id AND kind = 'paused')`)
    .all() as Array<{ id: number; agentId: string }>;
  // Rate-limit: while the agent is still `rate_limited`. BROKEN / SILENT: while the record stands
  // (each is cleared by its own end, above and in `tracker/liveness.ts`).
  const standing = (col: NoticeColumn, severity: Card['severity'], where = ''): Card[] =>
    (db.prepare(`SELECT id, ${col} AS raw FROM agents WHERE ${col} IS NOT NULL ${where}`).all() as Array<{ id: string; raw: string }>)
      .flatMap((r): Card[] => {
        let notice: Notice;
        try { notice = JSON.parse(r.raw) as Notice; } catch { return []; }
        if (notice.dismissedAt !== undefined) return [];
        const dismiss = (): void => {
          db.prepare(`UPDATE agents SET ${col} = ? WHERE id = ?`).run(JSON.stringify({ ...notice, dismissedAt: Date.now() }), r.id);
        };
        return [{ words: notice.words, severity, dismiss }];
      });
  return [
    ...paused.map((r): Card => ({
      words: pausedWords(r.agentId), severity: 'notice', dismiss: () => closePausedCards(r.agentId, r.id, false),
    })),
    ...standing('rate_limit_notice', 'critical', "AND status = 'rate_limited'"),
    ...standing('broken_notice', 'notice', "AND status != 'terminated'"),
    ...standing('silent_notice', 'notice', "AND status != 'terminated'"),
  ];
}
