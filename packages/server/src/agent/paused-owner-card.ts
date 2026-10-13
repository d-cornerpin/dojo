import { getDb } from '../db/connection.js';

// ── THE OWNER'S CARD FOR AN ERROR-LOOP TRIP (t138 round 3, ruling R-V333-13) ──
//
// The owner is texted once per trip, and the same words wait on his dashboard until he
// dismisses them. The card is re-derived from `error_loop_state`, not stored anywhere new: an
// agent still paused whose latest trip's card is not closed. `owner_card_closed_at` (migration
// 193) is stamped when he dismisses it or when the agent finishes a clean turn; a new trip is a
// new row, so a new card. `errors.ts` closes it on a clean turn (`clearErrors`).

/** The words of the trip: the text, the owner card and the agent's own chat card all carry them. */
export function pausedWords(agentId: string): string {
  let name = agentId;
  try {
    name = (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined)?.name ?? agentId;
  } catch { /* the id is still a name the owner can find */ }
  return `${name} has been paused after repeated errors. Open the Vitals page to investigate, or resume it from its detail page.`;
}

/** End the owner's card for this agent's trip (one row, or every open one). Never throws: it
 *  runs on every clean turn. */
export function closePausedCards(agentId: string, rowId?: number): void {
  try {
    getDb().prepare(`UPDATE error_loop_state SET owner_card_closed_at = ?
      WHERE agent_id = ? AND kind = 'paused' AND owner_card_closed_at IS NULL AND (? IS NULL OR id = ?)`)
      .run(Date.now(), agentId, rowId ?? null, rowId ?? null);
  } catch { /* a card left open is shown once more, never a failed turn */ }
}

/** The paused-agent owner cards a dashboard shows on load. */
export function pausedAgentOwnerCards(): Array<{ words: string; severity: 'notice'; dismiss: () => void }> {
  const rows = getDb().prepare(`SELECT e.id, e.agent_id AS agentId FROM error_loop_state e
    JOIN agents a ON a.id = e.agent_id
    WHERE e.kind = 'paused' AND a.status = 'paused' AND e.owner_card_closed_at IS NULL
      AND e.at_ms = (SELECT MAX(at_ms) FROM error_loop_state WHERE agent_id = e.agent_id AND kind = 'paused')`)
    .all() as Array<{ id: number; agentId: string }>;
  return rows.map((r) => ({
    words: pausedWords(r.agentId), severity: 'notice' as const, dismiss: () => closePausedCards(r.agentId, r.id),
  }));
}
