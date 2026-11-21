// A narrowing, not a trigger: answers `agent/v2/claimed-delivery.ts` with which
// recipient a completed past-tense delivery claim names. Nothing here fires; both
// ledger arms require a row. Honesty floors are receipt-keyed, never prose-keyed.

import { channelOfSendTool } from '@dojo/shared';

/** Delivery predicate: canonical channelOfSendTool map + name-shape backstop; over-counting is safe. */
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

// Past-tense delivery patterns; recipient captured as a proper name, so "you" cannot match.
const DELIVERY_PATTERNS: RegExp[] = [
  /\b(?:[Ss]ent|[Tt]exted|[Mm]essaged|[Ee]-?mailed|[Ff]orwarded|[Pp]inged|[Nn]otified|[Rr]elayed|[Ss]hared|[Pp]assed)\b[^.!?\n]{0,30}?\b(?:to|with)\s+([A-Z][a-zA-Z]+)/,
  // 'sent'/'forwarded' excluded: "sent Monday's notes" would false-positive on a person-object verb set.
  /\b(?:[Tt]exted|[Mm]essaged|[Ee]-?mailed|[Pp]inged|[Nn]otified|[Tt]old|[Dd][Mm]ed|[Dd]m'?d)\s+([A-Z][a-zA-Z]+)\b/,
  /\b[Ll]et\s+([A-Z][a-zA-Z]+)\s+know\b/,
  /\b[Ll]ooped\s+([A-Z][a-zA-Z]+)\s+in\b/,
  /\b([A-Z][a-zA-Z]+)\s+(?:has been|have been|was|is)\s+(?:notified|messaged|texted|e-?mailed|told|looped in|updated)\b/,
];

// A future/intent marker just before the match means intent, not a completed action.
const FUTURE_MARKERS = /\b(?:i['’]ll|ill|will|won['’]t|going to|gonna|about to|let me|can|could|should|need to|have to|planning to|i['’]ll go|next i)\s*$/i;

// The inverse of the positive guard: denying a send a receipt proves happened.
// Deliberately generous: the receipt ledger, not this text match, is the real gate.
// A bare "not yet" counts only with a delivery word present (DELIVERY_CONTEXT). A promise to send later denies nothing.
const DENIAL_PATTERNS: RegExp[] = [
  /\b(?:have\s*n['’]?t|have not|has\s*n['’]?t|has not|had\s*n['’]?t|did\s*n['’]?t|did not|not)\s+(?:yet\s+)?(?:actually\s+)?(?:\w+\s+){0,2}?(?:sent|texted|e-?mailed|messaged|forwarded|relayed|delivered|pinged|notified|shared)\b/i,
  /\b(?:sending|texting|e-?mailing|messaging|forwarding)\s+(?:it\s+|that\s+|them\s+)?(?:now|right now|in a\s+(?:sec|second|minute|moment))\b/i,
  /\b(?:still\s+)?(?:need to|have to)\s+(?:\w+\s+){0,2}?(?:send|text|e-?mail|message|forward|relay|deliver)\b/i,
  /\bno,?\s+not yet\b|\bnot yet\b/i,
];

const DELIVERY_CONTEXT = /\b(?:sent|send|sending|text|texted|texting|e-?mail|e-?mailed|message|messaged|forward|forwarded|deliver|delivered|relay|relayed|passed on|got it to|get it to)\b/i;

const DENIAL_RECIPIENT = /\b(?:to|for|with)\s+([A-Z][a-zA-Z]+)\b/;

export interface DenialDecision {
  denied: boolean;
  /** A named recipient in the denial text, or null (bare "not yet"). */
  recipient: string | null;
}

export function detectDeliveryDenial(input: { responseText: string | null }): DenialDecision {
  const text = input.responseText?.trim();
  if (!text || text.length < 2) return { denied: false, recipient: null };
  let matched = false;
  for (let i = 0; i < DENIAL_PATTERNS.length; i++) {
    const re = DENIAL_PATTERNS[i];
    if (!re.test(text)) continue;
    if (i === DENIAL_PATTERNS.length - 1 && !DELIVERY_CONTEXT.test(text)) continue;
    matched = true;
    break;
  }
  if (!matched) return { denied: false, recipient: null };
  const rm = DENIAL_RECIPIENT.exec(text);
  return { denied: true, recipient: rm?.[1] ?? null };
}

export interface GroundingInput {
  responseText: string | null;
  /** Tools run this turn across ALL iterations: the cumulative activity, not just the
   *  terminal iteration's. A real send in an earlier iteration must stay visible. */
  toolCallsThisTurn: ReadonlyArray<{ name: string }>;
  counterpartyName?: string | null;
}

export type GroundingDecision =
  | { ungrounded: false }
  | { ungrounded: true; recipient: string; verbHint: string };

export function detectUngroundedDeliveryClaim(input: GroundingInput): GroundingDecision {
  const text = input.responseText?.trim();
  if (!text || text.length < 4) return { ungrounded: false };

  if (input.toolCallsThisTurn.some((tc) => isDeliveryTool(tc.name))) {
    return { ungrounded: false };
  }

  const cpName = (input.counterpartyName ?? '').trim().toLowerCase();

  for (const re of DELIVERY_PATTERNS) {
    const m = re.exec(text);
    if (!m || m.index === undefined) continue;
    const recipient = m[1];
    if (!recipient) continue;
    if (recipient.toLowerCase() === cpName) continue;
    const before = text.slice(Math.max(0, m.index - 16), m.index);
    if (FUTURE_MARKERS.test(before)) continue;
    return { ungrounded: true, recipient, verbHint: m[0].slice(0, 40) };
  }
  return { ungrounded: false };
}
