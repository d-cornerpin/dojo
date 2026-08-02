// ════════════════════════════════════════
// Grounding classifier (OPEN-14)
//
// Catches the worst class of failure for a trusted assistant: telling the user
// it DID something it never did. The observed case — the agent texted "Already
// done. Sent it to <a third party> a minute ago…" with NO send_to_agent / A2A /
// message tool call anywhere in the turn. The third party never got the message;
// the user believed they had.
//
// The engine cannot police every semantic claim, so this is deliberately narrow:
// it fires ONLY on a COMPLETED, PAST-TENSE DELIVERY claim to a NAMED THIRD PARTY
// (relaying/forwarding/notifying someone other than the person being replied to)
// when NO outbound delivery tool fired THIS turn. That is the exact shape of the
// fabrication and it is cheap to detect with high precision.
//
// This is NOT suppression (we never hide the text). On a hit the loop injects a
// one-shot correction and re-enters so the agent either ACTUALLY performs the
// send or corrects the claim — make the bad thing not happen, don't paper over
// it. The correction is phrased so a cross-turn false positive (it really did
// send in an EARLIER turn and is just referencing it) is harmless: "if you
// already did it, confirm and continue."
//
// ── CORRECTION (PHASE-4 T6, 2026-08-02) — EVERYTHING ABOVE DESCRIBES A TRIGGER, AND THIS
//    FILE STOPPED BEING ONE IN T4. Read it as history. ──
// `detectUngroundedDeliveryClaim` is a NARROWING now, not a floor. It answers one question —
// *which recipient does this reply name?* — and `agent/v2/claimed-delivery.ts` then asks the
// LEDGER about that party. Nothing here fires anything: both of that module's arms require a
// ROW (an owed obligation whose counterparty is the named party, or a delivery on this turn
// whose own recorded outcome contradicts the claim).
//
// The reason the paragraph above is dangerous rather than merely stale is the reason this
// phase carries the caution at all: the owner watched this exact prose trigger fire three
// times on the words "told Michael" quoted out of a wedding transcript, each fire ordering
// "do it NOW", producing double answers and a re-done delivery. A comment still teaching
// "high precision, cheap to detect" is a live invitation to the next writer to key an
// honesty floor on prose. Honesty floors are RECEIPT-KEYED, never prose-keyed (research 21,
// binding). Prose may only ever narrow what the ledger is asked about.
// ════════════════════════════════════════

// channelOfSendTool is the canonical send-tool -> channel map in @dojo/shared;
// the delivery predicate below derives from it instead of a hand list.
import { channelOfSendTool } from '@dojo/shared';

/**
 * True when a tool call is an outbound DELIVERY, so a claim of "sent/told/
 * forwarded to <someone>" made this turn is grounded (not a fabrication).
 *
 * DERIVED, not a hand list (2026-07-08 defect-class sweep). The old
 * DELIVERY_TOOLS Set had already drifted, it named `teams_send` and
 * `user_teams_send`, neither of which is a real tool (the real ones are
 * teams_send_message + its user_ twin), while the real long tail was carried
 * by the name-shape heuristic anyway. So the primary signal is now the canonical
 * channelOfSendTool (every real human-facing channel send: iMessage, Teams, SMS,
 * Gmail/Outlook send+reply+forward, voice), plus the two inter-agent sends, plus
 * the SAME name-shape backstop that catches user_ twins and any provider send/
 * reply/forward we didn't anticipate. Over-counting delivery is the SAFE
 * direction here (a missed delivery tool would falsely flag a truthful agent),
 * so the union is deliberately generous.
 */
function isDeliveryTool(name: string): boolean {
  if (channelOfSendTool(name) !== null) return true;
  if (name === 'send_to_agent' || name === 'broadcast_to_group') return true;
  return (
    name.endsWith('_send') ||
    name.endsWith('_reply') ||
    name.includes('send_to') ||
    name.includes('_send_') ||
    name.includes('forward')
  );
}

