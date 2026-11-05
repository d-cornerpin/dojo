// ════════════════════════════════════════════════════════════════════════════════════════
// t269 fix rounds 1–2 (review I1, re-review N1) — A SPAN A WRITER CANNOT WRITE WHOLE IS NOT HANDED TO THAT
// WRITER AGAIN; A SPAN EVERY CANDIDATE WRITER CANNOT WRITE IS LEFT WHOLE.
//
// Refusing cut answers (cause 3) left one loop: a pair of notes whose merge every writer's output cuts, or a
// single row no writer can summarise, was dialled again on every pass. The orchestrator's ruling: a span is
// split further, down to single rows; what still cannot be written is left whole and not dialled again until
// something changes. Round 2 (N1): "something" is the content, the owner's summary-writer setting, OR a writer
// that has not refused it yet — a refusal is one writer's verdict, so an outage (a writer not tried) or a
// bigger writer the owner picks never strands a span.
//
//   · ONE ROW PER (agent, setting, writer, span) in `healer_state` (scope `summary_unwritable`), the span as a
//     hash of its ids AND contents — the same shape as the accuracy check's ledger (`summary-check-ledger.ts`),
//     and pruned the same way: a refusal recorded under an earlier writer setting is over, and goes.
//   · A writer is not dialled over a span it refused (`writersLeft`). A span is UNWRITABLE only when every
//     CANDIDATE writer (`summaryWriterCandidates`, the one order t268 defines, health aside) has refused it
//     (`isMarkedUnwritable`). A writer with no memory free (`noRoom`) cannot run now: that is never a refusal.
//   · A CONDENSED PAIR left whole is two notes the summaries lane shows or names as it already does.
//   · A SINGLE ROW left whole becomes a KEPT-WHOLE note (`KEPT_WHOLE_KIND`): the row as the writer would have
//     read it (its tag, scrubbed exactly as summary input is), shown as the live view's kept-row pointer
//     (`kept-row-view.ts`, D18) when long, so `tool_result_read("msg:<id>")` reads the whole stored row.
// ════════════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { eligibleSummaryWriters, summaryWriterCandidates } from './summary-writer-health.js';
import { pruneRefusalsOtherThan } from './refusal-prune.js';

const SCOPE = 'summary_unwritable';

export interface SpanItem { id: string; content: string }

/** The key's setting part. It held the Summarization pick; v3.5 field fix 3 (owner ruling: no such setting) leaves it
 *  empty, the value every box without a pick already wrote, so the key's shape and its prune stay as they were. */
const setting = (): string => '';
const agentModel = (agentId: string): string | undefined =>
  (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id ?? undefined;

const spanHash = (items: readonly SpanItem[]): string => {
  const h = createHash('sha256');
  for (const it of [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) h.update(`${it.id}\0${it.content}\0`);
  return h.digest('hex').slice(0, 32);
};
const keyOf = (agentId: string, set: string, writer: string, hash: string): string => `${agentId}|${set}|${writer}|${hash}`;

/** Record that `writer` could not write this span whole (more than it holds, or cut twice). */
export function recordRefusal(agentId: string, writer: string, items: readonly SpanItem[]): void {
  try {
    const db = getDb();
    const set = setting();
    pruneRefusalsOtherThan(db, SCOPE, set);   // an earlier setting's refusals are over
    db.prepare('INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET at_ms = excluded.at_ms')
      .run(SCOPE, keyOf(agentId, set, writer, spanHash(items)), Date.now());
  } catch { /* best effort: a missing record costs one more try, never a summary */ }
}

function refusedBy(agentId: string, writer: string, items: readonly SpanItem[], set = setting(), hash = spanHash(items)): boolean {
  try {
    return !!getDb().prepare('SELECT 1 FROM healer_state WHERE scope = ? AND key = ?').get(SCOPE, keyOf(agentId, set, writer, hash));
  } catch {
    return false;
  }
}

/** The writers that may be dialled over this span now, all from the one writer order (`summary-writer-health.ts`:
 *  the Summarization pick, the agent's own model, the small writer — t268): the pass's own resolved writer `first`
 *  (when it is of that order) and the eligible ones, less those that already refused it under the current setting. */
export function writersLeft(agentId: string, items: readonly SpanItem[], first?: string): string[] {
  const set = setting();
  const hash = spanHash(items);
  const own = agentModel(agentId);
  const passWriter = first && summaryWriterCandidates(own, agentId).includes(first) ? [first] : [];
  return [...new Set([...passWriter, ...eligibleSummaryWriters(own, agentId)])].filter((w) => !refusedBy(agentId, w, items, set, hash));
}

/** Has EVERY candidate writer (health aside) refused this exact span under the current setting? */
export function isMarkedUnwritable(agentId: string, items: readonly SpanItem[]): boolean {
  const candidates = summaryWriterCandidates(agentModel(agentId), agentId);
  const set = setting();
  const hash = spanHash(items);
  return candidates.length > 0 && candidates.every((w) => refusedBy(agentId, w, items, set, hash));
}
