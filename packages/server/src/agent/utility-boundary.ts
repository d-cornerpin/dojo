import { utilityDial, utilityOutputCap } from './utility-dial.js';

// Reserve only what the declared dial may emit (cap, or an ask up to model max); null = reserve untouched.
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
