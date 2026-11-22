// When a quote is the owner's: `apply_user_verdict` is called by a MODEL with a `user_quote` it supplies, so the
// owner's exemption needs a VERIFIED owner act: after `normalizeQuote` the quote must EQUAL a whole message (or
// whole sentence) the owner wrote since the verdict was asked. A fragment never verifies.
// Whose message: an ingest-door row (it has a channel) on an owner channel, by the stamped origin (`deriveOrigin`).
// Email counts only when the mail watcher stamped `relation: 'owner'` after the provider's DMARC result
// (`services/mail-owner-intake.ts`), and then only the `ownerWords` it stored, never the row's content (a From
// header is nobody authenticated, and replies quote the agent).
import { deriveOrigin, fenceRanges, legacyOriginInputs, stripInboundChannelMarker, type InboundMeta } from '@dojo/shared';
import { getDb } from '../db/connection.js';

export function normalizeQuote(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/[.!?,;:]+$/g, '').trim();
}

interface Row {
  content: string; lane: string; channel: string; source_agent_id: string | null;
  a2a_thread_id: string | null; a2a_intent: string | null; a2a_requires_response: number | null;
  inbound_meta: string | null; origin_intent: string | null; sender_id: string | null;
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

/** A question that asks the agent to act. */
const ASKS_TO_ACT = /\b(?:can|could|would) you\b|\bplease\b/i;

/** The whole message and each whole sentence, normalised. A statement always counts; a question counts only when
 *  it asks the agent to act (words for a control or a hold). With `whole` the one unit is the whole message, and
 *  a question never counts: an approval needs the whole message to approve. */
const quotableUnits = (words: string, whole: boolean): string[] => {
  const counts = (text: string, isQuestion: boolean): boolean => !isQuestion || (!whole && ASKS_TO_ACT.test(text));
  const units: string[] = [];
  if (counts(words, /\?[.!?\s]*$/.test(words))) units.push(words);
  const parts = whole ? [] : words.split(/([.!?]+|\n+)/);
  for (let i = 0; i < parts.length; i += 2) {
    const end = parts[i + 1];
    if (parts[i].length > 0 && counts(parts[i], end !== undefined && end.includes('?'))) units.push(parts[i]);
  }
  return units.map(normalizeQuote).filter((u) => u.length > 0);
};

export const ROW_COLS = `content, lane, channel, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response,
            inbound_meta, origin_intent, sender_id`;
const PERSON_INBOUND = "role = 'user' AND channel IS NOT NULL AND source_agent_id IS NULL";

/** A contact's own words in a row: the text inside its fences, never the platform's lines around them. */
const fencedWords = (content: string): string | null =>
  fenceRanges(content).map((r) => content.slice(r.bodyStart, r.bodyEnd)).join('\n') || null;

interface SaidOpts { whole?: boolean; sender?: string | null }
const saidIn = (rows: Row[], q: string, floorMs: number, { whole = false, sender = null }: SaidOpts): boolean =>
  rows.some((m) => {
    const words = ownerWords(m, floorMs) ?? (sender !== null && m.sender_id === sender ? fencedWords(m.content) : null);
    return words !== null && quotableUnits(words, whole).includes(q);
  });

/** Did the owner write `q` (normalised) as a whole message or sentence to this agent at or after `atMs`?
 *  `whole` asks for the whole message, never a question; `sender` also counts the words that contact wrote in its own rows. */
export function ownerSaidSince(atMs: number, q: string, agentId: string, opts: SaidOpts = {}): boolean {
  const floor = Math.floor(atMs / 1000) * 1000;   // `sent_at`'s default is second-resolution
  const rows = getDb().prepare(
    `SELECT ${ROW_COLS} FROM messages WHERE ${PERSON_INBOUND} AND agent_id = ? AND sent_at >= ?`,
  ).all(agentId, floor) as Row[];
  return saidIn(rows, q, floor, opts);
}
