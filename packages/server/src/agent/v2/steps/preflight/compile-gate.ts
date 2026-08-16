// ════════════════════════════════════════
// UX-REPAIR ROUND 12 T47 — `preflight` §7b: THE PRE-TURN COMPILE GATE, the close-out
// gate's sibling.
//
// The owed compiled reply as a hard precondition: an ask whose delegated pieces are all
// back, whose owner has not been answered, and which the redrive ladder has ALREADY come
// back for. The gate ARMS enforcement (the engine refuses every tool call outside a closed
// allowed set until the reply lands) and OUTPUTS NOTHING — the compile order is already in
// front of the model, quoted verbatim, written by the ladder that spent the rung. A second
// row saying the same thing would be noise, and this gate's whole premise is that the model
// is not reading that kind of instruction.
//
// ⚠ BUG-2 IS INHERITED HERE VERBATIM AND IT IS THE SAME LANE SEPARATION. The gate is NEVER
// armed on a turn a human is waiting on. Its author's words, at
// `steps/preflight/closeout-gate.ts`: armed on a conversation turn the close-out gate
// "(a) DELETED the agent's just-streamed reply and (b) REFUSED the tool calls the agent
// needed to answer" — inv 2 and inv 6 on the weak-model floor. The ternary below is that
// one, copied; the invariant test is that gate's own, EXTENDED to this gate
// (`agent/v2/__tests__/integration.test.ts`, five clauses driving the ENFORCEMENT).
//
// It costs this gate nothing. The redrive steers arrive on engine-wake and A2A turns
// (round-12 S5: turns 4900/4901 kind `a2a`, 4902 kind engine) — the same lane class where
// the close-out gate arms legally. Off the conversation path is exactly where the owed
// compile is owed.
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
    // A gate that cannot read what is owed must not refuse on a guess. Same direction the
    // close-out gate takes for the same failure: disarmed for this turn, and the ladder's own
    // rungs still reach the owner.
    logger.warn('v2: owed-compile lookup failed; compile gate disarmed for this turn', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}
