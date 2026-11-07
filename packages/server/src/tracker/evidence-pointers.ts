// ════════════════════════════════════════
// C6 (v3.5 field fix 3 evidence round): AN EVIDENCE POINTER IS AN ID THE ENGINE RESOLVES.
//
// Measured on the owner's box: the PM read the very message a close was about (its verdict record
// lists it), and the door refused the uphold again, four times on one row. The worker's pointers
// were prose ("RECENT OUTBOUND [Nov 5, 2026, 04:05 PM ...] agent -> PM", "work_events <id>, pm note
// <time>"), and a PM read binds to a row only when it opens an exact id or path the row's record
// names (`rowReadNames` in `looked-at.ts`). Nothing structured named the message.
//
// This resolves a pointer to the records it names, by the engine's own rows, never by reading the
// prose for meaning:
//   * an absolute or home path is a path;
//   * every id-shaped token (a full id, or an 8+ character hex prefix) is looked up among the WORKER's
//     own DELIVERED deliveries (a failed or held send names nothing), its own receipts (a receipt names the delivery it proved, `deliveries.receipt_id`)
//     and the messages it wrote or delivered. A token that matches more than one record names none.
// The message a pointer resolves to is what a PM `history_get` opens, so that read now binds.
//
// THE FILING HALF (owner-ruled shape, not wired here): the close door (`tracker/tools.ts`, the
// worker's `evidence` validation) is where a pointer should be resolved once and stored as a `ref`
// beside it, and a pointer that names nothing refused. That door and the `evidence` parameter's
// description are outside this change (the description is cached prompt prefix). `rowReadNames`
// already reads a stored `ref` first, so the door can adopt `resolveEvidencePointer` as is.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';

export type PointerRef =
  | { kind: 'path'; id: string }
  | { kind: 'message'; id: string }
  | { kind: 'delivery'; id: string; messageId: string | null }
  | { kind: 'receipt'; id: string; messageId: string | null };

/** Id-shaped tokens: a full uuid, or a hex run of 8 or more (the prefix every tool prints). */
const ID_TOKEN = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]*)\b/g;
const PATH = /^(?:\/|~\/)\S+$/;

/** Rows whose id starts with `token`, on the primary key's index (ids are lower-case hex and dashes). */
const startsWith = (col: string): string => `${col} >= ? AND ${col} < ?`;
const bounds = (token: string): [string, string] => [token, `${token}~`];

/** What one pointer names, for the worker `agentId`. Empty when it names nothing the engine holds. */
export function resolveEvidencePointer(agentId: string, pointer: string): PointerRef[] {
  const p = pointer.trim();
  if (!p) return [];
  if (PATH.test(p)) return [{ kind: 'path', id: p }];
  const out: PointerRef[] = [];
  const db = getDb();
  for (const token of new Set(p.toLowerCase().match(ID_TOKEN) ?? [])) {
    const found: PointerRef[] = [];
    const deliveries = db.prepare(`SELECT id, message_id FROM deliveries WHERE ${startsWith('id')} AND agent_id = ? AND outcome = 'delivered' LIMIT 2`)
      .all(...bounds(token), agentId) as Array<{ id: string; message_id: string | null }>;
    for (const d of deliveries) found.push({ kind: 'delivery', id: d.id, messageId: d.message_id });
    const receipts = db.prepare(
      `SELECT r.id AS id, (SELECT d.message_id FROM deliveries d WHERE d.receipt_id = r.id AND d.outcome = 'delivered' ORDER BY d.rowid DESC LIMIT 1) AS message_id
         FROM tool_receipts r WHERE ${startsWith('r.id')} AND r.agent_id = ? LIMIT 2`,
    ).all(...bounds(token), agentId) as Array<{ id: string; message_id: string | null }>;
    for (const r of receipts) found.push({ kind: 'receipt', id: r.id, messageId: r.message_id });
    const messages = db.prepare(
      `SELECT m.id AS id FROM messages m WHERE ${startsWith('m.id')}
          AND (m.agent_id = ? OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.agent_id = ? AND d.outcome = 'delivered')) LIMIT 2`,
    ).all(...bounds(token), agentId, agentId) as Array<{ id: string }>;
    for (const m of messages) found.push({ kind: 'message', id: m.id });
    if (found.length === 1) out.push(found[0]);
  }
  return out;
}

/** The message ids and paths a set of refs names: what a PM read can open. */
export function refNames(refs: readonly PointerRef[]): { messages: string[]; paths: string[] } {
  const messages: string[] = [];
  const paths: string[] = [];
  for (const r of refs) {
    if (r.kind === 'path') paths.push(r.id);
    else if (r.kind === 'message') messages.push(r.id);
    else if (r.messageId) messages.push(r.messageId);
  }
  return { messages, paths };
}

/** A stored `ref` on an evidence entry, when the close door wrote one (see the header). */
export function storedRef(v: unknown): PointerRef | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as { kind?: unknown; id?: unknown; messageId?: unknown };
  if (typeof r.id !== 'string' || !r.id) return null;
  const messageId = typeof r.messageId === 'string' ? r.messageId : null;
  if (r.kind === 'path' || r.kind === 'message') return { kind: r.kind, id: r.id };
  if (r.kind === 'delivery' || r.kind === 'receipt') return { kind: r.kind, id: r.id, messageId };
  return null;
}
