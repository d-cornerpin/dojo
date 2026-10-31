import { utilityDial, utilityOutputCap } from './utility-dial.js';

/**
 * t283: the output a utility call can EMIT, which is all the boundary may reserve for it. The agent's
 * everyday reserve (min(4096, model max)) is room for a conversational answer; a title call that is
 * capped at 64 tokens and charged 4,096 has a budget of 0 on any window under ~4.3K. `null` for a
 * call that is not a declared utility dial: it keeps the everyday reserve, untouched.
 */
export function utilityBoundaryOutputTokens(
  purpose: string | null | undefined,
  modelMaxOutputTokens: number,
  callerTargetTokens?: number | null,
  outputRoomAsk?: number | null,
): number | null {
  const dial = utilityDial(purpose);
  if (!dial) return null;
  const asked = Math.min(Math.max(0, outputRoomAsk ?? 0), modelMaxOutputTokens > 0 ? modelMaxOutputTokens : 0);
  return Math.max(utilityOutputCap(dial, callerTargetTokens), asked);
}
