// The moment of dispatch: the tool-call broadcast, gate flags, and the other agents'
// destructive-action hold. A held call comes back as `{ state, refusal }`, the refusal being its result.

import { isHealerAgent, isPrimaryAgent } from '../../../../config/platform.js';
import { broadcast } from '../../../../gateway/ws.js';
import { fileHealerApprovalProposal, heldActionSeverity, markHealerProposalAppliedBySignature, maybeAutoApproveHealerScratch } from '../../../../healer/approval-routing.js';
import { consumeApproval, isDestructiveCall, manifestPermitsDestructiveCall, requestApproval } from '../../../destructive-gate.js';
import { isStructuringTool } from '../../classifiers/hoarding.js';
import { canonicalToolSignature } from '../../classifiers/loop.js';
import { advance, type AgentTurnState } from '../../state.js';
import { createLogger } from '../../../../logger.js';
import { redactDeclaredSecretArgs } from '../../../../credentials/secret-fields.js';
import type { ToolCall } from '@dojo/shared';
import type { ExecuteContext, PendingToolResult } from './index.js';

const logger = createLogger('v2-loop');

/** `refusal` non-null means the call was HELD pending approval and this is its result. */
export async function recordDispatchAndHold(
  state: AgentTurnState,
  tc: ToolCall,
  ctx: ExecuteContext,
): Promise<{ state: AgentTurnState; refusal: PendingToolResult | null }> {
  const { agentId, db } = ctx;

  try {
    broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: redactDeclaredSecretArgs(tc.name, tc.arguments) ?? {} });
  } catch { /* best effort */ }
  // The post-compaction recall flag is only cleared here: recall stays an on-demand tool, never
  // auto-injected (an injection bloats the fresh tail and re-triggers compaction).
  if (state.awaitingPostCompactRecall) {
    state = advance(state, { awaitingPostCompactRecall: false, nudgedForPostCompactRecall: true });
  }
  // Flip the structuring flag at dispatch so sibling structuring calls in the same batch satisfy the
  // gate. The heavy-load count ticks on result size, so it lives in post-result.ts.
  if (isStructuringTool(tc.name, tc.arguments)) {
    state = advance(state, { structuringToolCalledThisTurn: true });
  }
  // Every non-primary agent's destructive call is engine-held pending approval (one-shot, signature-bound,
  // 60-min expiry): prose cannot hold this line. The primary is exempt.
  if (!isPrimaryAgent(agentId)) {
    // The caller is passed so the Healer's writes to owner identity/config paths classify as destructive.
    const destructiveKind = isDestructiveCall(tc.name, tc.arguments as Record<string, unknown>, agentId);
    // Hold only a call the agent's own manifest would let run (same check as the executor). A denied
    // call falls through to the executor's [BLOCKED] result: approving it would waste the one-shot.
    if (destructiveKind && manifestPermitsDestructiveCall(agentId, tc.name, tc.arguments as Record<string, unknown>)) {
      const gateSig = canonicalToolSignature(tc.name, tc.arguments);
      // Healer scratch-zone auto-approve: an rm/rmdir strictly inside a scratch zone runs without consent
      // (audited); any miss holds. The denies above already ran, so this only narrows what holds.
      const scratchAutoApproved =
        isHealerAgent(agentId) &&
        maybeAutoApproveHealerScratch({
          agentId,
          toolName: tc.name,
          args: tc.arguments as Record<string, unknown>,
          kind: destructiveKind,
        });
      if (scratchAutoApproved) {
        logger.info('v2: healer scratch-zone destructive auto-approved, executing', {
          tool: tc.name,
        }, agentId);
      } else if (!consumeApproval(agentId, gateSig, JSON.stringify(tc.arguments ?? {}))) {
        const gateAgentRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
        const callDescription = `${tc.name}(${JSON.stringify(tc.arguments).slice(0, 300)})`;
        let refusal: string;
        // A held Healer consent is queued, not an error (only a filing failure is); other holds are errors.
        let heldIsError = true;
        if (isHealerAgent(agentId)) {
          // The Healer answers to the owner: its hold files an owner-approval proposal, not a primary ask.
          const held = await fileHealerApprovalProposal({
            agentId,
            agentName: gateAgentRow?.name ?? agentId,
            toolName: tc.name,
            signature: gateSig,
            kind: destructiveKind,
            argsJson: JSON.stringify(tc.arguments ?? {}),
            heldDirectDestructiveCall: true,
            engineSeverity: heldActionSeverity(JSON.stringify(tc.arguments ?? {})),
          });
          refusal = held.refusal;
          heldIsError = !held.queued;
        } else {
          refusal = await requestApproval({
            agentId,
            agentName: gateAgentRow?.name ?? agentId,
            toolName: tc.name,
            signature: gateSig,
            kind: destructiveKind,
            callDescription,
            argsJson: JSON.stringify(tc.arguments ?? {}),
          });
        }
        try {
          broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: refusal.slice(0, 500) });
        } catch { /* best effort */ }
        return { state, refusal: { toolCallId: tc.id, name: tc.name, content: refusal, isError: heldIsError } };
      } else {
        // Approval consumed: the call is cleared to run exactly once.
        if (isHealerAgent(agentId)) {
          // Mark the proposal applied: the healing cycle stops re-presenting it and a re-issue can't re-hold.
          markHealerProposalAppliedBySignature(agentId, gateSig);
        }
        logger.info('v2: destructive call approved, executing', {
          tool: tc.name,
        }, agentId);
      }
    }
  }
  return { state, refusal: null };
}
