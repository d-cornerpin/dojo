// ════════════════════════════════════════════════════════════════════════════════════════
// THE LANE TAG — which lane produced this message. PHASE-3 T6 (requirements F21 + F23).
//
// ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────────────────
// `AssembledContext.messageEntryIds` has been DECLARED since the registry landed, READ by
// the context receipt and PASSED by the loop, and assigned by NOTHING (research 06 §8,
// re-measured at PHASE-3 T0 and again at T6's own HEAD: five grep hits, not one of them a
// write). Every consumer that wanted to know which lane produced a message therefore
// guessed from the message's own prose — the kit's `check-assembled-context.mjs` carries a
// sixteen-pattern classifier for exactly that reason, and the receipt calls anything it
// cannot pattern-match `organic`, including six engine injections that are the opposite of
// organic.
//
// ── WHY A SYMBOL AND NOT A PARALLEL ARRAY ───────────────────────────────────────────────
// The obvious shape is `string[]` beside `messages[]`. It was rejected on evidence: between
// the lane emit and the provider call the array is FILTERED (a2a-salience dedupe), SPLICED
// (the salience move), MERGED (`mergeConsecutiveRoles` folds two messages into one),
// REBUILT (`sanitizeToolBlocks` returns copies), SHIFTED (the head normalisation) and
// APPENDED to at eight loop-side sites. A parallel array has to be re-indexed correctly at
// every one of those, and the failure mode when it is not is SILENT MISLABELLING — the
// receipt confidently naming the wrong lane, which is worse than the null it replaced.
// (The receipt's existing `length === length` guard exists because whoever declared the
// field already foresaw this.)
//
// The tag rides ON the message instead, under a symbol key, so it moves with the object
// through every one of those operations without anybody re-indexing anything:
//
//   • `JSON.stringify` IGNORES symbol keys — so the tag cannot reach a provider, cannot
//     change the receipt's per-message sha256, and cannot move either prompt golden. That
//     is the property that makes this safe to do at all under the cache-prefix law, and
//     `message-lane-tag.test.ts` pins it rather than trusting it.
//   • Object SPREAD copies own enumerable symbol keys, so `{ ...msg, content: kept }` — the
//     shape `sanitizeToolBlocks`, `mergeConsecutiveRoles` and the integrity pass all use —
//     carries the tag forward for free.
//   • `filter` / `splice` / `push` / `shift` move whole objects and are trivially safe.
//
// A merge is the one lossy case and its rule is DECLARED, not incidental: the surviving
// message keeps the FIRST contributor's tag, because that is the message the merged one is
// positionally standing in for. Where the merged content spans lanes, the receipt shows the
// lane the message BEGAN in — which is the honest answer to "where in the array am I".
//
// ── WHAT UNTAGGED MEANS ─────────────────────────────────────────────────────────────────
// `null`, never a guess. A message with no tag is one no lane claimed, and that is a
// FINDING (it is how a new unowned injection becomes visible in the receipt and in the
// assembled-array golden), not a hole to fill with a pattern match.
// ════════════════════════════════════════════════════════════════════════════════════════

/** The key. Not exported: the only way to read or write a tag is through this module. */
const LANE_TAG = Symbol.for('dojo.messageLaneId');

/** Anything the assembler or the loop treats as a message in the in-flight array. */
type TaggableMessage = object;

/**
 * Tag a message with the lane that produced it. Idempotent per message; the FIRST tag wins,
 * so a later generic pass can never overwrite the specific id an emitter already recorded.
 */
export function tagMessageLane<T extends TaggableMessage>(msg: T, laneId: string): T {
  if (msg == null) return msg;
  const holder = msg as Record<symbol, unknown>;
  if (typeof holder[LANE_TAG] === 'string') return msg;
  holder[LANE_TAG] = laneId;
  return msg;
}

/** Tag every message of a group with one lane id. Returns the same array. */
export function tagMessageLanes<T extends TaggableMessage>(msgs: readonly T[], laneId: string): readonly T[] {
  for (const m of msgs) tagMessageLane(m, laneId);
  return msgs;
}

/** The lane that produced this message, or `null` when no lane claimed it. */
export function messageLaneOf(msg: TaggableMessage | null | undefined): string | null {
  if (msg == null) return null;
  const v = (msg as Record<symbol, unknown>)[LANE_TAG];
  return typeof v === 'string' ? v : null;
}

/**
 * The lane id per message, ALIGNED to `messages` by construction — the array is built FROM
 * the array it describes, so a misalignment is not expressible. This is what the receipt
 * (F21) and `repairAssembly`'s priority map (C10, the Step-2b precondition) both read.
 */
export function collectMessageLaneIds(messages: readonly TaggableMessage[]): (string | null)[] {
  return messages.map((m) => messageLaneOf(m));
}
