// THE ONE WRITER OF WHAT THE OWNER IS TOLD ON HIS DASHBOARD. `tellOwner(key, sentence)` takes the card's class and
// severity from the key's kind (`owner-notice-kinds.ts`), de-duplicates on key and words, records the sentence in
// `healer_state` ('owner_told': key, first-told time, sentence; 'owner_dismissed': his X), and pushes the card. A
// notice's rows go when its condition ends; the dashboard's reload list reads the same rows.

import { PLATFORM_SENDER } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';
import { scrubTechnicalDetail } from '../agent/v2/error-format.js';
import { taskMovedAtSql } from '../work/task-freshness.js';
import { holdWordsSql } from '../work/tracker-view.js';
import { renderInstant } from '../memory/message-stamp.js';
import { workingExpr } from '../work/terminal-states.js';
import { STANDARD_MODELS_MISSING_WORDS, uncheckedFitWords, OLLAMA_LIMIT_FAILED_WORDS, OLLAMA_TOO_OLD_WORDS, OLLAMA_DOWN_WORDS } from './local-model-notice-words.js';
import { kindOf } from './owner-notice-kinds.js';
export { STANDARD_MODELS_MISSING_WORDS, uncheckedFitWords, OLLAMA_LIMIT_FAILED_WORDS, OLLAMA_TOO_OLD_WORDS, OLLAMA_DOWN_WORDS };

export const TOLD = 'owner_told';
export const DISMISSED = 'owner_dismissed';

/** What a card asks of the owner: `action` (sticky, stands on reload) or `informational` (a toast that leaves by itself). */
export type OwnerCardClass = 'action' | 'informational';

function frame(words: string, severity: 'error' | 'warning' | 'info', cardKey: string, cardClass?: OwnerCardClass): void {
  try {
    broadcast({ type: 'chat:error', agentId: PLATFORM_SENDER, error: scrubTechnicalDetail(words), severity, retryable: false, cardKey, cardClass: cardClass ?? 'action' });
  } catch { /* a card is best-effort; the record is what matters */ }
}

function push(key: string, words: string): void {
  try { const kind = kindOf(key); frame(words, kind.critical ? 'error' : 'warning', key, kind.cls(key)); } catch { /* best-effort */ }
}

/** Background work the owner need not act on, shown as the orb's task glyph for the agent doing it (no card). */
export function ownerProgressFrame(phase: 'start' | 'end', progressKey: string, agentId: string, label: string): void {
  try {
    broadcast({ type: 'engine:activity', data: { id: progressKey, kind: 'compaction', agentId, label, startedAt: new Date().toISOString(), phase } });
  } catch { /* the glyph is the courtesy; the work runs regardless */ }
}

/** The words of the Healer's cases; their texts and cards carry the same ones. */
export const HEALER_BROKEN_WORDS = `The Healer agent is broken and can't auto-fix itself. Open the Healer's detail page to investigate, or restart it from Settings.`;
export const stuckWords = (name: string): string =>
  `${name} has been stuck for a few tries and auto-recovery isn't unsticking it. The Dojo will keep trying in the background. You can also send it a message, or open its chat and press Reset in the orb menu.`;
/** An agent parked because none of its models can hold it; ends when the agent is released. */
export const noFitWords = (name: string): string =>
  `${name} can't run: none of its models can hold its instructions and tools. Pick a bigger model for it on its detail page, or give it fewer tools, and it will answer your message.`;
export const NO_BIG_ROUTER_MODEL = 'the router has no model with a memory window of 32K or more, the least an agent needs. Add one to the router in Settings and it will answer';
/** The same for an agent on automatic model choice: it names the router's smallest model (read through a hook). */
export const autoNoFitWords = (name: string): string => {
  const model = routerFloorName?.() ?? null;
  if (!model) return `${name} can't run on automatic model choice: ${NO_BIG_ROUTER_MODEL} your message.`;
  return `${name} can't run on automatic model choice: the router's smallest model, ${model}, sets a window too small for its instructions and tools. `
    + `On the Router tab in Settings, raise the "Context window for automatic choice" slider, or raise ${model}'s window or take it off the router, or give it fewer tools, and it will answer your message.`;
};
let routerFloorName: (() => string | null) | null = null;
/** Called once by `router/router-window.ts` at load: the name of the router's smallest model, or null. */
export function registerRouterFloorName(read: () => string | null): void { routerFloorName = read; }
/** A task the stall ladder brought to the owner (`work/done/ladder.ts`): one card per task per day. */
export const stallKey = (workId: string): string => `stall:${workId}`;
const STALL_TRIED: Record<string, string> = {
  ladder_hint: 'a hint to its worker', ladder_pm: 'the project manager was told', review_miss: 'a project manager review with no verdict', ladder_decider: 'the main agent was asked to decide',
};
/** A decided row's stall card leaves every open dashboard now; the day's told record stays. */
export function endStallCard(workId: string): void {
  if (ownerToldOf(stallKey(workId))) frame(toldWords(stallKey(workId)), 'info', stallKey(workId));
}
export const toldWords = (key: string): string =>
  (getDb().prepare('SELECT value FROM healer_state WHERE scope = ? AND key = ?').get(TOLD, key) as { value: string | null } | undefined)?.value ?? '';