// Past-tense completed-delivery patterns. The recipient is captured as a proper
// name (leading capital), which structurally excludes "you" / "u" — replying to
// the current person IS the delivery, so we must not flag that.
const DELIVERY_PATTERNS: RegExp[] = [
  // verb … to/with <Name>  ("sent it to Sam", "shared the deck with Alex")
  /\b(?:[Ss]ent|[Tt]exted|[Mm]essaged|[Ee]-?mailed|[Ff]orwarded|[Pp]inged|[Nn]otified|[Rr]elayed|[Ss]hared|[Pp]assed)\b[^.!?\n]{0,30}?\b(?:to|with)\s+([A-Z][a-zA-Z]+)/,
  // verb <Name> directly, for verbs that almost always take a PERSON object
  // ("texted Sam", "emailed Jordan the quote", "told Alex", "notified Pat").
  // 'sent'/'forwarded' are intentionally NOT here — "sent Monday's notes" would
  // false-positive; those stay on the to/with pattern above.
  /\b(?:[Tt]exted|[Mm]essaged|[Ee]-?mailed|[Pp]inged|[Nn]otified|[Tt]old|[Dd][Mm]ed|[Dd]m'?d)\s+([A-Z][a-zA-Z]+)\b/,
  /\b[Ll]et\s+([A-Z][a-zA-Z]+)\s+know\b/,
  /\b[Ll]ooped\s+([A-Z][a-zA-Z]+)\s+in\b/,
  /\b([A-Z][a-zA-Z]+)\s+(?:has been|have been|was|is)\s+(?:notified|messaged|texted|e-?mailed|told|looped in|updated)\b/,
];

// If any of these markers sits just before the match, the claim is FUTURE/intent
// ("I'll let Sam know", "going to text Alex"), not a completed action — skip it.
const FUTURE_MARKERS = /\b(?:i['’]ll|ill|will|won['’]t|going to|gonna|about to|let me|can|could|should|need to|have to|planning to|i['’]ll go|next i)\s*$/i;

// ── RC-12 denial direction ──
// The inverse of the positive guard: the agent DENIES having sent something ("Not
// yet", "haven't sent it", "sending now") when a receipt proves it already did (F-5,
// F-22). Unlike the positive patterns, these are deliberately GENEROUS: the caller
// only steers when the durable receipt ledger confirms a real prior send, so the
// receipt (engine fact) is the true gate and a loose text match here cannot produce
// a spurious steer. Two shapes: (a) a negated/future delivery verb, self-contained;
// (b) a bare "not yet" / "no, not yet", which needs a delivery word elsewhere in the
// text (DELIVERY_CONTEXT) so it doesn't fire on "not yet decided".
const DENIAL_PATTERNS: RegExp[] = [
  // negated past delivery: "haven't sent", "have not texted it", "didn't email"
  /\b(?:have\s*n['’]?t|have not|has\s*n['’]?t|has not|had\s*n['’]?t|did\s*n['’]?t|did not|not)\s+(?:yet\s+)?(?:actually\s+)?(?:\w+\s+){0,2}?(?:sent|texted|e-?mailed|messaged|forwarded|relayed|delivered|pinged|notified|shared)\b/i,
  // in-progress future: "sending it now", "about to send", "will send it now"
  /\b(?:sending|texting|e-?mailing|messaging|forwarding)\s+(?:it\s+|that\s+|them\s+)?(?:now|right now|in a\s+(?:sec|second|minute|moment))\b/i,
  /\b(?:still\s+)?(?:need to|have to|about to|going to|gonna|will|i['’]?ll)\s+(?:\w+\s+){0,2}?(?:send|text|e-?mail|message|forward|relay|deliver)\b/i,
  // bare not-yet (gated by DELIVERY_CONTEXT below)
  /\bno,?\s+not yet\b|\bnot yet\b/i,
];

// A delivery word must be present for a BARE "not yet" to count as a delivery denial.
const DELIVERY_CONTEXT = /\b(?:sent|send|sending|text|texted|texting|e-?mail|e-?mailed|message|messaged|forward|forwarded|deliver|delivered|relay|relayed|passed on|got it to|get it to)\b/i;

// Optional recipient extraction from the denial text ("haven't sent it to Sam yet",
// "did I get it to Nova?"). null when the denial names no one, the caller then
// consults the ledger recipient-agnostically over a short window.
const DENIAL_RECIPIENT = /\b(?:to|for|with)\s+([A-Z][a-zA-Z]+)\b/;

export interface DenialDecision {
  denied: boolean;
  /** A named recipient in the denial text, or null (bare "not yet"). */
  recipient: string | null;
}

/**
 * Returns denied:true when the text reads as a claim that a delivery has NOT (yet)
 * happened. Generous by design; the caller must confirm against the receipt ledger
 * before steering (a denial with no matching receipt is just a truthful "not done").
 */
export function detectDeliveryDenial(input: { responseText: string | null }): DenialDecision {
  const text = input.responseText?.trim();
  if (!text || text.length < 2) return { denied: false, recipient: null };
  let matched = false;
  for (let i = 0; i < DENIAL_PATTERNS.length; i++) {
    const re = DENIAL_PATTERNS[i];
    if (!re.test(text)) continue;
    // The bare not-yet pattern (last) needs a delivery word somewhere in the text.
    if (i === DENIAL_PATTERNS.length - 1 && !DELIVERY_CONTEXT.test(text)) continue;
    matched = true;
    break;
  }
  if (!matched) return { denied: false, recipient: null };
  const rm = DENIAL_RECIPIENT.exec(text);
  return { denied: true, recipient: rm?.[1] ?? null };
}

export interface GroundingInput {
  /** The terminal user-facing text the agent is about to commit. */
  responseText: string | null;
  /** Names of the tools that ran this turn ACROSS ALL iterations (C5: must be the
   *  cumulative activity, not just the terminal iteration's calls — otherwise a real
   *  send made in an earlier iteration is invisible here and the guard false-fires into
   *  a duplicate send). Only the tool NAME is inspected (isDeliveryTool). */
  toolCallsThisTurn: ReadonlyArray<{ name: string }>;
  /** Name of the person THIS turn is replying to — a "delivery" to them is the
   *  reply itself, never a relay, so claims naming them are not fabrications. */
  counterpartyName?: string | null;
}

export type GroundingDecision =
  | { ungrounded: false }
  | { ungrounded: true; recipient: string; verbHint: string };

/**
 * Returns ungrounded:true when the text asserts a completed delivery to a named
 * third party and no delivery tool fired this turn.
 */
export function detectUngroundedDeliveryClaim(input: GroundingInput): GroundingDecision {
  const text = input.responseText?.trim();
  if (!text || text.length < 4) return { ungrounded: false };

  // If a delivery tool fired this turn, any "I sent it" claim is grounded.
  if (input.toolCallsThisTurn.some((tc) => isDeliveryTool(tc.name))) {
    return { ungrounded: false };
  }

  const cpName = (input.counterpartyName ?? '').trim().toLowerCase();

  for (const re of DELIVERY_PATTERNS) {
    const m = re.exec(text);
    if (!m || m.index === undefined) continue;
    const recipient = m[1];
    if (!recipient) continue;
    // Replying to this same person is not a relay.
    if (recipient.toLowerCase() === cpName) continue;
    // Future/intent, not a completed action.
    const before = text.slice(Math.max(0, m.index - 16), m.index);
    if (FUTURE_MARKERS.test(before)) continue;
    return { ungrounded: true, recipient, verbHint: m[0].slice(0, 40) };
  }
  return { ungrounded: false };
}
