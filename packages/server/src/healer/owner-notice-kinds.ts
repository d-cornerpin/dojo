// The standing list: what each kind of owner notice is, and whether it is still true. A notice key is `<kind>` or
// `<kind>:<id>`; each kind has one check of its own store. The dashboard's reload list is the told, undismissed
// action notices whose check passes; a told notice whose check fails leaves the list as it is read.

import { getDb } from '../db/connection.js';
import { scrubTechnicalDetail } from '../agent/v2/error-format.js';
import { heldOllamaVersion } from '../services/ollama-version.js';
import { latestToldAt, windowOf } from '../costs/budget-cards.js';
import { watcherCardStands } from '../services/watcher-owner-cards.js';
import { importCardDismissed, importCardStands } from '../migration/import-recovery.js';
import { DISMISSED, TOLD, dismissOwnerNotice, ownerConditionCleared, wordsOf, type OwnerCardClass } from './owner-notices.js';
import { workingExpr } from '../work/terminal-states.js';

interface Kind {
  cls: (key: string) => OwnerCardClass;
  critical?: boolean;
  /** Still true? Absent: never on the reload list. An informational notice with a check is shown at one load, once. */
  stands?: (id: string) => boolean;
  /** Its told record belongs to a window, so a notice that stops standing is dismissed, not forgotten. */
  perWindow?: boolean;
  /** Called when he dismisses its card (the import card's truth lives outside the database). */
  dismissed?: () => void;
}

const one = <T>(sql: string, ...args: unknown[]): T | undefined => getDb().prepare(sql).get(...args) as T | undefined;
const live = (id: string): boolean => !!one(`SELECT 1 FROM agents WHERE id = ? AND status != 'terminated'`, id);
const action = (stands: (id: string) => boolean, more: Partial<Kind> = {}): Kind => ({ cls: () => 'action', stands, ...more });
const informational: Kind = { cls: () => 'informational' };
const agentNotice = (col: 'broken_notice' | 'silent_notice', where: string) => (id: string): boolean =>
  !!one(`SELECT 1 FROM agents WHERE id = ? AND ${col} IS NOT NULL AND ${where}`, id);

const KINDS: Record<string, Kind> = {
  stuck: action(live),
  'healer-missing': action(live, { critical: true }),
  'healer-broken': action(() => true, { critical: true }),
  nofit: action((id) => !!one(`SELECT 1 FROM agents WHERE id = ? AND status = 'paused' AND instr(COALESCE(last_error, ''), '[no_model_fits]') = 1`, id)),
  budgetstop: action(() => !!one(`SELECT 1 FROM agents WHERE status = 'paused' AND instr(COALESCE(last_error, ''), '[budget_stop]') = 1`), { perWindow: true }),
  stall: action((id) => !!one(`SELECT 1 FROM work w WHERE w.id = ? AND (${workingExpr('w')} OR w.state = 'handed_in')`, id), { perWindow: true }),
  budget: action((id) => {
    const r = one<{ period: string; alert_50_sent: number | null; alert_75_sent: number | null; alert_90_sent: number | null }>('SELECT period, alert_50_sent, alert_75_sent, alert_90_sent FROM budgets WHERE id = ?', id);
    return !!r && latestToldAt(r) > 0 && Math.floor(Date.now() / 1000) - latestToldAt(r) < windowOf(r.period).seconds;
  }),
  balance: action((latchKey) => !!one('SELECT 1 FROM config WHERE key = ?', latchKey)),
  paused: action((id) => !!one(`SELECT 1 FROM error_loop_state e JOIN agents a ON a.id = e.agent_id WHERE e.agent_id = ? AND e.kind = 'paused'
    AND a.status = 'paused' AND e.owner_card_closed_at IS NULL`, id)),
  broken: action(agentNotice('broken_notice', "status != 'terminated'")),
  silent: action(agentNotice('silent_notice', "status != 'terminated'")),
  undelivered: action(() => true),
  'memory-low': action(() => !!one("SELECT 1 FROM config WHERE key = 'owner_notice_memory_low'"), { critical: true }),
  signin: action((id) => {
    const [table, account] = id.split(/:(.*)/s);
    return !!one(table === 'microsoft'
      ? 'SELECT 1 FROM microsoft_accounts WHERE id = ? AND owner_notice IS NOT NULL AND connected = 0'
      : 'SELECT 1 FROM google_accounts WHERE id = ? AND owner_notice IS NOT NULL AND connected = 0', account);
  }, { critical: true }),
  watcher: action((id) => watcherCardStands(id), { critical: true }),
  'import-failed-not-running': action(() => importCardStands(), { critical: true, dismissed: () => importCardDismissed() }),
  ollama: { cls: () => (heldOllamaVersion() !== null ? 'action' : 'informational'), stands: () => heldOllamaVersion() !== null },
  smallmodel: { cls: (key) => (key === 'smallmodel:stuck' ? 'action' : 'informational'), stands: () => true },
  projectend: { cls: () => 'informational', stands: () => true },
  missedruns: { cls: () => 'informational', stands: () => true },
  fitunchecked: informational,
  lessons: informational,
};

