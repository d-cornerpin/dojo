// ════════════════════════════════════════════════════════════════════════════════════════
// THE STANDING LIST: what each kind of owner notice is, and whether it is still true.
//
// A notice key is `<kind>` or `<kind>:<id>`. Each kind names its class and severity and the one check of its own store
// that says the condition still holds (a budget's latches, a balance latch, an agent's row, an account, a watcher's
// record, the import marker, the Ollama upkeep's held version). The dashboard's reload list is the told, undismissed
// action notices whose check passes; a told notice whose check fails leaves the list as it is read.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { scrubTechnicalDetail } from '../agent/v2/error-format.js';
import { heldOllamaVersion } from '../services/ollama-version.js';
import { latestToldAt, windowOf } from '../costs/budget-cards.js';
import { watcherCardStands } from '../services/watcher-owner-cards.js';
import { importCardStands } from '../migration/import-recovery.js';
import { missingTools, readGap } from '../services/built-in-tools-card.js';
import { DISMISSED, TOLD, dismissOwnerNotice, ownerConditionCleared, wordsOf, type OwnerCardClass } from './owner-notices.js';

interface Kind {
  cls: (key: string) => OwnerCardClass;
  critical?: boolean;
  /** Still true? Absent: never on the reload list. An informational notice with a check is shown at one load, once. */
  stands?: (id: string) => boolean;
  /** Its told record belongs to a window, so a notice that stops standing is dismissed, not forgotten. */
  perWindow?: boolean;
}

const one = <T>(sql: string, ...args: unknown[]): T | undefined => getDb().prepare(sql).get(...args) as T | undefined;
const live = (id: string): boolean => !!one(`SELECT 1 FROM agents WHERE id = ? AND status != 'terminated'`, id);
const action = (stands: (id: string) => boolean, more: Partial<Kind> = {}): Kind => ({ cls: () => 'action', stands, ...more });
const informational: Kind = { cls: () => 'informational' };
const agentNotice = (col: 'rate_limit_notice' | 'broken_notice' | 'silent_notice', where: string) => (id: string): boolean =>
  !!one(`SELECT 1 FROM agents WHERE id = ? AND ${col} IS NOT NULL AND ${where}`, id);

const KINDS: Record<string, Kind> = {
  stuck: action(live),
  'healer-missing': action(live, { critical: true }),
  'healer-broken': action(() => true, { critical: true }),
  nofit: action((id) => !!one(`SELECT 1 FROM agents WHERE id = ? AND status = 'paused' AND instr(COALESCE(last_error, ''), '[no_model_fits]') = 1`, id)),
  budgetstop: action(() => !!one(`SELECT 1 FROM agents WHERE status = 'paused' AND instr(COALESCE(last_error, ''), '[budget_stop]') = 1`), { perWindow: true }),
  stall: action((id) => !!one("SELECT 1 FROM work WHERE id = ? AND state IN ('claimed', 'sent_back', 'handed_in')", id), { perWindow: true }),
  budget: action((id) => {
    const r = one<{ period: string; alert_50_sent: number | null; alert_75_sent: number | null; alert_90_sent: number | null }>('SELECT period, alert_50_sent, alert_75_sent, alert_90_sent FROM budgets WHERE id = ?', id);
    return !!r && latestToldAt(r) > 0 && Math.floor(Date.now() / 1000) - latestToldAt(r) < windowOf(r.period).seconds;
  }),
  balance: action((latchKey) => !!one('SELECT 1 FROM config WHERE key = ?', latchKey)),
  paused: action((id) => !!one(`SELECT 1 FROM error_loop_state e JOIN agents a ON a.id = e.agent_id WHERE e.agent_id = ? AND e.kind = 'paused'
    AND a.status = 'paused' AND e.owner_card_closed_at IS NULL`, id)),
  ratelimit: action(agentNotice('rate_limit_notice', "status = 'rate_limited'"), { critical: true }),
  broken: action(agentNotice('broken_notice', "status != 'terminated'")),
  silent: action(agentNotice('silent_notice', "status != 'terminated'")),
  'memory-low': action(() => !!one("SELECT 1 FROM config WHERE key = 'owner_notice_memory_low'"), { critical: true }),
  signin: action((id) => {
    const [table, account] = id.split(/:(.*)/s);
    return !!one(table === 'microsoft'
      ? 'SELECT 1 FROM microsoft_accounts WHERE id = ? AND owner_notice IS NOT NULL AND connected = 0'
      : 'SELECT 1 FROM google_accounts WHERE id = ? AND owner_notice IS NOT NULL AND connected = 0', account);
  }, { critical: true }),
  watcher: action((id) => watcherCardStands(id), { critical: true }),
  'import-failed-not-running': action(() => importCardStands(), { critical: true }),
  ollama: { cls: () => (heldOllamaVersion() !== null ? 'action' : 'informational'), stands: () => heldOllamaVersion() !== null },
  'embedding-switch': informational,
  fitunchecked: informational,
  lessons: informational,
  'built-in-tools': { cls: () => 'informational', stands: (id) => missingTools(id, readGap()[id]?.names ?? []).length > 0 },
};

/** The kind of `key`; an unknown kind (one an earlier build told and this one retired) never stands. */
export function kindOf(key: string): Kind {
  return KINDS[key.split(':')[0]] ?? { cls: () => 'informational' };
}

/** The dashboard's reload list: every told, undismissed notice with a check whose condition still holds. An action
 *  notice that no longer holds leaves here (a windowed one is dismissed so its window is not told twice). */
export function standingOwnerNotices(): Array<{ words: string; severity: 'critical' | 'notice'; cardKey: string; cardClass: OwnerCardClass }> {
  const rows = getDb().prepare(`SELECT t.key, t.value FROM healer_state t WHERE t.scope = ?
    AND NOT EXISTS (SELECT 1 FROM healer_state d WHERE d.scope = ? AND d.key = t.key) ORDER BY t.at_ms`).all(TOLD, DISMISSED) as Array<{ key: string; value: string | null }>;
  return rows.flatMap(({ key, value }) => {
    const kind = kindOf(key);
    if (!kind.stands) return [];
    const words = value ?? wordsOf(key);
    const cardClass = kind.cls(key);
    const holds = words !== '' && kind.stands(key.split(/:(.*)/s)[1] ?? '');
    // An informational notice is shown at one load or not at all; its record stays, so the same words are never told again.
    if (cardClass === 'informational') getDb().prepare('INSERT OR IGNORE INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)').run(DISMISSED, key, Date.now());
    if (!holds) {
      if (cardClass === 'action') { if (kind.perWindow) dismissOwnerNotice(key); else ownerConditionCleared(key); }
      return [];
    }
    return [{ words: scrubTechnicalDetail(words), severity: kind.critical ? 'critical' as const : 'notice' as const, cardKey: key, cardClass }];
  });
}

/** The scheduler's tick: a standing notice whose condition ended without a site saying so (a budget window turned over)
 *  leaves every open dashboard now. */
export function sweepOwnerNotices(): void {
  try { standingOwnerNotices(); } catch { /* the next tick or load does it */ }
}
