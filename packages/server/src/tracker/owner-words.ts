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

interface Row {
  content: string; lane: string; channel: string; source_agent_id: string | null;
  a2a_thread_id: string | null; a2a_intent: string | null; a2a_requires_response: number | null;
  inbound_meta: string | null; origin_intent: string | null;
}

/** The owner's new words in an email row the watcher stamped as the owner's, or null. Every stamp must agree: the
 *  watcher's own owner relation, the agent's mailbox (never the owner's inbox), and a non-empty `ownerWords`. */
function confirmedOwnerEmailWords(raw: string | null): string | null {
  let meta: Partial<InboundMeta> | null = null;
  try { meta = raw ? JSON.parse(raw) as Partial<InboundMeta> : null; } catch { return null; }
  if (!meta || meta.channel !== 'email' || meta.relation !== 'owner' || meta.accountKind !== 'agent') return null;
  return typeof meta.ownerWords === 'string' && meta.ownerWords.trim() !== '' ? meta.ownerWords : null;
}

/** The owner's own words in this row, or null when the row is not the owner writing. */
function ownerWords(m: Row): string | null {
  if (m.channel === 'email') return confirmedOwnerEmailWords(m.inbound_meta);
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

/** Did the owner himself write `quote` (a whole message or sentence), since the verdict on `taskId` was requested? */
export function ownerSaidSinceVerdictAsked(taskId: string, quote: string): boolean {
  const q = normalizeQuote(quote);
  if (!q) return false;
  const asked = getDb().prepare(
    'SELECT MAX(created_at) AS at FROM work_events WHERE work_id = ? AND kind = ?',
  ).get(taskId, WORK_EVENT.userVerdictRequested) as { at: number | null };
  if (asked.at === null) return false;
  const rows = getDb().prepare(
    `SELECT content, lane, channel, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response,
            inbound_meta, origin_intent
       FROM messages
      WHERE role = 'user' AND channel IS NOT NULL AND source_agent_id IS NULL AND sent_at >= ?`,
  ).all(Math.floor(asked.at / 1000) * 1000) as Row[];   // floored to the second: `sent_at`'s default is second-resolution
  return rows.some((m) => {
    const words = ownerWords(m);
    return words !== null && quotableUnits(words).includes(q);
  });
}
