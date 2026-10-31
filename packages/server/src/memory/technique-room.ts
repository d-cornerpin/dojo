// ════════════════════════════════════════════════════════════════════════════════════════
// THE ROOM A STRONG TECHNIQUE MATCH CAN TAKE (t29 P7, the small-window overruns of P3).
//
// The loop injects a matched technique's whole file after the assembler returns, so the assembler
// could not size it. On a small window (8K to 16K) that injection alone took the array over the
// provider boundary's budget and the boundary repaired the overrun by dropping lanes. The room is
// a measurement, taken the way the task list takes its own (`work-board-lane.ts`
// `activeTasksRoomTokens`): the budget the boundary enforces (the assembly budget minus the system
// prompt), minus everything already on the array or about to join it before the technique does.
// ════════════════════════════════════════════════════════════════════════════════════════

import type { AssembledContext } from './assembler.js';
import { estimateTokens, estimateTokensFromChars } from './budget.js';
import { POST_BUDGET_LANES, renderTokens } from './lanes.js';
import { TECHNIQUE_FRAME_CHARS } from './work-board-lane.js';

const reserveOf = (id: string): number => POST_BUDGET_LANES.find((l) => l.id === id)?.reserveTokens ?? 0;

/**
 * Tokens left for one more message on this assembled turn: the boundary's budget, less the assembled
 * messages, every post-budget block the assembler returned, and the loop's own appends at their
 * declared bounds (`lane.loop-tail`, its other-threads extra, `lane.deliveries`). Never below zero.
 */
export function techniqueRoomTokens(ctx: Pick<AssembledContext,
  'messages' | 'allocation' | 'recallLane' | 'openCommitmentsLane' | 'attemptLedgerLane' | 'activeTasksLane'
  | 'scratchpadLane' | 'eventsLane' | 'integrationStatusLane'>): number | undefined {
  const a = ctx.allocation;
  if (!a) return undefined;   // no allocation report: the caller has no measurement, so it applies no room
  const available = a.budgetTokens + a.offTheTopTokens;
  const blocks = [ctx.recallLane, ctx.openCommitmentsLane, ctx.attemptLedgerLane, ctx.activeTasksLane,
    ctx.scratchpadLane, ctx.eventsLane, ctx.integrationStatusLane];
  const onTheArray = renderTokens(ctx.messages as never) + blocks.reduce((t, b) => t + (b ? estimateTokens(b) : 0), 0);
  const loopAppends = reserveOf('lane.loop-tail') + (a.loopTailExtraTokens ?? 0) + reserveOf('lane.deliveries');
  return Math.max(0, available - onTheArray - loopAppends);
}

/** Does a technique file of `chars` characters, framed, fit the room? No room measured: yes (only the inline cap applies). */
export const techniqueFitsRoom = (chars: number, room: number | undefined): boolean =>
  room === undefined || estimateTokensFromChars(chars + TECHNIQUE_FRAME_CHARS) <= room;
