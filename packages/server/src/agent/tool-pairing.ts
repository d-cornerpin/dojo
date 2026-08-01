// ════════════════════════════════════════════════════════════════════════════════════════
// THE tool_use ⇄ tool_result PAIRING REPAIR, at the provider boundary.
//
// Extracted from `agent/model.ts` by PHASE-3 T6, where it was `sanitizeOrphanToolBlocks`,
// and FIXED. Extraction is not tidying: the function was untestable in place (importing
// `model.ts` pulls in the database, the router and four transports), and a repair with no
// unit test is how it shipped with the defect below for as long as it had.
//
// ── THE INVARIANT ───────────────────────────────────────────────────────────────────────
// Every chat API enforces both directions:
//   • every `tool_use` block on an assistant message has a matching `tool_result` in a
//     FOLLOWING user message, and
//   • every `tool_result` block references a `tool_use` on a PRECEDING assistant message.
// Anthropic answers a violation with a 400.
//
// ── THE DEFECT THIS FILE EXISTS TO CLOSE (PHASE-3 T4's day-0 finding, 14 of 17) ──────────
// The old walk collected result ids only from consecutive messages for which
// `isPureToolResultMessage` was true — role user/tool, array content, and EVERY block of
// type `tool_result`. DERIVED, not inferred, by replaying a real divergent assembly
// (receipt `1785562624007-t1649-i1.json`, agent 57b5…, turn 1649, 36 messages) through the
// predicate with each of its four early-outs labelled:
//
//     [28] user      tool_result(dNov4438)
//     [29] assistant tool_use(R9uo8052) + tool_use(fjJ82834)
//     [30] user      tool_result(R9uo8052) + tool_result(fjJ82834) + text
//                    >>> FAILING BRANCH: MIXED-BLOCKS — some block is not tool_result
//
// The text block is `[Jul 31, 2026, 10:37 PM] What's my locker code at the north gym?` —
// the user's next question, folded into the tool-result carrier by the assembler's own
// `mergeConsecutiveRoles` (two consecutive user messages become one). So the walk stopped
// at the very message holding both results, `resultIds` stayed EMPTY, both tool_use blocks
// read as orphans, the assistant message was emptied and SPLICED OUT (36 → 35 messages),
// and the two correctly-paired `tool_result` blocks were left pointing at nothing.
// `assembly-validation.jsonl` recorded the consequence in the same second:
//   tool-result-without-use: tool_result for "call_00_Y6rq…" at message 29 …
//   tool-result-without-use: tool_result for "call_01_gH2m…" at message 29 …
//
// A repair that CREATES the violation it exists to prevent. Two things were wrong and both
// are fixed here:
//
//   1. PURE was the wrong test. The question the walk asks is "does this message answer the
//      tool calls above it", and a message answers them whether or not it also carries
//      text. The discriminator that actually matters — and the one the original comment
//      was reaching for when it said "not a normal user message that happens to follow
//      tool calls" — is "does it CARRY a tool_result at all". A normal user message carries
//      none, so it still stops the walk, and the 2026 parallel-call incident the pure test
//      was written for ("agent repeats itself": N parallel calls answered by N separate
//      consecutive carriers) is preserved exactly, because every one of those carriers
//      carries a tool_result.
//
//   2. THE REPAIR WAS ONE-DIRECTIONAL. Stripping an orphan `tool_use` can strand the
//      `tool_result` that was pointing at it — which is reachable even after fix 1 (results
//      split across a non-carrier: `[assistant use(a,b)][user result(a)][user text]
//      [user result(b)]`). So the pass now closes BOTH directions and its postcondition is
//      asserted by its own tests: after it runs, neither orphan direction exists.
//
// ── WHAT IS DELIBERATELY NOT DONE HERE (#15, recorded rather than acted on) ──────────────
// `memory/assembler.ts`'s `sanitizeToolBlocks` is a SECOND implementation of this same
// invariant, and the two are each correct where the other is wrong: the assembler's version
// handles a mixed carrier correctly (it never required purity) but consults only the SINGLE
// immediately-next message, which is the parallel-call defect this one was fixed for years
// ago. It survives today because `mergeConsecutiveRoles` runs immediately before it and
// folds those consecutive carriers into one message. That is a real fact, not luck — but
// two half-right copies of one invariant is the disease this overhaul exists to end.
// UNIFYING THEM IS A T9 DISPOSITION ITEM, not this task's: the assembler's copy runs inside
// the assembly the golden window measures, and changing it here would put a third,
// unrelated cause inside T6's ONE reviewed re-bless diff.
// ════════════════════════════════════════════════════════════════════════════════════════

export type PairedMessage = { role: string; content: unknown };

const blocksOf = (m: PairedMessage): Array<Record<string, unknown>> | null =>
  Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : null;

