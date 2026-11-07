// v3.5 DONE IS MEASURED (t250 fix rounds 4–5, orchestrator rulings) — WHEN A QUOTE IS THE OWNER'S.
//
// `work_validate(action="apply_user_verdict")` is called by a MODEL with a `user_quote` the model
// supplies. The owner's exemption (he can always close his own task) applies to a VERIFIED owner
// act only: after the platform's one quote normalisation (`work/row-authority.ts` `normalizeQuote`:
// case, curly quotes, whitespace, edge punctuation), the quote must EQUAL a whole message the owner
// wrote since the verdict was asked, or a whole sentence of one (split on . ! ? and newlines). A
// fragment never verifies: "close it" is not in "Do not close it.", and "o" is not in "No.".
//
// Whose message: one that came in through an ingest door (it has a channel) on any channel the owner
// uses — the dashboard, voice and the owner's iMessage, by the stamped origin (`deriveOrigin`, the
// one "who is this from" answer). EMAIL VERIFIES ONLY ONE WAY (t250 fix round 6, reopened by the owner's P44
// ruling 2026-10-27): a From header alone is nobody authenticated, and a reply carries the agent's own quoted
// question back. So an email row counts only when the mail watcher stamped `relation: 'owner'` after the PROVIDER's
// own DMARC result confirmed an owner address (`services/mail-owner-intake.ts`), and then ONLY the owner's new words
// the watcher stored beside it (`ownerWords`, the quoted thread cut) — never the row's content, never a preview.
import { deriveOrigin, legacyOriginInputs, stripInboundChannelMarker, type InboundMeta } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { WORK_EVENT } from '../work/tracker-view.js';
import { normalizeQuote } from '../work/row-authority.js';
import { turnContext } from '../agent/turn-context.js';

interface Row {
  content: string; lane: string; channel: string; source_agent_id: string | null;
  a2a_thread_id: string | null; a2a_intent: string | null; a2a_requires_response: number | null;
  inbound_meta: string | null; origin_intent: string | null;
}

/** The owner's new words in an email row the watcher stamped as the owner's, or null. Every stamp must agree: the
 *  watcher's own owner relation, the agent's mailbox (never the owner's inbox), and a non-empty `ownerWords`. */
function confirmedOwnerEmailWords(raw: string | null, askedAtMs: number): string | null {
  let meta: Partial<InboundMeta> | null = null;
  try { meta = raw ? JSON.parse(raw) as Partial<InboundMeta> : null; } catch { return null; }
  if (!meta || meta.channel !== 'email' || meta.relation !== 'owner' || meta.accountKind !== 'agent') return null;
  // The PROVIDER's receive time, never the sender-written Date: an owner email received before the question was asked is not an answer to it.
  if (typeof meta.ownerWordsAt !== 'number' || !(meta.ownerWordsAt >= askedAtMs)) return null;
  return typeof meta.ownerWords === 'string' && meta.ownerWords.trim() !== '' ? meta.ownerWords : null;
}

/** The owner's own words in this row, or null when the row is not the owner writing. */
function ownerWords(m: Row, askedAtMs: number): string | null {
  if (m.channel === 'email') return confirmedOwnerEmailWords(m.inbound_meta, askedAtMs);
  const o = deriveOrigin({
    role: 'user', content: m.content, ...legacyOriginInputs(m.lane, m.channel),
    sourceAgentId: m.source_agent_id, a2aThreadId: m.a2a_thread_id, a2aIntent: m.a2a_intent,
    a2aRequiresResponse: m.a2a_requires_response, inboundMeta: m.inbound_meta, originIntent: m.origin_intent,
  });
  return o.kind === 'user' && o.relation === 'owner' ? stripInboundChannelMarker(m.content) : null;
}

/** The whole message (when it is a statement) and each whole sentence that did not end with a
 *  question mark, normalised. A sentence the owner ended with "?" is a question — it asks, it
 *  does not say — so it is never a quotable approval; statements ending in ".", "!", a newline
 *  or the end of the message still match as before. */
const quotableUnits = (words: string): string[] => {
  const units: string[] = [];
  if (!/\?[.!?\s]*$/.test(words)) units.push(words);
  const parts = words.split(/([.!?]+|\n+)/);
  for (let i = 0; i < parts.length; i += 2) {
    const end = parts[i + 1];
    if (end !== undefined && end.includes('?')) continue;
    if (parts[i].length > 0) units.push(parts[i]);
  }
  return units.map(normalizeQuote).filter((u) => u.length > 0);
};

