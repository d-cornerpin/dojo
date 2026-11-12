// The room a strong technique match can take, measured like `work-board-lane.ts` `activeTasksRoomTokens`.

import type { AssembledContext } from './assembler.js';
import { estimateTokens, estimateTokensFromChars } from './budget.js';
import { POST_BUDGET_LANES, renderTokens } from './lanes.js';
import { TECHNIQUE_FRAME_CHARS } from './work-board-lane.js';

const reserveOf = (id: string): number => POST_BUDGET_LANES.find((l) => l.id === id)?.reserveTokens ?? 0;

// Tokens left for one more message on this turn: the boundary's budget less the messages, the post-budget
// blocks and the loop's own appends at their declared bounds. Never below zero.
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

export const techniqueFitsRoom = (chars: number, room: number | undefined): boolean =>
  room === undefined || estimateTokensFromChars(chars + TECHNIQUE_FRAME_CHARS) <= room;