/**
 * Does this message CARRY tool results? Exported for the tests that pin the branch above.
 *
 * Not "is it PURELY tool results". See the header: purity was the defect.
 */
export function isToolResultCarrier(m: PairedMessage): boolean {
  if (m.role !== 'user' && m.role !== 'tool') return false;
  const blocks = blocksOf(m);
  if (!blocks || blocks.length === 0) return false;
  return blocks.some((b) => b.type === 'tool_result');
}

export interface PairingRepairReport {
  /** `tool_use` blocks removed because nothing answered them. */
  strippedToolUse: number;
  /** `tool_result` blocks removed because nothing above them asked. */
  strippedToolResult: number;
  /** Messages removed because every block in them was stripped. */
  droppedMessages: number;
}

/**
 * Repair both directions, IN PLACE. In place is the existing contract at both call sites:
 * every transport branch below them reads the same array, so a repair returning a new one
 * would be silently ignored by any branch a later task forgot to re-point.
 */
export function repairToolPairing(messages: PairedMessage[]): PairingRepairReport {
  const report: PairingRepairReport = { strippedToolUse: 0, strippedToolResult: 0, droppedMessages: 0 };

  // ── Direction 1: a tool_use nothing answered ──
  // Backwards, so a splice cannot disturb an index still to be visited.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const blocks = blocksOf(msg);
    if (!blocks) continue;
    const useIds = blocks
      .filter((b) => b.type === 'tool_use' && typeof b.id === 'string')
      .map((b) => b.id as string);
    if (useIds.length === 0) continue;

    // Every consecutive following message that CARRIES results answers these calls.
    const resultIds = new Set<string>();
    for (let j = i + 1; j < messages.length && isToolResultCarrier(messages[j]); j++) {
      for (const b of blocksOf(messages[j]) ?? []) {
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') resultIds.add(b.tool_use_id);
      }
    }

    const orphans = new Set(useIds.filter((id) => !resultIds.has(id)));
    if (orphans.size === 0) continue;

    const kept = blocks.filter((b) => !(b.type === 'tool_use' && orphans.has(b.id as string)));
    report.strippedToolUse += orphans.size;
    if (kept.length === 0) {
      messages.splice(i, 1);
      report.droppedMessages++;
    } else {
      messages[i] = { ...msg, content: kept };
    }
  }

  // ── Direction 2: a tool_result nothing above it asked for ──
  // Run over the POST-direction-1 array, so the repair above cannot leave the orphan it was
  // fixing behind in the other direction. Forwards, accumulating the ids actually offered.
  const offered = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const blocks = blocksOf(msg);
    if (!blocks) continue;
    if (msg.role === 'assistant') {
      for (const b of blocks) if (b.type === 'tool_use' && typeof b.id === 'string') offered.add(b.id);
      continue;
    }
    if (msg.role !== 'user' && msg.role !== 'tool') continue;
    const kept = blocks.filter(
      (b) => !(b.type === 'tool_result' && !(typeof b.tool_use_id === 'string' && offered.has(b.tool_use_id))),
    );
    if (kept.length === blocks.length) continue;
    report.strippedToolResult += blocks.length - kept.length;
    if (kept.length === 0) {
      messages.splice(i, 1);
      report.droppedMessages++;
      i--;
    } else {
      messages[i] = { ...msg, content: kept };
    }
  }

  return report;
}

/**
 * The postcondition, as a predicate rather than a comment: after `repairToolPairing`,
 * neither orphan direction exists. Exported so the tests assert the CONTRACT instead of
 * re-implementing the walk, and so a future caller can assert it too.
 */
export function unpairedToolIds(messages: readonly PairedMessage[]): {
  toolUseWithoutResult: string[];
  toolResultWithoutUse: string[];
} {
  const toolUseWithoutResult: string[] = [];
  const toolResultWithoutUse: string[] = [];
  const offered = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const blocks = blocksOf(messages[i]);
    if (!blocks) continue;
    if (messages[i].role === 'assistant') {
      const answered = new Set<string>();
      for (let j = i + 1; j < messages.length && isToolResultCarrier(messages[j]); j++) {
        for (const b of blocksOf(messages[j]) ?? []) {
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') answered.add(b.tool_use_id);
        }
      }
      for (const b of blocks) {
        if (b.type === 'tool_use' && typeof b.id === 'string') {
          offered.add(b.id);
          if (!answered.has(b.id)) toolUseWithoutResult.push(b.id);
        }
      }
      continue;
    }
    for (const b of blocks) {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string' && !offered.has(b.tool_use_id)) {
        toolResultWithoutUse.push(b.tool_use_id);
      }
    }
  }
  return { toolUseWithoutResult, toolResultWithoutUse };
}
