// What the summary check has recorded: the spans that failed their check (so no writer is handed them again
// until something changes), and the running numbers the Healer report reads.

import { createHash } from 'node:crypto';
import { getDb } from '../db/connection.js';

export type SummaryParams = { content: string; agentId: string; modelId?: string; checkFeedback?: string; spanIds?: readonly string[]; spanOpen?: boolean };

// ── A SPAN THAT FAILED ITS CHECK (orchestrator ruling, fix round 2; re-review 2 S6) ──
// It is handed to no other writer by any path, and not retried by the same one, until a REAL signal: the agent's own
// model changes (the owner's pick, which is what writes its summaries), or the span closes with new rows in it.
// Recorded per row (`healer_state` scope `summary_span_refused`, key agent|own model|row id). S6: a span holding a
// refused row is HANDLED (`spanHeld`) while it is the same rows, or while it is still OPEN (the last chunk of a fold,
// which gains a row on every busy pass); it is tried once more when it closes (a later chunk exists, so its boundary
// is final). No timer and no count: each is a fact about the rows.
const REFUSED_SCOPE = 'summary_span_refused';
const ownModelOf = (agentId: string): string => {
  try { return (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id ?? ''; } catch { return ''; }
};
export const spanKeys = (p: SummaryParams): string[] => {
  const own = ownModelOf(p.agentId);
  const ids = p.spanIds && p.spanIds.length > 0 ? p.spanIds : [`content:${createHash('sha256').update(p.content).digest('hex').slice(0, 32)}`];
  return ids.map((id) => `${p.agentId}|${own}|${id}`);
};
export function spanRefused(keys: string[]): boolean {
  return refusedIn(keys) === keys.length;
}
const refusedIn = (keys: string[]): number => {
  try {
    return (getDb().prepare(`SELECT COUNT(*) AS n FROM healer_state WHERE scope = ? AND key IN (${keys.map(() => '?').join(',')})`).get(REFUSED_SCOPE, ...keys) as { n: number }).n;
  } catch { return 0; }
};
/** S6: is this span handled already? Every row refused by this writer, or an open span holding one that was. */
export function spanHeld(keys: string[], open: boolean): boolean {
  const n = refusedIn(keys);
  return n === keys.length || (open && n > 0);
}
export function recordRefusedSpan(keys: string[]): void {
  try {
    const db = getDb();
    // NB-9: this agent's refusals recorded under an earlier own model are over (the owner changed it): pruned. Per
    // agent, so one agent's refusal never re-arms another's.
    const [agent, own] = keys[0]?.split('|') ?? [];
    if (agent !== undefined && own !== undefined) {
      const rows = db.prepare('SELECT key FROM healer_state WHERE scope = ?').all(REFUSED_SCOPE) as Array<{ key: string }>;
      const del = db.prepare('DELETE FROM healer_state WHERE scope = ? AND key = ?');
      for (const { key } of rows) { const [a, m] = key.split('|'); if (a === agent && m !== own) del.run(REFUSED_SCOPE, key); }
    }
    const ins = db.prepare('INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET at_ms = excluded.at_ms');
    for (const k of keys) ins.run(REFUSED_SCOPE, k, Date.now());
  } catch { /* best-effort: the worst case is one more try */ }
}
/** NB-9: the span was summarized after all: its rows' refusals go, whichever writer recorded them. */
export function clearRefusedSpan(keys: string[]): void {
  if (keys.length === 0) return;
  try {
    const del = getDb().prepare("DELETE FROM healer_state WHERE scope = ? AND key LIKE ? ESCAPE '\\'");
    for (const k of keys) {
      const [agent, , ...rest] = k.split('|');
      const esc = (x: string): string => x.replace(/[\\%_]/g, (c) => `\\${c}`);
      del.run(REFUSED_SCOPE, `${esc(agent)}|%|${esc(rest.join('|'))}`);
    }
  } catch { /* best-effort */ }
}

/** The Healer report's running numbers over the kept window, or null when nothing was checked. */
export function summaryCheckLine(): string | null {
  try {
    const r = getDb().prepare(`SELECT COUNT(*) AS n, SUM(outcome = 'ok') AS ok, SUM(outcome = 'rewritten_ok') AS rw,
      SUM(outcome = 'not_kept') AS failed, SUM(outcome = 'unavailable') AS un FROM summary_checks`).get() as
      { n: number; ok: number | null; rw: number | null; failed: number | null; un: number | null };
    if (r.n === 0) return null;
    return `Summary check (kept window): ${r.n} checked, ${r.ok ?? 0} kept as written, ${r.rw ?? 0} kept after one rewrite, `
      + `${r.failed ?? 0} left the rows whole, ${r.un ?? 0} unchecked (decision model unavailable).`;
  } catch { return null; }
}
