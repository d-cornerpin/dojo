// ════════════════════════════════════════
// Engine ack copy — WHAT IS LEFT OF IT, AND WHY
//
// ── STRIP: the engine's ack COMPOSITION machinery (PHASE-4 T6, 2026-08-02) ──
// This file used to compose, in the engine's own words, the acknowledgment the person who
// asked was guaranteed to hear — at the start of a project-worthy request and again when the
// work finished. OR2 (owner ruling 2026-07-22) forbids exactly that: the engine never speaks
// as the agent. T4 converted the last five engine-composed user-facing lines; what stood here
// afterwards was the composition apparatus with ZERO readers in either repo.
//
// DELETED, each verified reader-less at this HEAD by a whole-tree walk over dojo AND the kit
// (`git grep -n <name> -- .` in both, 0 hits outside this file):
//   composeStartAck · composeCompletionAck · ComposeStartAckArgs · ComposeCompletionAckArgs ·
//   StartAckPhase · pickStartAck · pickCompletionAck · pickFromPool + its three pick-state
//   objects · modelAckLine · validateAckLine · EMOJI_RE · truncateContext ·
//   DEFAULT_ACK_COMPOSE_TIMEOUT_MS · extractDeliverableLinks · condenseResultProse ·
//   RESULT_PROSE_MAX_CHARS · DELIVERABLE_LINK_LINE_RE · trimUrlTail
//
// THE DELETION DOES NOT REST ON "NO SENDERS LEFT" (roadmap #15). What carries each
// requirement now is a live, tested, driven mechanism, named here rather than assumed:
//   • "the person who asked hears an acknowledgment when their request is judged
//     project-worthy" → the `start-ack` and `start-ack-reminder` FLOORS steer the model, and
//     `loop.ts` delivers the MODEL'S OWN words (`startLine`). Driven at T3 G3: run
//     `bmsbcibqqem`, `startAckDelivered=true (receipt 96d45ab6, agent voice)`.
//   • "…and again when the work finishes" → the `silent-closeout` floor, verified on the
//     delivery ledger (the answered edge) and ghost-recorded when ignored. The old composer's
//     own site in `loop.ts` is now DETECTION: reaching it logs loudly and the ladder drives
//     the agent to speak. Driven at T4-MAIN: "AGENT delivered 4 owner-lane user-visible
//     replies with delivery receipts, engine voice silent".
//   • "a user-triggered turn may never end in silence because work was delegated" (owner law
//     2026-07-09) → the `a2a-handoff-floor`'s two steers + `work_events(kind='floor_ghosted')`.
//   • "the person still needs the DELIVERABLE, and a 200-char slice cut the link in half" →
//     the engine no longer writes that line at all, so there is no engine truncation of a
//     task result to protect. The agent's own reply carries the link, and the silent-closeout
//     floor is what makes sure the reply exists. (Re-verified: no remaining `slice(0, 200)`
//     in the tree feeds a user-facing deliverable line — all ten are logs, audit rows,
//     error text or previews.)
//
// ── WHAT STAYS, AND WHY EACH ONE STAYS ──
// 1. THE FOUR POOLS. They have no SENDER and they do have a live READER:
//    `agent/v2/classifiers/inbound-courtesy.ts:26-29` exact-matches these strings on the way
//    back IN, so a peer box quoting a line this platform once emitted is still recognised as
//    courtesy rather than as a question. #15 forbids resting a deletion on "nobody sends it".
//    The strings are unchanged, deliberately: changing them would blind that classifier to
//    every line already in flight.
// 2. `isForwardPromiseReply` + `FORWARD_PROMISE_PATTERNS`. Live: the promise floor in
//    `loop.ts` and `__tests__/ack-copy.test.ts` share this ONE definition. It is not ack copy
//    at all — it is a reply-shape predicate that happens to live here.
//
// House style for every line here: casual, plain, everyday language; no questions, no emoji,
// no names, no em-dashes.
// ════════════════════════════════════════

// ── Pools ──

// Fresh start: the person just asked, the agent is picking it up.
// Exported (read-only) so the inbound-courtesy classifier can exact-match an
// inbound against our own emitted lines; contents unchanged.
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

// Mid-work flavor: the engine noticed in-flight work is project-worthy and
// opened a task for it, so the note reads "already in progress", not "starting".
export const PROGRESS_ACK_POOL: readonly string[] = [
  "Quick note, I've got this in progress and I'll let you know when it's done.",
  "Just so you know, I'm working through this now.",
  "Still on this, I'll follow up once it's wrapped up.",
  "Heads up, this is underway. More soon.",
  "Making progress on this, I'll report back when it's done.",
];

