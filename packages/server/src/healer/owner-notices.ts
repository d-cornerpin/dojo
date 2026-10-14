// ════════════════════════════════════════════════════════════════════════════════════════
// WHAT THE OWNER WAS TOLD ABOUT THE HEALER'S CASES, AND WHETHER IT STILL STANDS (t138 round 3).
//
// Three owner texts come from `injury-recovery.ts`: an agent auto-recovery gave up on ("stuck"),
// the Healer itself broken, and an agent stuck while the Healer is missing. Owner ruling
// (2026-10-13): no hard limits — "the Dojo should be smart enough to know when enough is
// enough". So each texts ONCE when its condition starts and again only after it genuinely
// cleared and came back; and (ruling R-V333-13) the same words wait on his dashboard until he
// dismisses them, re-derived from this state on every load.
//
// No new store: the Healer's own durable `healer_state (scope, key, at_ms)` table, which already
// holds its damping (scopes 'agent_suppression', 'provider_alert'), gains two scope VALUES:
//   'owner_told'      key = the condition, at_ms = when the owner was told;
//   'owner_dismissed' key = the same condition, at_ms = when he dismissed its card.
// A condition's rows are deleted when it clears; telling it again starts fresh.
//
// Conditions: `stuck:<agentId>` (clears on that agent's recovery), `healer-broken` (clears when
// the Healer recovers, or is seen healthy at the next injury of another agent), and
// `healer-missing:<agentId>` (one at a time, whichever agent found it missing first; clears
// when an injury finds the Healer present again), and (t148 round 3) `nofit:<agentId>` (an agent
// parked because none of its models can hold it; ends when the agent is released).
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { ownerCardEnded } from '../services/owner-card-frames.js';

const TOLD = 'owner_told';
const DISMISSED = 'owner_dismissed';

/** The words of each text; the owner card carries the same ones. */
export const HEALER_BROKEN_WORDS = `The Healer agent is broken and can't auto-fix itself. Open the Healer's detail page to investigate, or restart it from Settings.`;
export const stuckWords = (name: string): string =>
  `${name} has been stuck for a few tries and auto-recovery isn't unsticking it. I'll keep trying in the background. You can also send a message or reset its session from the detail page.`;
/** t148 round 3: an agent parked because none of its models can hold it is a broken agent the owner
 *  must act on (OR-V333-SET (3)); the condition is `nofit:<agentId>` and ends when the agent is released. */
export const noFitWords = (name: string): string =>
  `${name} can't run: none of its models can hold its instructions and tools. Pick a bigger model for it on its detail page, or give it fewer tools, and it will answer your message.`;
export const healerMissingWords = (name: string): string =>
  `${name} is stuck and the Healer agent is missing. Restore the Healer in Settings → Sensei, or send a message to unstick the agent manually.`;

/**
 * True exactly when the owner has NOT yet been told about this condition — its own `key`, or,
 * for a condition one agent stands for (`healer-missing:`), any key under `family` — and
 * records that he is being told now.
 */
export function tellOwnerOnce(key: string, family?: string): boolean {
  try {
    return recordTold(key, family);
  } catch {
    return true; // the record could not be read or written: tell him rather than stay silent
  }
}

function recordTold(key: string, family?: string): boolean {
  const db = getDb();
  const told = db.prepare(`SELECT 1 FROM healer_state WHERE scope = ? AND (key = ? OR (? IS NOT NULL AND key LIKE ? || '%'))`)
    .get(TOLD, key, family ?? null, family ?? null);
  if (told) return false;
  db.prepare(`INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)
              ON CONFLICT(scope, key) DO UPDATE SET at_ms = excluded.at_ms, updated_at = datetime('now')`)
    .run(TOLD, key, Date.now());
  db.prepare('DELETE FROM healer_state WHERE scope = ? AND key = ?').run(DISMISSED, key);
  return true;
}

