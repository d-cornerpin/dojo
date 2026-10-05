// ════════════════════════════════════════════════════════════════════════════════════════
// t94 — THE INSTRUMENT. Cross-turn prefix accounting for the assembled message array.
//
// This is the lane's VERDICT MACHINE and it comes before any policy change. It answers two
// questions about every consecutive pair of assemblies:
//
//   (a) APPEND-ONLY — is turn N's serialisation a byte-exact PREFIX of turn N+1's? That is
//       the property a positional prefix cache is a function of: anything else means the
//       provider re-prefills from the first byte that moved.
//   (b) WHERE IT MOVED, ALIGNED BY CONTENT — not by position. The owner's method warning,
//       preserved verbatim in the brief, is that comparing messages BY POSITION is invalid
//       once the array shifts: a front-trim renumbers everything, so a positional diff says
//       "every message changed" and names no cause. Two earlier diagnoses failed exactly
//       there. So this helper finds each of turn N's messages in turn N+1 BY CONTENT, counts
//       how many leading messages genuinely VANISHED, derives the shift of the surviving
//       region, and only then reports the first row whose content truly moved.
//
// The unit of every byte number below is BYTES OF THE SERIALISED MESSAGE ARRAY — the same
// JSON the transport puts on the wire, one canonical line per message. Tokens are not used
// anywhere here on purpose: a token count is an estimate, and the question is what the
// provider has to re-read.
// ════════════════════════════════════════════════════════════════════════════════════════

/** One message, canonicalised to the bytes a positional cache would see. */
export function canonicalMessage(m: unknown): string {
  const msg = m as { role?: unknown; content?: unknown; reasoningContent?: unknown };
  return JSON.stringify({
    role: msg.role,
    content: msg.content,
    ...(msg.reasoningContent ? { reasoningContent: msg.reasoningContent } : {}),
  });
}

/** The whole array as one byte string, newline-joined so a line boundary is a message
 *  boundary and a common-prefix length is readable as "whole messages plus a bit". */
export function serialiseAssembly(messages: readonly unknown[]): string {
  return messages.map(canonicalMessage).join('\n');
}

/**
 * `lane.engine-end-of-history` — `applyIntegrityPass`'s trailing marker, POST_BUDGET_LANES
 * slot 1150. It is framing for the newest exchange, not history, and it necessarily moves to
 * the new end of the array. `the-prefix-holds-still.test.ts` already made this exact call and
 * drops it from the EARLIER side before comparing, rather than exempting it inside the
 * comparison "which would be a hole every future lane could climb through". Same rule here,
 * same reason, same one lane.
 */
const END_OF_HISTORY = '[Engine: end of recorded history.';

export function withoutTrailingMarker(messages: readonly unknown[]): readonly unknown[] {
  const last = messages[messages.length - 1] as { content?: unknown } | undefined;
  return typeof last?.content === 'string' && last.content.startsWith(END_OF_HISTORY)
    ? messages.slice(0, -1)
    : messages;
}