/** The stall card: what is stuck, since when, and what was tried; '' once the task is no longer waiting. */
function stallWords(workId: string): string {
  const db = getDb();
  const w = db.prepare(`SELECT title, state, ${holdWordsSql('w')} AS hold, COALESCE((SELECT MAX(h.created_at) FROM work_events h WHERE h.work_id = w.id AND h.kind = 'handed_in' AND w.state = 'handed_in'), ${taskMovedAtSql('w')}) AS since
    FROM work w WHERE w.id = ? AND (${workingExpr('w')} OR w.state = 'handed_in')`).get(workId) as { title: string | null; state: string; hold: string; since: number } | undefined;
  if (!w) return '';
  const tried = db.prepare(`SELECT json_extract(payload, '$.entry_kind') AS k, COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'audit' AND created_at >= ?
    AND json_extract(payload, '$.entry_kind') IN (${Object.keys(STALL_TRIED).map((k) => `'${k}'`).join(', ')}) GROUP BY k`).all(workId, w.since) as Array<{ k: string; n: number }>;
  const what = w.state === 'handed_in' ? 'has been handed in and waiting for a decision' : w.hold ? 'has been held' : 'has not moved';
  const triedWords = tried.length > 0 ? tried.map((t) => `${STALL_TRIED[t.k]}${t.n > 1 ? ` (${t.n} times)` : ''}`).join(', ') : 'nothing yet';
  return `"${w.title ?? workId}" ${what} since ${renderInstant(w.since) ?? 'an unknown time'}${w.hold ? `: ${w.hold}` : ''}. Tried: ${triedWords}. Open it on the Tracker page to decide it, or to close or cancel it.`;
}
/** "The limit is reached" for one budget window (`global_daily` or `agent_<id>`); the words never name an agent. */
export const budgetStopKey = (budgetId: string): string => `budgetstop:${budgetId}`;
export const budgetStopWords = (budgetId: string): string => budgetId.startsWith('agent_')
  ? `An agent's own spending limit is reached, so that agent is waiting. Raise its limit on the Ledger page to let it go on now, `
    + `or it goes on by itself when the window turns over. Its messages are kept and answered then.`
  : `Your daily spending limit is reached and no free model answered, so agents that need a paid model are waiting. `
    + `Raise the limit on the Ledger page to let them go on now, or they go on by themselves when the window turns over. `
    + `Their messages are kept and answered then.`;
export const healerMissingWords = (name: string): string =>
  `${name} is stuck and the Healer agent is missing, so nothing is unsticking it. A message to ${name} may get it going again.`;

