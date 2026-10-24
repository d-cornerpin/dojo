// ════════════════════════════════════════════════════════════════════════════
// v3.5 — WHAT THE SUMMARY CHECK HAS RECORDED (split from `summary-check.ts`, fix round 2): the spans that
// failed their check (so no writer is handed them again until something changes), and the running numbers
// the Healer report and the owner's Summarization Model card read.
// ════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { standardModelRowId } from '../services/local-standard.js';

export type SummaryParams = { content: string; agentId: string; modelId?: string; checkFeedback?: string; spanIds?: readonly string[] };

// ── A SPAN THAT FAILED ITS CHECK (orchestrator ruling, fix round 2) ──
// It is handed to no other writer by any path, and not retried by the same one, until something changes:
// the owner's summary writer setting, or new rows joining the span. Recorded per row (`healer_state` scope
// `summary_span_refused`, key agent|setting|row id): a span is refused when every one of its rows is.
const REFUSED_SCOPE = 'summary_span_refused';
export const spanKeys = (p: SummaryParams): string[] => {
  const setting = (getDb().prepare("SELECT value FROM config WHERE key = 'compaction_model_id'").get() as { value: string } | undefined)?.value ?? '';
  const ids = p.spanIds && p.spanIds.length > 0 ? p.spanIds : [`content:${createHash('sha256').update(p.content).digest('hex').slice(0, 32)}`];
  return ids.map((id) => `${p.agentId}|${setting}|${id}`);
};
export function spanRefused(keys: string[]): boolean {
  try {
    const n = (getDb().prepare(`SELECT COUNT(*) AS n FROM healer_state WHERE scope = ? AND key IN (${keys.map(() => '?').join(',')})`).get(REFUSED_SCOPE, ...keys) as { n: number }).n;
    return n === keys.length;
  } catch { return false; }
}
export function recordRefusedSpan(keys: string[]): void {
  try {
    const ins = getDb().prepare('INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET at_ms = excluded.at_ms');
    for (const k of keys) ins.run(REFUSED_SCOPE, k, Date.now());
  } catch { /* best-effort: the worst case is one more try */ }
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

/**
 * (iv, fix round 2) What the owner's Summarization Model card says: is the CURRENT summary writer (his pick,
 * else the Dojo's writer) failing the check in the kept window? Owner 2026-10-20: "the user is encouraged to
 * change the summarization model to another larger model" — the card says so while this is true.
 */
export function summaryWriterStatus(): { writer: string | null; failed: number; total: number; failing: boolean } {
  try {
    const db = getDb();
    const writer = (db.prepare("SELECT value FROM config WHERE key = 'compaction_model_id'").get() as { value: string } | undefined)?.value
      || standardModelRowId('writer');
    if (!writer) return { writer: null, failed: 0, total: 0, failing: false };
    const r = db.prepare("SELECT SUM(outcome = 'not_kept') AS failed, COUNT(*) AS total FROM summary_checks WHERE writer_model_id = ? AND outcome != 'unavailable'")
      .get(writer) as { failed: number | null; total: number };
    return { writer, failed: r.failed ?? 0, total: r.total, failing: (r.failed ?? 0) > 0 };
  } catch { return { writer: null, failed: 0, total: 0, failing: false }; }
}