const ROW_COLS = `content, lane, channel, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response,
            inbound_meta, origin_intent`;
/** The candidate rows: person-authored inbound (role user, through an ingest door, no agent sender). */
const PERSON_INBOUND = "role = 'user' AND channel IS NOT NULL AND source_agent_id IS NULL";

const saidIn = (rows: Row[], q: string, floorMs: number): boolean =>
  rows.some((m) => {
    const words = ownerWords(m, floorMs);
    return words !== null && quotableUnits(words).includes(q);
  });

/** The newest instant the owner was asked about `taskId`, by the ask's own event kind, or null. */
function askedAt(taskId: string, kind: string): number | null {
  const r = getDb().prepare(
    'SELECT MAX(created_at) AS at FROM work_events WHERE work_id = ? AND kind = ?',
  ).get(taskId, kind) as { at: number | null };
  return r.at;
}

/** Did the owner write `q` (normalised) in a message sent at or after `atMs`? */
function ownerSaidSince(atMs: number, q: string): boolean {
  const floor = Math.floor(atMs / 1000) * 1000;   // `sent_at`'s default is second-resolution
  const rows = getDb().prepare(
    `SELECT ${ROW_COLS} FROM messages WHERE ${PERSON_INBOUND} AND sent_at >= ?`,
  ).all(floor) as Row[];
  return saidIn(rows, q, floor);
}

/** Did the owner himself write `quote` (a whole message or sentence), since the verdict on `taskId` was requested? */
export function ownerSaidSinceVerdictAsked(taskId: string, quote: string): boolean {
  const q = normalizeQuote(quote);
  if (!q) return false;
  const at = askedAt(taskId, WORK_EVENT.userVerdictRequested);
  return at !== null && ownerSaidSince(at, q);
}

// v3.5 field fix 3 (owner ruling b): "the owner approved" is accepted only when the owner's words really
// appear in the conversation. The PM review exists so agents cannot close jobs on their own to get out of
// the work, so BOTH owner doors (`apply_user_verdict`, `apply_user_validation`) take their quote through this.
//
// Newer than the ask: the ask is the task's own event (`user_verdict_requested` for a stalemate verdict,
// `validation_escalated` for a validation check). With no ask on record, only the owner's message this turn
// is answering counts, and the owner's later messages in the same conversation: never older history.
export type OwnerQuoteProof = { ok: true } | { ok: false; why: string };

export function ownerQuoteProof(
  taskId: string, ask: 'verdict' | 'validation', agentId: string, quote: string,
): OwnerQuoteProof {
  const q = normalizeQuote(quote);
  if (!q) return { ok: false, why: 'no quote was given' };
  const at = askedAt(taskId, ask === 'verdict' ? WORK_EVENT.userVerdictRequested : WORK_EVENT.validationEscalated);
  if (at !== null) {
    return ownerSaidSince(at, q)
      ? { ok: true }
      : { ok: false, why: 'the quote is not in any message the owner sent after being asked about this task' };
  }
  const root = turnContext(agentId)?.root;
  if (!root || root.kind !== 'ask' || !root.sourceMessageId) {
    return { ok: false, why: 'the owner was never asked about this task and this turn is not answering a message from the owner' };
  }
  const rootRow = getDb().prepare(
    `SELECT ${ROW_COLS}, conversation_id, sent_at FROM messages WHERE id = ? AND ${PERSON_INBOUND}`,
  ).get(root.sourceMessageId) as (Row & { conversation_id: string | null; sent_at: number }) | undefined;
  if (!rootRow || ownerWords(rootRow, rootRow.sent_at) === null) {
    return { ok: false, why: 'the message this turn is answering is not from the owner' };
  }
  const rows = getDb().prepare(
    `SELECT ${ROW_COLS} FROM messages
      WHERE ${PERSON_INBOUND} AND (id = ? OR (conversation_id IS ? AND sent_at >= ?))`,
  ).all(root.sourceMessageId, rootRow.conversation_id, rootRow.sent_at) as Row[];
  return saidIn(rows, q, rootRow.sent_at)
    ? { ok: true }
    : { ok: false, why: 'the quote is not in the owner\'s message this turn is answering' };
}
