// The tool_use ⇄ tool_result pairing repair: the one place a block nothing pairs is stripped, run on the
// assembled context (`memory/assembler.ts` applyIntegrityPass) and again at the provider boundary.
// Every chat API enforces both directions: each `tool_use` has a matching `tool_result` in a
// following user message, each `tool_result` references a `tool_use` above it, and a violation
// is a 400. The walk asks whether a message CARRIES a tool_result, never whether it is pure:
// a mixed carrier (results plus the user's own next message) must still be read, or the repair
// creates the violation it exists to prevent. A user message with no tool_result still stops the walk.

export type PairedMessage = { role: string; content: unknown };

const blocksOf = (m: PairedMessage): Array<Record<string, unknown>> | null =>
  Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : null;

/** Does this message CARRY tool results? Exported so the tests pin the carrier rule. */
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

/** Repair both directions, IN PLACE: every transport branch below reads this same array. */
export function repairToolPairing(messages: PairedMessage[]): PairingRepairReport {
  const report: PairingRepairReport = { strippedToolUse: 0, strippedToolResult: 0, droppedMessages: 0 };

  // Direction 1: a tool_use nothing answered. Backwards, so a splice cannot disturb an index still to visit.
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
  // Run over the POST-direction-1 array, forwards, accumulating the ids actually offered.
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
