// Pre-turn compile gate: when an ask's delegated pieces are all back, its owner is unanswered and the
// redrive ladder already came back for it, the engine refuses tools outside an allowed set until the reply
// lands. It outputs nothing: the ladder's compile order is already in front of the model.

import { createLogger } from '../../../../logger.js';
import { compileOwedAfterRedrive } from '../../compile-owed-gate.js';
import { advance } from '../../state.js';
import type { WaitingConversation } from '../../counterparty.js';
import type { TurnContext } from '../../../turn-context.js';
import type { PreflightContext } from './index.js';

const logger = createLogger('v2-loop');

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
    // A turn serving a waiting human never arms it: the owed reply belongs to another conversation.
    const owed = input.triggerRow ? [] : compileOwedAfterRedrive(agentId);
    if (owed.length === 0) return;
    turnCtx.state = advance(turnCtx.state!, { compileOwedAskIds: owed });
    logger.info('v2: pre-turn compile gate armed', {
      agentId, owedCount: owed.length, sample: owed.slice(0, 3).map((id) => id.slice(0, 8)),
    }, agentId);
  } catch (err) {
    // A gate that cannot read what is owed must not refuse on a guess; the ladder's rungs still run.
    logger.warn('v2: owed-compile lookup failed; compile gate disarmed for this turn', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}
