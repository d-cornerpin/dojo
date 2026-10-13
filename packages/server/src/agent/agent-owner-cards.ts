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
// "Leaves" is observed at the one status writer (`agent-status.ts` calls `agentStatusMoved`),
// so every road out is seen, and the card leaves every open dashboard at that moment
// (`services/owner-card-frames.ts`, the frame path the all-clears use).
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { ownerCardEnded } from '../services/owner-card-frames.js';

type Notice = { at: number; words: string; dismissedAt?: number };
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

/** Retries exhausted and the owner is being told: keep the words for his card. Returns them. */
export function noteRateLimitExhausted(agentId: string, words: string): string {
  try {
    getDb().prepare('UPDATE agents SET rate_limit_notice = ? WHERE id = ?').run(JSON.stringify({ at: Date.now(), words }), agentId);
  } catch { /* the text still goes; only the lasting card is lost */ }
  return words;
}

function endRateLimitCard(agentId: string): void {
  try {
    const db = getDb();
    const row = db.prepare('SELECT rate_limit_notice AS raw FROM agents WHERE id = ?').get(agentId) as { raw: string | null } | undefined;
    if (!row?.raw) return;
    db.prepare('UPDATE agents SET rate_limit_notice = NULL WHERE id = ?').run(agentId);
    ownerCardEnded((JSON.parse(row.raw) as Notice).words);
  } catch { /* best-effort, as above */ }
}

/** The one status writer moved this agent: an incident whose status it left is over. */
export function agentStatusMoved(agentId: string, status: string): void {
  if (status !== 'paused') closePausedCards(agentId);
  if (status !== 'rate_limited') endRateLimitCard(agentId);
}

/** The agent owner cards a dashboard shows on load. */
export function agentOwnerCards(): Card[] {
  const db = getDb();
  const paused = db.prepare(`SELECT e.id, e.agent_id AS agentId FROM error_loop_state e
    JOIN agents a ON a.id = e.agent_id
    WHERE e.kind = 'paused' AND a.status = 'paused' AND e.owner_card_closed_at IS NULL
      AND e.at_ms = (SELECT MAX(at_ms) FROM error_loop_state WHERE agent_id = e.agent_id AND kind = 'paused')`)
    .all() as Array<{ id: number; agentId: string }>;
  const limited = db.prepare(`SELECT id, rate_limit_notice AS raw FROM agents
    WHERE status = 'rate_limited' AND rate_limit_notice IS NOT NULL`).all() as Array<{ id: string; raw: string }>;
  return [
    ...paused.map((r): Card => ({
      words: pausedWords(r.agentId), severity: 'notice', dismiss: () => closePausedCards(r.agentId, r.id, false),
    })),
    ...limited.flatMap((r): Card[] => {
      let notice: Notice;
      try { notice = JSON.parse(r.raw) as Notice; } catch { return []; }
      if (notice.dismissedAt !== undefined) return [];
      const dismiss = (): void => {
        db.prepare('UPDATE agents SET rate_limit_notice = ? WHERE id = ?').run(JSON.stringify({ ...notice, dismissedAt: Date.now() }), r.id);
      };
      return [{ words: notice.words, severity: 'critical', dismiss }];
    }),
  ];
}
