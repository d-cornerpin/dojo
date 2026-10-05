// ════════════════════════════════════════════════════════════════════════════
// THE SEVENTH COLLECTOR — THE ONE WITH NO TABLE (ritual v3.2.0 round-1 fix)
//
// `collect.ts` holds the six SELECTs. The engine log is the seventh source and it
// is not a table: `readLogEntries` has neither an agent filter nor a window, so the
// narrowing happens HERE, over its output. Split out of `gather.ts` when the
// round-1 review's F4 grew this to more than a one-line `.filter` — and the seam is
// real rather than arithmetic: this is the ONE collector that can read back what
// this very feature wrote, so the rule that stops it is the whole content of the
// file, and `gather.ts` no longer imports the logger at all.
//
//  · A REPORT DOES NOT RE-SWALLOW THE LAST REPORT. `tools/index.ts:220` logs
//    `Executing tool` with every call's ARGUMENTS verbatim, so a `draft` call's
//    five-part write-up (3,596 characters, measured on the dev box) lands in the
//    log and the NEXT gather read it back as evidence. Each report inflated the
//    next — 20 → 66 log entries, 9,333 → 35,994 characters over three attempts —
//    which is why the round's retry lane could not have cleared the red.
//
//  · THE DISCRIMINATOR IS STRUCTURAL: the row's own `meta.tool` field naming this
//    tool. Never a search for prose in the message.
//
//  · ONLY THE PAYLOAD GOES (review F4). The row survives, and so does everything
//    else in its `meta` — including `error`, which on
//    `tools/index.ts:466` ("Tool call rejected by the schema-validation boundary")
//    is the PLATFORM'S own account of why the last `dojo_report` call failed. That
//    sentence is the most useful evidence a report ABOUT this tool can have, and the
//    first cut deleted it. Two fields carry agent or user text and they are the two
//    that go; a row that carried neither is returned untouched, because a note
//    claiming arguments were omitted from a row that never had any is a small lie
//    with the same shape as the big one this round is fixing.
// ════════════════════════════════════════════════════════════════════════════

import { readLogEntries } from '../logger.js';

/** This tool's own name, as the log rows spell it; a clause asks the live registry whether a
 *  tool of this name still exists, so a rename cannot leave this silently matching nothing. */
export const SELF_TOOL = 'dojo_report';

/**
 * The `meta` fields that carry the agent's or the user's own text, and the only ones dropped.
 * `args` is every call's arguments (`Executing tool`); `rawSnippet` is the malformed-argument
 * excerpt (`Rejecting tool call with malformed arguments`). Measured against every
 * `logger.*(… { tool: name, … })` site in `agent/tools/index.ts`, not guessed.
 */
export const SELF_PAYLOAD_FIELDS = ['args', 'rawSnippet'] as const;

/** The log reader's own row shape, taken from the reader rather than imported, so this file
 *  adds no module edge to `@dojo/shared` for a type it already has access to. */
export type LogRow = ReturnType<typeof readLogEntries>[number];

/** One row with this tool's own payload replaced by a reference to it, or the row itself. */
export function withoutOwnPayload(e: LogRow): LogRow {
  if (e.meta?.tool !== SELF_TOOL) return e;
  const dropped = SELF_PAYLOAD_FIELDS.filter(f => e.meta !== undefined && f in e.meta);
  if (dropped.length === 0) return e;
  const meta: Record<string, unknown> = { ...e.meta };
  for (const f of dropped) delete meta[f];
  meta.omitted = `${dropped.join(', ')} — this tool's own payload. A report refers to an earlier `
    + 'report by its id and never re-swallows its text.';
  return { ...e, meta };
}

/** The slice, plus the one thing the rows cannot say for themselves. */
export interface LogSlice {
  rows: LogRow[];
  /**
   * TRUE when the GLOBAL read came back full, so there may be older in-window lines for this
   * agent that were never looked at. Carried out of here because no caller can infer it: the
   * post-filter count and the kept count agree with each other, which is exactly why this gap
   * was silent.
   */
  globalReadSaturated: boolean;
}

/**
 * THIS AGENT'S LOG LINES INSIDE THE WINDOW, NEWEST FIRST, WITH NO REPORT PAYLOAD IN THEM.
 * Filtering the reader's OUTPUT is not a new collector, which is why this is a `.filter` and
 * not SQL. Newest-first is the reader's own order, and it is the order the bound keeps.
 *
 * ── WHY SATURATION IS REPORTED, AND WHY A BIGGER LIMIT IS NOT THE FIX (round-1 review F5) ──
 * `readLogEntries` has no agent filter and no window, so `limit` bounds the GLOBAL read and the
 * narrowing happens after it. On a box busy with other agents those lines can be mostly somebody
 * else's and this agent's in-window lines are never reached. The six SQL collectors cannot do
 * this: their `LIMIT` is applied to rows that already passed the agent filter, so a short section
 * there really does mean a short history.
 *
 * What made it a defect rather than a row cap was the SILENCE. The drop note fires on
 * `kept < collected`, and `collected` is already the post-filter count, so the two numbers agree
 * and NOTHING was said — leaving a reader unable to tell "this agent was quiet" from "the read
 * was full before this agent was reached". Raising the limit moves the number and keeps the
 * property; saying so removes it.
 */
export function agentLogSlice(agentId: string, sinceIso: string, limit: number): LogSlice {
  const read = readLogEntries({ limit });
  return {
    globalReadSaturated: read.length >= limit,
    rows: read
      .filter(e => e.agentId === agentId && e.timestamp >= sinceIso)
      .map(withoutOwnPayload),
  };
}
