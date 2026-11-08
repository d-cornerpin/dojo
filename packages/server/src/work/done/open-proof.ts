// OPEN A PROOF ITEM: what a decider reads before it decides, and the durable record that it did.
// A file is read as the worker would read it (`agent/permissions.ts`, through `fileFacts`); a message is
// its recorded text; every other kind is the record the hand-in door resolved. Each open appends
// `proof_opened`, which `decide` reads: an approval needs every item opened by its decider.
import { getDb } from '../../db/connection.js';
import { appendWorkEvent } from '../store.js';
import { fileFacts, EXCERPT_BYTES } from './file-facts.js';
import { latestHandIn, workerOf } from './record.js';
import { proofLines, type ResolvedItem } from './proof.js';

export type OpenResult = { ok: true; text: string } | { ok: false; text: string };

function contentOf(worker: string, item: ResolvedItem): string {
  if (item.kind === 'file') {
    const f = fileFacts(worker, item.ref);
    return f.ok ? f.facts.excerpt : `The file cannot be read now: ${f.why}.`;
  }
  if (item.kind === 'delivery') {
    const d = getDb().prepare(
      `SELECT COALESCE(m.content, r.sent_text) AS text FROM deliveries d
         LEFT JOIN messages m ON m.id = d.message_id LEFT JOIN tool_receipts r ON r.id = d.receipt_id WHERE d.id = ?`,
    ).get(item.ref) as { text: string | null } | undefined;
    return (d?.text ?? '(no recorded text)').slice(0, EXCERPT_BYTES);
  }
  return JSON.stringify(item.facts, null, 2);
}

/** Open item `index` (0-based) of the row's waiting hand-in, as `agentId`. */
export function openProof(agentId: string, workId: string, index: number): OpenResult {
  const state = (getDb().prepare('SELECT state FROM work WHERE id = ?').get(workId) as { state: string } | undefined)?.state;
  const handIn = state === 'handed_in' ? latestHandIn(workId) : null;
  if (!handIn) return { ok: false, text: `Refused: ${workId} has no hand-in waiting for a decision, so there is no proof to open.` };
  const item = handIn.items[index];
  if (!Number.isInteger(index) || !item) {
    return { ok: false, text: `Refused: the hand-in of ${workId} has items 0 to ${handIn.items.length - 1}; there is no item ${index}.` };
  }
  appendWorkEvent(workId, 'proof_opened', agentId, { hand_in: handIn.eventId, index, kind: item.kind, ref: item.ref });
  return { ok: true, text: `Item ${index} of ${handIn.items.length}: ${proofLines([item])[0]}\n\n${contentOf(workerOf(workId), item)}` };
}

/** Has `agentId` opened every item of the row's newest hand-in? */
export function openedEveryItem(agentId: string, workId: string): { ok: true } | { ok: false; unopened: number[] } {
  const handIn = latestHandIn(workId);
  if (!handIn) return { ok: false, unopened: [] };
  const opened = new Set((getDb().prepare(
    `SELECT DISTINCT json_extract(payload, '$.index') AS i FROM work_events
      WHERE work_id = ? AND kind = 'proof_opened' AND actor = ? AND json_extract(payload, '$.hand_in') = ?`,
  ).all(workId, agentId, handIn.eventId) as Array<{ i: number }>).map((r) => r.i));
  const unopened = handIn.items.map((_, i) => i).filter((i) => !opened.has(i));
  return unopened.length === 0 ? { ok: true } : { ok: false, unopened };
}
