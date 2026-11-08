// ════════════════════════════════════════
// `preflight` §7b: THE PRE-TURN COMPILE GATE.
//
// The owed compiled reply as a hard precondition: an ask whose delegated pieces are all
// back, whose owner has not been answered, and which the redrive ladder has ALREADY come
// back for. The gate ARMS enforcement (the engine refuses every tool call outside a closed
// allowed set until the reply lands) and OUTPUTS NOTHING — the compile order is already in
// front of the model, quoted verbatim, written by the ladder that spent the rung. A second
// row saying the same thing would be noise, and this gate's whole premise is that the model
// is not reading that kind of instruction.
//
// The gate is never armed on a turn a human is waiting on (the ternary below).
//
// The redrive steers arrive on engine-wake and A2A turns, off the conversation path, which is
// where the owed compile is owed.
// ════════════════════════════════════════

import { createLogger } from '../../../../logger.js';
import { compileOwedAfterRedrive } from '../../compile-owed-gate.js';
import { advance } from '../../state.js';
import type { WaitingConversation } from '../../counterparty.js';
import type { TurnContext } from '../../../turn-context.js';
import type { PreflightContext } from './index.js';

const logger = createLogger('v2-loop');

/** What the sections before this one produced that it reads. */
export interface CompileGateInputs {
  readonly triggerRow: WaitingConversation['latest'];
}

export function runCompileGate(
  turnCtx: TurnContext,
  ctx: PreflightContext,
  input: CompileGateInputs,
): void {
  const { agentId } = ctx;
  try {
    // BUG-2, inherited: `triggerRow` set ⇒ this turn serves a waiting human, by the
    // user-always-wins rule. A compiled reply the ladder is chasing belongs to a DIFFERENT
    // conversation than the one the person in front of us just opened, and refusing the tools
    // that answer them in order to force a reply about something else is the recorded failure.
    const owed = input.triggerRow ? [] : compileOwedAfterRedrive(agentId);
    if (owed.length === 0) return;
    turnCtx.state = advance(turnCtx.state!, { compileOwedAskIds: owed });
    logger.info('v2: pre-turn compile gate armed', {
      agentId, owedCount: owed.length, sample: owed.slice(0, 3).map((id) => id.slice(0, 8)),
    }, agentId);
  } catch (err) {
    // A gate that cannot read what is owed must not refuse on a guess: disarmed for this turn, and the
    // ladder's own rungs still reach the owner.
    logger.warn('v2: owed-compile lookup failed; compile gate disarmed for this turn', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}