// ⚠ THIS POOL NO LONGER HAS A SENDER — PHASE-4 T4 (OR2). `pickA2AHandoffAck` is DELETED
// with the line that called it: the engine delivering one of these as an assistant message,
// on the owner's lane, because the model had gone quiet, is the engine wearing the agent's
// face. The A2A-handoff floor steers the agent twice and then records a SYSTEM fault
// (`work_events(kind='floor_ghosted')` + the platform's own owner-alert note) instead.
//
// requirement preserved: "a user-triggered turn may never end in silence because work was
// delegated" (owner law 2026-07-09) is now carried by the floor's two steers, verified on the
// delivery ledger, and by the ghost record when both are ignored — silence still cannot be a
// silent outcome, it simply stops being a sentence the engine writes for the agent.
//
// THE POOL ITSELF STAYS, and #15 is why: `agent/v2/classifiers/inbound-courtesy.ts:28,38`
// exact-matches these strings on the way back IN, so a peer box quoting a line we once emitted
// is still recognised as courtesy rather than as a question. A deletion may not rest on "no
// senders left".
//
// T6's DISPOSITION (2026-08-02), which is what the plan asked this file for: KEEP, unchanged.
// The reader is live and was re-verified at this HEAD; the strings are the classifier's key,
// so editing them would blind it to every line already in flight on a peer box.
export const A2A_HANDOFF_ACK_POOL: readonly string[] = [
  "I've pulled in another agent on part of this and I'll report back as soon as they answer.",
  "Part of this is now with another agent; I'll follow up the moment I hear back.",
  "I've handed a piece of this off and will let you know as soon as the answer comes back.",
];

// Finished. T6 disposition: KEEP as a classifier key, same as the three above — the
// "caller appends the result line" this was shaped for is `composeCompletionAck`, deleted
// with the rest of the composition machinery. Nothing emits these now; the classifier still
// has to recognise them coming back in.
export const COMPLETION_ACK_POOL: readonly string[] = [
  "Done, that's all wrapped up.",
  "All set, that's finished.",
  "Done, that's taken care of.",
  "Finished, that's done.",
  "Okay, that's complete.",
];

// ── Forward-promise detection (promise floor) ──
//
// The last member of the fall-asleep family: a turn whose ENTIRE deliverable is
// a promise to start ("On it. Let me pull up all your calendars.") with no tool
// call and nothing actually done. Every other engine floor keys on tasks or
// deliveries; this one keys on the SHAPE of the reply. Pure + exported so the
// promise floor in loop.ts and its unit test share ONE definition.
//
// Deliberately conservative: this is only ONE of the three conditions the floor
// requires (the others, checked in loop.ts, are a real user trigger and
// negligible work this turn), so it leans toward NOT firing on ambiguous text.
//   - It keys on the LAST sentence (the ending intent), so a reply that promises
//     and then delivers ("Let me check the weather. It is sunny and 72.") reads
//     as a delivery, not a promise.
//   - A question mark ANYWHERE means the reply asked the user something, a
//     legitimate ending, never a promise.
//   - The "let me know" idiom is an invitation, not a promise, and is excluded.
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

/**
 * True when `text` reads as a bare forward promise to START work (with nothing
 * delivered), judged by its ENDING. Pure; the caller pairs it with the other two
 * floor conditions before acting. See FORWARD_PROMISE_PATTERNS above for the
 * conservatism rationale.
 */
export function isForwardPromiseReply(text: string | null | undefined): boolean {
  if (!text) return false;
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return false;
  // A question anywhere = the reply asked the user something = a valid ending.
  if (s.includes('?')) return false;
  // Only the LAST sentence carries the ending intent: a promise that is a
  // preamble the reply then delivers past is not a bare promise.
  const sentences = s.split(/(?<=[.!])\s+/).map((x) => x.trim()).filter(Boolean);
  const tail = sentences.length > 0 ? sentences[sentences.length - 1] : s;
  // Strip a trailing "let me know ..." invitation so it can never BE the match
  // (an offer to hear back, not a promise to go do work now).
  const region = tail.replace(/\blet me know\b.*$/i, '').trim();
  if (!region) return false;
  return FORWARD_PROMISE_PATTERNS.some((re) => re.test(region));
}