const nameOf = (id: string): string => (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id;
const isAutoAgent = (id: string): boolean => ['auto', '__auto__'].includes((getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(id) as { model_id: string | null } | undefined)?.model_id ?? '');

/** The words a key's card carries when the key alone derives them; '' for a key whose words only its site knows. */
export function wordsOf(key: string): string {
  const [kind, id = ''] = key.split(/:(.*)/s);
  return kind === 'stuck' ? stuckWords(nameOf(id))
    : kind === 'stall' ? stallWords(id)
    : kind === 'nofit' ? (isAutoAgent(id) ? autoNoFitWords : noFitWords)(nameOf(id))
    : kind === 'budgetstop' ? budgetStopWords(id)
    : kind === 'healer-missing' ? healerMissingWords(nameOf(id))
    : kind === 'fitunchecked' ? uncheckedFitWords((getDb().prepare('SELECT name FROM models WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id)
    : kind === 'healer-broken' ? HEALER_BROKEN_WORDS
    : '';
}

/** The owner's standing rule, held where every told sentence is stored: no em-dash reaches him. */
const noEmDash = (sentence: string): string => sentence.replace(/\s*\u2014\s*/g, ', ');

/** Tell the owner `words` under `key`; true on the first telling (of the key, or of any key under `family`), when a
 *  caller that also texts him texts. The same words (or a stored row with none) change nothing; new words replace the
 *  card live and lift a dismissal. */
export function tellOwner(key: string, sentence: string, family?: string): boolean {
  const words = noEmDash(sentence);
  try {
    const db = getDb();
    const first = !db.prepare(`SELECT 1 FROM healer_state WHERE scope = ? AND (key = ? OR (? IS NOT NULL AND key LIKE ? || '%'))`).get(TOLD, key, family ?? null, family ?? null);
    const row = db.prepare('SELECT value FROM healer_state WHERE scope = ? AND key = ?').get(TOLD, key) as { value: string | null } | undefined;
    if (!first && (row === undefined || row.value === null || row.value === words)) {
      if (row?.value === null) db.prepare('UPDATE healer_state SET value = ? WHERE scope = ? AND key = ?').run(words, TOLD, key);
      return false;
    }
    db.prepare(`INSERT INTO healer_state (scope, key, at_ms, value) VALUES (?, ?, ?, ?)
                ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(TOLD, key, Date.now(), words);
    db.prepare('DELETE FROM healer_state WHERE scope = ? AND key = ?').run(DISMISSED, key);
    push(key, words);
    return first;
  } catch {
    push(key, words);
    return true; // the record could not be read or written: tell him rather than stay silent
  }
}

/** A condition that belongs to a WINDOW: a record older than `windowMs` is over (its card ends, he is told afresh). */
export function tellOwnerOncePerWindow(key: string, words: string, windowMs: number): boolean {
  ageOut(key, windowMs);
  return tellOwner(key, words);
}

/** Another text with its own card already told this window (the budget's crossing): told and dismissed, no card. */
export function tellLimitReachedWithoutCard(key: string, windowMs: number): void {
  try {
    ageOut(key, windowMs);
    if (ownerToldOf(key)) return;
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO healer_state (scope, key, at_ms, value) VALUES (?, ?, ?, ?)`).run(TOLD, key, Date.now(), noEmDash(wordsOf(key)));
    db.prepare('INSERT OR IGNORE INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)').run(DISMISSED, key, Date.now());
  } catch { /* best-effort: the worst case is one more true telling */ }
}

function ageOut(key: string, windowMs: number): void {
  try {
    const row = getDb().prepare('SELECT at_ms FROM healer_state WHERE scope = ? AND key = ?').get(TOLD, key) as { at_ms: number } | undefined;
    if (row && Date.now() - row.at_ms >= windowMs) ownerConditionCleared(key);
  } catch { /* the record could not be read: leave it */ }
}

/** He dismissed the card under `key`: it stays dismissed across reloads, and leaves every other open tab now. */
export function dismissOwnerNotice(key: string): void {
  getDb().prepare(`INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)
                   ON CONFLICT(scope, key) DO UPDATE SET at_ms = excluded.at_ms, updated_at = datetime('now')`).run(DISMISSED, key, Date.now());
  kindOf(key).dismissed?.();
  frame(toldWords(key), 'info', key);
}

/** Is the condition `key` told and standing (not dismissed)? */
export function ownerToldOf(key: string): boolean {
  try { return !!getDb().prepare('SELECT 1 FROM healer_state t WHERE t.scope = ? AND t.key = ? AND NOT EXISTS (SELECT 1 FROM healer_state d WHERE d.scope = ? AND d.key = t.key)').get(TOLD, key, DISMISSED); } catch { return false; }
}

/** The condition ended (its `key`, or every key under it): its rows go and its card leaves every open dashboard. */
export function ownerConditionCleared(key: string, family = false): void {
  try {
    const db = getDb();
    const told = db.prepare(`SELECT key, value FROM healer_state WHERE scope = ? AND (key = ? OR (? AND key LIKE ? || '%'))`).all(TOLD, key, family ? 1 : 0, key) as Array<{ key: string; value: string | null }>;
    if (told.length === 0) return;
    db.prepare(`DELETE FROM healer_state WHERE scope IN (?, ?) AND (key = ? OR (? AND key LIKE ? || '%'))`).run(TOLD, DISMISSED, key, family ? 1 : 0, key);
    for (const t of told) frame(t.value ?? '', 'info', t.key);
  } catch { /* best-effort, like the Healer's own damping: never block recovery */ }
}

/** The last agent parked by a budget limit was released: each window's "limit reached" card leaves, its record stays. */
export function budgetStopCardsLifted(): void {
  try {
    const rows = getDb().prepare(`SELECT t.key FROM healer_state t WHERE t.scope = ? AND t.key LIKE 'budgetstop:%'
      AND NOT EXISTS (SELECT 1 FROM healer_state d WHERE d.scope = ? AND d.key = t.key)`).all(TOLD, DISMISSED) as Array<{ key: string }>;
    for (const { key } of rows) dismissOwnerNotice(key);
  } catch { /* best-effort */ }
}

/** An agent recovered on evidence (never a clock): its "stuck" condition is over. */
export function ownerConditionsOnRecovery(agentId: string): void {
  ownerConditionCleared(`stuck:${agentId}`);
}

/** The agent completed a healthy model turn: if it is the Healer, that alone ends "Healer broken". */
export function ownerConditionsOnHealthyWork(agentId: string): void {
  try {
    const healer = getDb().prepare("SELECT value FROM config WHERE key = 'healer_agent_id'").get() as { value: string } | undefined;
    if (healer?.value === agentId) ownerConditionCleared('healer-broken');
  } catch { /* best-effort */ }
}

/** The Healer's row was looked at: present (and not terminated) is the record of "missing" ending. */
export function ownerConditionsOnHealerSeen(healerStatus: string | null): void {
  if (healerStatus === null || healerStatus === 'terminated') return;
  ownerConditionCleared('healer-missing:', true);
}

/** The agent is gone (terminated or purged): the conditions it is the subject of end. */
export function ownerConditionsOnAgentGone(agentId: string): void {
  for (const kind of ['stuck', 'healer-missing', 'nofit', 'paused', 'broken', 'silent']) ownerConditionCleared(`${kind}:${agentId}`);
}