/** Byte-level longest common prefix of two serialisations. */
export function commonPrefixBytes(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

export interface TurnSnapshot {
  /** 1-based turn ordinal, as the driver counted it. */
  turn: number;
  /** The assembled array, already cloned by the caller. */
  messages: readonly unknown[];
  /** `AssembledContext.messageEntryIds`, aligned to `messages`. Lets the instrument NAME the
   *  lane that moved instead of only its index — which is the whole difference between
   *  "something above the conversation moved" and a diagnosis. */
  entryIds?: readonly (string | null)[];
  /** What the driver did between the previous assembly and this one (fictional, G1). */
  note?: string;
}

export interface TurnDelta {
  turn: number;
  note: string;
  msgsBefore: number;
  msgsAfter: number;
  bytesBefore: number;
  bytesAfter: number;
  /** Bytes the two assemblies share from byte 0. */
  commonBytes: number;
  /** What the provider must re-prefill: everything in turn N+1 past the shared prefix. */
  reprefillBytes: number;
  /** True when turn N's array is a byte-exact prefix of turn N+1's. The cache property. */
  appendOnly: boolean;
  /** CONTENT-ALIGNED: how many of turn N's LEADING messages are absent from turn N+1.
   *  This is the front-trim, measured without trusting a single index. */
  droppedFromFront: number;
  /** CONTENT-ALIGNED: how far the surviving region moved (negative = shifted earlier). */
  shift: number;
  /** CONTENT-ALIGNED: index IN TURN N of the first surviving message whose content no
   *  longer matches at its shifted position — the real discontinuity. `null` = none. */
  firstMovedIndex: number | null;
  /** The prompt-registry entry / lane id of that message, when the caller supplied
   *  `entryIds`. Naming the lane is what turns an index into a diagnosis. */
  firstMovedLane: string | null;
  /** How many of turn N's messages survive anywhere in turn N+1. */
  survivors: number;
}

/**
 * The content-aligned diff. Never compares index i to index i.
 *
 * Alignment procedure:
 *   1. Walk turn N from the front until a message whose CONTENT still exists in turn N+1.
 *      The count walked past is `droppedFromFront` — the front-trim, measured by content.
 *   2. `shift` = (that message's index in N+1) − (its index in N). A pure front-trim gives a
 *      negative shift equal to −droppedFromFront; a prefix INSERTION gives a positive one.
 *   3. From the anchor forward, compare N[i] to N+1[i + shift]. The first mismatch is
 *      `firstMovedIndex`: the row that actually moved, as opposed to the rows that were
 *      merely renumbered behind it.
 */
export function diffTurns(before: TurnSnapshot, after: TurnSnapshot): TurnDelta {
  const keysBefore = withoutTrailingMarker(before.messages).map(canonicalMessage);
  const keysAfter = after.messages.map(canonicalMessage);

  const afterIndex = new Map<string, number[]>();
  keysAfter.forEach((k, i) => {
    const at = afterIndex.get(k);
    if (at) at.push(i);
    else afterIndex.set(k, [i]);
  });

  let droppedFromFront = 0;
  let anchorAfter = -1;
  while (droppedFromFront < keysBefore.length) {
    const hits = afterIndex.get(keysBefore[droppedFromFront]);
    if (hits && hits.length > 0) { anchorAfter = hits[0]; break; }
    droppedFromFront++;
  }
  const shift = anchorAfter >= 0 ? anchorAfter - droppedFromFront : 0;

  let firstMovedIndex: number | null = null;
  if (anchorAfter >= 0) {
    for (let i = droppedFromFront; i < keysBefore.length; i++) {
      const j = i + shift;
      if (j < 0 || j >= keysAfter.length || keysAfter[j] !== keysBefore[i]) {
        firstMovedIndex = i;
        break;
      }
    }
  } else if (keysBefore.length > 0) {
    firstMovedIndex = 0;
  }

  const firstMovedLane = firstMovedIndex != null
    ? (before.entryIds?.[firstMovedIndex] ?? null)
    : null;

  const survivors = keysBefore.filter((k) => afterIndex.has(k)).length;

  const sBefore = keysBefore.join('\n');
  const sAfter = keysAfter.join('\n');
  const common = commonPrefixBytes(sBefore, sAfter);

  return {
    turn: after.turn,
    note: after.note ?? '',
    msgsBefore: keysBefore.length,
    msgsAfter: keysAfter.length,
    bytesBefore: sBefore.length,
    bytesAfter: sAfter.length,
    commonBytes: common,
    reprefillBytes: sAfter.length - common,
    appendOnly: common === sBefore.length && sAfter.length >= sBefore.length,
    droppedFromFront,
    shift,
    firstMovedIndex,
    firstMovedLane,
    survivors,
  };
}

/** Every consecutive pair of a run, in order. */
export function runDeltas(snaps: readonly TurnSnapshot[]): TurnDelta[] {
  const out: TurnDelta[] = [];
  for (let i = 1; i < snaps.length; i++) out.push(diffTurns(snaps[i - 1], snaps[i]));
  return out;
}

/** A discontinuity is a turn where the earlier array was NOT a byte prefix of the later. */
export function discontinuities(deltas: readonly TurnDelta[]): TurnDelta[] {
  return deltas.filter((d) => !d.appendOnly);
}

/**
 * The per-turn table the brief asks to be printed. Fictional data only (G1).
 *
 * `rows` is what gets PRINTED (abridge it for a long run); the summary line underneath is
 * always computed over the WHOLE run. Summarising only the printed rows is how an abridged
 * table comes to claim "11 turns compared" about a 47-turn run, which would make the report's
 * own evidence wrong.
 */
export function renderTable(
  title: string,
  deltas: readonly TurnDelta[],
  rowsIn?: readonly TurnDelta[],
): string {
  const rowsToPrint = rowsIn ?? deltas;
  const head =
    `\n${title}\n` +
    `turn │ msgs      │ bytes          │ common  │ re-prefill │ append │ front │ shift │ 1st moved │ lane / note\n` +
    `─────┼───────────┼────────────────┼─────────┼────────────┼────────┼───────┼───────┼───────────┼────────────`;
  const rows = rowsToPrint.map((d) =>
    `${String(d.turn).padStart(4)} │ ` +
    `${String(d.msgsBefore).padStart(3)}→${String(d.msgsAfter).padEnd(5)} │ ` +
    `${String(d.bytesBefore).padStart(6)}→${String(d.bytesAfter).padEnd(7)} │ ` +
    `${String(d.commonBytes).padStart(7)} │ ` +
    `${String(d.reprefillBytes).padStart(10)} │ ` +
    `${(d.appendOnly ? 'yes' : 'NO').padStart(6)} │ ` +
    `${String(d.droppedFromFront).padStart(5)} │ ` +
    `${String(d.shift).padStart(5)} │ ` +
    `${String(d.firstMovedIndex ?? '-').padStart(9)} │ ` +
    `${[d.firstMovedLane, d.note].filter(Boolean).join(' · ')}`,
  );
  const reprefill = deltas.reduce((s, d) => s + d.reprefillBytes, 0);
  const appended = deltas.reduce((s, d) => s + Math.max(0, d.bytesAfter - d.bytesBefore), 0);
  const bad = discontinuities(deltas);
  const summary =
    `\nturns compared: ${deltas.length} · append-only: ${deltas.length - bad.length}` +
    ` · DISCONTINUITIES: ${bad.length}${bad.length ? ` at turns [${bad.map((d) => d.turn).join(', ')}]` : ''}` +
    `\nbytes re-prefilled across the run: ${reprefill}` +
    ` · bytes genuinely appended: ${appended}` +
    ` · waste factor: ${appended > 0 ? (reprefill / appended).toFixed(1) : 'n/a'}×\n`;
  return [head, ...rows, summary].join('\n');
}

/** An abridged table for a long run: the first `head` rows, then every discontinuity with
 *  its neighbours, then the last `tail` rows. Used in the report. */
export function abridge(deltas: readonly TurnDelta[], head = 4, tail = 4): TurnDelta[] {
  const keep = new Set<number>();
  deltas.forEach((d, i) => {
    if (i < head || i >= deltas.length - tail) keep.add(i);
    if (!d.appendOnly) { keep.add(i - 1); keep.add(i); keep.add(i + 1); }
  });
  return deltas.filter((_, i) => keep.has(i));
}