/** The words a condition's card carries, from its key. */
export function wordsOf(key: string): string {
  const [kind, agentId = ''] = key.split(/:(.*)/s);
  const nameOf = (id: string): string =>
    (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id;
  return kind === 'stuck' ? stuckWords(nameOf(agentId))
    : kind === 'nofit' ? noFitWords(nameOf(agentId))
    : kind === 'healer-missing' ? healerMissingWords(nameOf(agentId)) : HEALER_BROKEN_WORDS;
}

/** The condition cleared (its `key`, or every key under `family`): forget he was told and
 *  dismissed, and its card leaves every open dashboard now (round 4). */
export function ownerConditionCleared(key: string, family = false): void {
  try {
    const db = getDb();
    const told = db.prepare(`SELECT key FROM healer_state WHERE scope = ? AND (key = ? OR (? AND key LIKE ? || '%'))`)
      .all(TOLD, key, family ? 1 : 0, key) as Array<{ key: string }>;
    if (told.length === 0) return;
    const words = told.map((t) => wordsOf(t.key));
    db.prepare(`DELETE FROM healer_state WHERE scope IN (?, ?) AND (key = ? OR (? AND key LIKE ? || '%'))`)
      .run(TOLD, DISMISSED, key, family ? 1 : 0, key);
    for (const w of words) ownerCardEnded(w);
  } catch { /* best-effort, like the Healer's own damping: never block recovery */ }
}

/** An agent recovered ON EVIDENCE (the caller passes only `basis === 'evidence'`; a clock is
 *  never evidence, t114 U1 / review I2): its "stuck" condition is over. "Healer broken" is not
 *  ended here: a watchdog reset calls recovery too, and a reset is not the Healer working (I1). */
export function ownerConditionsOnRecovery(agentId: string): void {
  ownerConditionCleared(`stuck:${agentId}`);
}

/** The agent completed a healthy model turn (`clearErrors`, the clean-turn signal): if it is
 *  the Healer, it works again, and that alone ends "Healer broken" (review I1). */
export function ownerConditionsOnHealthyWork(agentId: string): void {
  try {
    const healer = getDb().prepare("SELECT value FROM config WHERE key = 'healer_agent_id'").get() as { value: string } | undefined;
    if (healer?.value === agentId) ownerConditionCleared('healer-broken');
  } catch { /* best-effort */ }
}

/** The Healer's row was looked at — by an injury of another agent, or by its own five-minute
 *  self-watchdog: present (and not terminated) is the very record of "missing" ending. Its
 *  status says nothing about "broken" (a reset sets it idle). `null` = no row at all. */
export function ownerConditionsOnHealerSeen(healerStatus: string | null): void {
  if (healerStatus === null || healerStatus === 'terminated') return;
  ownerConditionCleared('healer-missing:', true);
}

/** The agent is gone (terminated or purged): the conditions it is the subject of end (I3). */
export function ownerConditionsOnAgentGone(agentId: string): void {
  ownerConditionCleared(`stuck:${agentId}`);
  ownerConditionCleared(`healer-missing:${agentId}`);
  ownerConditionCleared(`nofit:${agentId}`);
}

/** The Healer's owner cards a dashboard shows on load: told, still standing, not dismissed. */
export function healerOwnerCards(): Array<{ words: string; severity: 'critical' | 'notice'; dismiss: () => void }> {
  const db = getDb();
  const rows = db.prepare(`SELECT t.key FROM healer_state t WHERE t.scope = ?
    AND NOT EXISTS (SELECT 1 FROM healer_state d WHERE d.scope = ? AND d.key = t.key)`).all(TOLD, DISMISSED) as Array<{ key: string }>;
  const live = (id: string, parked: boolean): boolean =>
    !!db.prepare(`SELECT 1 FROM agents WHERE id = ? AND status != 'terminated'
      AND (? = 0 OR (status = 'paused' AND instr(COALESCE(last_error, ''), '[no_model_fits]') = 1))`).get(id, parked ? 1 : 0);
  return rows.filter(({ key }) => !key.includes(':') || live(key.split(/:(.*)/s)[1] ?? '', key.startsWith('nofit:'))).map(({ key }) => {
    return {
      words: wordsOf(key),
      severity: key.startsWith('stuck:') || key.startsWith('nofit:') ? 'notice' as const : 'critical' as const,
      dismiss: () => {
        db.prepare(`INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)
                    ON CONFLICT(scope, key) DO UPDATE SET at_ms = excluded.at_ms, updated_at = datetime('now')`)
          .run(DISMISSED, key, Date.now());
      },
    };
  });
}
