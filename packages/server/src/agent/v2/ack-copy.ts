// Engine ack copy. The engine no longer composes user-facing acks; the agent's own words are
// delivered by the model, steered by the engine floors (steps/assemble/steer-checkpoint.ts): the
// engine never speaks as the agent. The pools below have no sender but a live reader,
// `inbound-courtesy.ts`, which exact-matches their strings coming back IN; they must NEVER change.

export const START_ACK_POOL: readonly string[] = [
  "On it. I'll let you know when it's done.",
  "Working on it now, I'll report back shortly.",
  "Got it, starting on this now.",
  "Picking this up now.",
  "On it, give me a few minutes.",
  "Sure thing, getting started on this.",
  "Alright, I'm on it. I'll circle back when it's ready.",
  "On it now, I'll follow up once it's done.",
  "Cool, diving into this now.",
  "Starting on this, back with you soon.",
];

// Mid-work flavor: the note reads "already in progress", not "starting".
export const PROGRESS_ACK_POOL: readonly string[] = [
  "Quick note, I've got this in progress and I'll let you know when it's done.",
  "Just so you know, I'm working through this now.",
  "Still on this, I'll follow up once it's wrapped up.",
  "Heads up, this is underway. More soon.",
  "Making progress on this, I'll report back when it's done.",
];

export const A2A_HANDOFF_ACK_POOL: readonly string[] = [
  "I've pulled in another agent on part of this and I'll report back as soon as they answer.",
  "Part of this is now with another agent; I'll follow up the moment I hear back.",
  "I've handed a piece of this off and will let you know as soon as the answer comes back.",
];

export const COMPLETION_ACK_POOL: readonly string[] = [
  "Done, that's all wrapped up.",
  "All set, that's finished.",
  "Done, that's taken care of.",
  "Finished, that's done.",
  "Okay, that's complete.",
];

// Promise-floor condition (ONE of several, so it leans toward NOT firing): the reply's LAST
// sentence promises to START with nothing delivered. Shared with the floor's unit test.
const FORWARD_PROMISE_PATTERNS: readonly RegExp[] = [
  /\blet me (?:go |just )?(?:pull|check|get|grab|look|dig|start|put|gather|compile|run)\b/i,
  /\bi(?:'|’)?ll (?:go |just )?(?:pull|check|get|start|put|look|gather|compile|run|do|work)\b/i,
  /\bgive me a (?:sec|second|minute|moment|few)\b/i,
  /\bone (?:sec|second|moment)\b/i,
  /\bhang on\b/i,
  /\bhold on\b/i,
  /\b(?:about|going) to (?:pull|check|get|start|gather|run)\b/i,
  /\bback (?:with you |to you )?(?:shortly|soon|in a (?:bit|minute|few))\b/i,
];

export function isForwardPromiseReply(text: string | null | undefined): boolean {
  if (!text) return false;
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return false;
  // A question anywhere = the reply asked the user something = a valid ending.
  if (s.includes('?')) return false;
  const sentences = s.split(/(?<=[.!])\s+/).map((x) => x.trim()).filter(Boolean);
  const tail = sentences.length > 0 ? sentences[sentences.length - 1] : s;
  // Strip a trailing "let me know" invitation: an offer to hear back, not a promise to act.
  const region = tail.replace(/\blet me know\b.*$/i, '').trim();
  if (!region) return false;
  return FORWARD_PROMISE_PATTERNS.some((re) => re.test(region));
}

// Same floor, other shape: a commitment about EVERY future occasion with nothing durable behind
// it. Scope and commitment must share one sentence; a disclosed inability did the honest half.
const STANDING_SCOPE_PATTERNS: readonly RegExp[] = [
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\bmoving forward\b/i,
  /\bfrom here on(?: out)?\b/i,
  /\b(?:every|each) time\b/i,
  /\bwhenever\b/i,
  /\bany time (?:you|that|there|a|an|the)\b/i,
  /\bin (?:the )?future\b/i,
];
const FIRST_PERSON_COMMITMENT = /\bi(?:'|’)?ll\b|\bi will\b|\bi(?:'|’)?m going to\b/i;
const DISCLOSED_INABILITY =
  /\bi\s(?:can(?:no|’|')?t|cannot|won(?:’|')?t be able|am not able|(?:’|')?m not able|do(?:n(?:’|')?t| not) have)\b/i;

export function isStandingPromiseReply(text: string | null | undefined): boolean {
  if (!text) return false;
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return false;
  if (s.includes('?')) return false;
  if (DISCLOSED_INABILITY.test(s)) return false;
  const sentences = s.split(/(?<=[.!])\s+/).map((x) => x.trim()).filter(Boolean);
  return (sentences.length > 0 ? sentences : [s]).some(
    (sentence) => STANDING_SCOPE_PATTERNS.some((re) => re.test(sentence))
      && FIRST_PERSON_COMMITMENT.test(sentence),
  );
}

// The read-side complement: what the reply ASSERTED about the board, not what it promised.
// Only board vocabulary for PERSISTING or FIRING state is in. Bare "is set for" stays out: a turn says
// "your reminder is set for 7pm" right after the work_open that made it; likewise "still open" and
// "still on"; a bare confirmation with no board contact is NOT caught.
const STANDING_STATE_PATTERNS: readonly RegExp[] = [
  /\bon deck\b/i,
  /\bstill (?:parked|pending|outstanding|owed|queued|scheduled|set|booked|waiting|unresolved|in progress)\b/i,
  /\bschedule (?:is |looks |remains )?intact\b/i,
  /\bwill (?:still )?(?:fire|go off|run|trigger|remind you|nudge you|ping you|kick off)\b/i,
  /\b(?:on|in) (?:the|your) (?:books|board|tracker|calendar|schedule|queue)\b/i,
  /\b(?:remains?|stays?) (?:on|set|scheduled|open|pending|parked|unchanged|in place)\b/i,
];
const DISCLOSED_FROM_MEMORY =
  /\bfrom memory\b|\bgoing (?:off|from) memory\b|\bwithout checking\b|\bnot (?:yet )?verified\b|\b(?:have|has|did|do)(?:n(?:’|')?t| not)\s+(?:re-?)?check(?:ed)?\b|\bi(?:’|')?d need to (?:check|look)\b/i;

/** The sentence asserting STANDING or FUTURE board state, or null: the floor's steer quotes the
 *  CLAIM, so the answer is a sentence, not a boolean. */
export function standingStateClaimSentence(text: string | null | undefined): string | null {
  if (!text) return null;
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (DISCLOSED_FROM_MEMORY.test(s)) return null;
  const sentences = s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  for (const sentence of sentences.length > 0 ? sentences : [s]) {
    if (sentence.includes('?')) continue;
    if (STANDING_STATE_PATTERNS.some((re) => re.test(sentence))) return sentence;
  }
  return null;
}

export function isStandingStateClaimReply(text: string | null | undefined): boolean {
  return standingStateClaimSentence(text) !== null;
}
