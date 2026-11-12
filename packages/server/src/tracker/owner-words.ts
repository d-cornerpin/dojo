// When a quote is the owner's: `apply_user_verdict` is called by a MODEL with a `user_quote` it supplies, so the
// owner's exemption needs a VERIFIED owner act: after `normalizeQuote` the quote must EQUAL a whole message (or
// whole sentence) the owner wrote since the verdict was asked. A fragment never verifies.
// Whose message: an ingest-door row (it has a channel) on an owner channel, by the stamped origin (`deriveOrigin`).
// Email counts only when the mail watcher stamped `relation: 'owner'` after the provider's DMARC result
// (`services/mail-owner-intake.ts`), and then only the `ownerWords` it stored, never the row's content (a From
// header is nobody authenticated, and replies quote the agent).
import { deriveOrigin, legacyOriginInputs, stripInboundChannelMarker, type InboundMeta } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { WORK_EVENT } from '../work/tracker-view.js';
import { normalizeQuote } from '../work/row-authority.js';

interface Row {
  content: string; lane: string; channel: string; source_agent_id: string | null;
  a2a_thread_id: string | null; a2a_intent: string | null; a2a_requires_response: number | null;
  inbound_meta: string | null; origin_intent: string | null;
}

/** The owner's new words in an email row the watcher stamped as the owner's, or null; every stamp must agree. */
function confirmedOwnerEmailWords(raw: string | null, askedAtMs: number): string | null {
  let meta: Partial<InboundMeta> | null = null;
  try { meta = raw ? JSON.parse(raw) as Partial<InboundMeta> : null; } catch { return null; }
  if (!meta || meta.channel !== 'email' || meta.relation !== 'owner' || meta.accountKind !== 'agent') return null;
  // The PROVIDER's receive time, never the sender-written Date: an owner email received before the question was asked is not an answer to it.
  if (typeof meta.ownerWordsAt !== 'number' || !(meta.ownerWordsAt >= askedAtMs)) return null;
  return typeof meta.ownerWords === 'string' && meta.ownerWords.trim() !== '' ? meta.ownerWords : null;
}

export function ownerWords(m: Row, askedAtMs: number): string | null {
  if (m.channel === 'email') return confirmedOwnerEmailWords(m.inbound_meta, askedAtMs);
  const o = deriveOrigin({
    role: 'user', content: m.content, ...legacyOriginInputs(m.lane, m.channel),
    sourceAgentId: m.source_agent_id, a2aThreadId: m.a2a_thread_id, a2aIntent: m.a2a_intent,
    a2aRequiresResponse: m.a2a_requires_response, inboundMeta: m.inbound_meta, originIntent: m.origin_intent,
  });
  return o.kind === 'user' && o.relation === 'owner' ? stripInboundChannelMarker(m.content) : null;
}

/** The whole message (when a statement) and each whole sentence not ending in "?", normalised: a
 *  question asks, it does not say, so it is never a quotable approval. */
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
const PERSON_INBOUND = "role = 'user' AND channel IS NOT NULL AND source_agent_id IS NULL";

const saidIn = (rows: Row[], q: string, floorMs: number): boolean =>
  rows.some((m) => {
    const words = ownerWords(m, floorMs);
    return words !== null && quotableUnits(words).includes(q);
  });

function askedAt(taskId: string, kind: string): number | null {
  const r = getDb().prepare(
    'SELECT MAX(created_at) AS at FROM work_events WHERE work_id = ? AND kind = ?',
  ).get(taskId, kind) as { at: number | null };
  return r.at;
}

function ownerSaidSince(atMs: number, q: string, agentId: string): boolean {
  const floor = Math.floor(atMs / 1000) * 1000;   // `sent_at`'s default is second-resolution
  const rows = getDb().prepare(
    `SELECT ${ROW_COLS} FROM messages WHERE ${PERSON_INBOUND} AND agent_id = ? AND sent_at >= ?`,
  ).all(agentId, floor) as Row[];
  return saidIn(rows, q, floor);
}

// A relayed owner decision is verified here: agents must not close jobs themselves.
export type OwnerQuoteProof = { ok: true } | { ok: false; why: string };

export function ownerQuoteProof(taskId: string, quote: string, agentId: string): OwnerQuoteProof {
  const q = normalizeQuote(quote);
  if (!q) return { ok: false, why: 'no quote was given' };
  const at = askedAt(taskId, WORK_EVENT.validationEscalated);
  if (at === null) return { ok: false, why: 'the owner was never asked about this task' };
  return ownerSaidSince(at, q, agentId)
    ? { ok: true }
    : { ok: false, why: 'the quote is not in any message the owner sent you after being asked about this task' };
}
