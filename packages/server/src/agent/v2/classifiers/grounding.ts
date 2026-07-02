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
// ════════════════════════════════════════

/** Outbound delivery tools — a claim of "sent/told/forwarded to <someone>" is
 *  grounded only if one of these fired this turn. */
const DELIVERY_TOOLS = new Set<string>([
  'send_to_agent',
  'broadcast_to_group',
  'imessage_send',
  'sms_send',
  'gmail_send',
  'outlook_send',
  'teams_send',
  'user_gmail_send',
  'user_outlook_send',
  'user_teams_send',
]);

/** Also treat any tool whose name looks like a send/reply/forward as delivery,
 *  so provider tools we didn't enumerate still count (no false fabrication
 *  flags just because a tool isn't in the set above). */
function isDeliveryTool(name: string): boolean {
  if (DELIVERY_TOOLS.has(name)) return true;
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