/** The kind of `key`; an unknown kind (one an earlier build told and this one retired) never stands. */
export function kindOf(key: string): Kind {
  return KINDS[key.split(':')[0]] ?? { cls: () => 'informational' };
}

type Notice = { key: string; words: string; kind: Kind; holds: boolean };
function toldNotices(): Notice[] {
  const rows = getDb().prepare(`SELECT t.key, t.value FROM healer_state t WHERE t.scope = ?
    AND NOT EXISTS (SELECT 1 FROM healer_state d WHERE d.scope = ? AND d.key = t.key) ORDER BY t.at_ms`).all(TOLD, DISMISSED) as Array<{ key: string; value: string | null }>;
  return rows.flatMap(({ key, value }) => {
    const kind = kindOf(key);
    if (!kind.stands) return [];
    const words = value ?? wordsOf(key);
    return [{ key, words, kind, holds: words !== '' && kind.stands(key.split(/:(.*)/s)[1] ?? '') }];
  });
}

/** The dashboard's reload list: every told, undismissed notice with a check whose condition still holds. Reads only. */
export function standingOwnerNotices(): Array<{ words: string; severity: 'critical' | 'notice'; cardKey: string; cardClass: OwnerCardClass }> {
  return toldNotices().filter((n) => n.holds).map((n) => ({
    words: scrubTechnicalDetail(n.words), severity: n.kind.critical ? 'critical' as const : 'notice' as const, cardKey: n.key, cardClass: n.kind.cls(n.key),
  }));
}

/** The scheduler's tick and every load: an action notice whose condition ended unsaid (a budget window turned over)
 *  leaves every open dashboard now; a windowed one is dismissed so its window is not told twice. */
export function sweepOwnerNotices(): void {
  try {
    for (const n of toldNotices()) {
      if (n.holds) continue;
      if (n.kind.cls(n.key) === 'informational') markShown(n.key);   // over before it was shown: never shown later
      else if (n.kind.perWindow) dismissOwnerNotice(n.key); else ownerConditionCleared(n.key);
    }
  } catch { /* the next tick or load does it */ }
}

/** What a dashboard load is served: the sweep, then the standing list. An informational notice is served at one load,
 *  once; its record stays, so the same words are never told again. */
export function servedOwnerNotices(): ReturnType<typeof standingOwnerNotices> {
  sweepOwnerNotices();
  const cards = standingOwnerNotices();
  for (const c of cards) if (c.cardClass === 'informational') markShown(c.cardKey);
  return cards;
}

const markShown = (key: string): void => { getDb().prepare('INSERT OR IGNORE INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)').run(DISMISSED, key, Date.now()); };
