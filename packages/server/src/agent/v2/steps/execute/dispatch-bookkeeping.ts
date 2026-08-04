// ════════════════════════════════════════
// PHASE-6 T7 (CUT 7) — WHAT HAPPENS AT THE MOMENT OF DISPATCH, moved byte-faithfully
// out of `loop.ts`'s `execute` span: the tool-call broadcast, the per-recipient send
// accounting the A2A cap reads, the close-out gate's satisfaction and the thrash
// gate's clear, the post-compaction recall flag, the structuring flag, and the
// DESTRUCTIVE-ACTION GATE — the engine hold that files an approval for every
// non-primary agent's destructive call.
//
// THE ONE CONVERSION is the same as `refusal-gates.ts`: the destructive hold
// returned a tool result straight out of `runOne`, so it comes back as
// `{ state, refusal }` instead. The refusal VALUE is the same bytes.
// ════════════════════════════════════════

import { isHealerAgent, isPrimaryAgent } from '../../../../config/platform.js';
import { broadcast } from '../../../../gateway/ws.js';
import { fileHealerApprovalProposal, markHealerProposalAppliedBySignature, maybeAutoApproveHealerScratch } from '../../../../healer/approval-routing.js';
import { CLOSING_WORK_OPS, SATISFYING_WORK_OPS, toolOpKey } from '../../../../tools/work-verbs.js';
import { consumeApproval, isDestructiveCall, manifestPermitsDestructiveCall, requestApproval } from '../../../destructive-gate.js';
import { isStructuringTool } from '../../classifiers/hoarding.js';
import { canonicalToolSignature } from '../../classifiers/loop.js';
import { advance, type AgentTurnState } from '../../state.js';
import { createLogger } from '../../../../logger.js';
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

  // Broadcast tool call
  try {
    broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
  } catch { /* best effort */ }
  // Track sentToAgentThisTurn for downstream classifiers
  if (tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group') {
    state = advance(state, { sentToAgentThisTurn: true });
    // Count sends per recipient so the A2A re-send cap (above) can refuse
    // a pathological re-send loop once it crosses the per-turn cap.
    const a = (tc.arguments ?? {}) as Record<string, unknown>;
    const recip = String(
      a.to_agent ?? a.agent ?? a.to ?? a.recipient ?? a.group ?? a.group_id ?? '',
    ).trim().toLowerCase();
    if (recip) {
      state = advance(state, {
        sendsPerAgentThisTurn: {
          ...state.sendsPerAgentThisTurn,
          [recip]: (state.sendsPerAgentThisTurn[recip] ?? 0) + 1,
        },
      });
    }
  }
  // ── Close-out gate satisfaction (v2.5.46) ──
  // If the agent is taking a qualifying work action this turn (status
  // update, complete_step, note, close_project), disengage the close-out
  // gate for the remainder of the turn. They can keep resolving the other
  // dangling tasks but they're no longer forced to.
  if (
    state.danglingTaskIds.length > 0 &&
    !state.closeOutGateSatisfied &&
    SATISFYING_WORK_OPS.has(toolOpKey(tc.name, tc.arguments))
  ) {
    state = advance(state, { closeOutGateSatisfied: true });
    logger.info('v2: close-out gate satisfied', { agentId, tool: tc.name }, agentId);
  }
  // Thrash-gate clear on any tracker transition. Any successful status
  // change (complete/blocked/paused/in_progress) is forward progress; the
  // gate's purpose was to force the agent to wrap up, so wrapping up
  // clears it.
  if (
    CLOSING_WORK_OPS.has(toolOpKey(tc.name, tc.arguments)) &&
    (state.thrashGatedSignatures.length > 0 || state.thrashGateRefusalCount > 0 || state.thrashGateActivatedAtLoopCount !== null)
  ) {
    state = advance(state, {
      thrashGatedSignatures: [],
      thrashGateRefusalCount: 0,
      thrashGateActivatedAtLoopCount: null,
    });
    logger.info('v2: thrash gate cleared on tracker transition', { agentId, tool: tc.name }, agentId);
  }
  // ── Post-compaction recall (v2.7.10, auto-injection REMOVED) ──
  //
  // The v2.7.2 hard-intercept that auto-ran recall_recent_thread
  // and pasted ~15K chars of prior thread content as a system
  // message on the next significant tool call has been removed.
  // It was the root cause of context spirals on scheduled
  // multi-task projects (real production failure: 17-email
  // campaign agent kept double-sending and falsely-completing
  // because each compaction triggered a re-injection that bloated
  // the fresh tail, which triggered another compaction, which
  // re-injected even more recent history).
  //
  // recall_recent_thread remains available as a TOOL the agent
  // calls on demand if it actually needs to look up earlier
  // content. The "── Memory Compacted ──" divider still appears
  // so the agent knows compaction happened. No system message
  // gets injected into the message log on its behalf.
  //
  // The awaitingPostCompactRecall flag stays in state for now
  // (dead-ended here) so the flag-arming logic doesn't fail; a
  // later cleanup pass can delete it once we're sure nothing
  // else reads it.
  if (state.awaitingPostCompactRecall) {
    state = advance(state, { awaitingPostCompactRecall: false, nudgedForPostCompactRecall: true });
  }
  // ── Anti-hoarding accounting (v2.5.43) ──
  // Flip the structuring flag the moment the call is dispatched (not
  // after, we want sibling parallel structuring calls in the SAME batch to
  // satisfy the gate). The heavy-LOAD count is NOT incremented here: as of
  // the 2026-07-08 rewrite it ticks on measured RESULT SIZE, which is only
  // known after the executor returns, so it lives at the post-result site
  // below (search "heavyLoadsThisTurn + 1").
  if (isStructuringTool(tc.name, tc.arguments)) {
    state = advance(state, { structuringToolCalledThisTurn: true });
  }
  // ── Destructive-action gate (remediation 4d, open question 6) ──
  // The primary has full reign; every OTHER agent's destructive call
  // is engine-held pending the primary's approval (one-shot,
  // signature-bound, 60-min expiry). Prose cannot hold this line on
  // the weakest model; the gate is the mechanism.
  if (!isPrimaryAgent(agentId)) {
    // FU-4: pass the caller so the Healer's writes to owner identity/config
    // paths classify as destructive (see destructive-gate.ts); for every
    // other agent the third arg changes nothing.
    const destructiveKind = isDestructiveCall(tc.name, tc.arguments as Record<string, unknown>, agentId);
    // FA-P2: only HOLD a destructive call the agent's OWN manifest would
    // actually let run. When the manifest already denies it (e.g. a
    // restricted worker's `rm`, absent from exec_allow), do NOT file an
    // approval the executor's allowlist would reject on retry, that wastes
    // the one-shot approval and dead-ends the worker after telling it
    // approval was granted. Instead we fall through to executeTool below,
    // which returns the standard [BLOCKED] permission-denied result and the
    // permissionAlternativeFinder escalation path (send_to_agent to a
    // privileged agent, request a grant). Only manifest-permitted-but-
    // destructive calls (a destructive git subcommand, or an `rm` a worker
    // explicitly lists) reach the hold below. The pre-check uses the SAME
    // checkPermission the executor uses, so there is no manifest drift.
    if (destructiveKind && manifestPermitsDestructiveCall(agentId, tc.name, tc.arguments as Record<string, unknown>)) {
      const gateSig = canonicalToolSignature(tc.name, tc.arguments);
      // D-B v2 Part 1: Healer scratch-zone auto-approve (engine rule,
      // static, fail-closed). A strictly-parseable rm/rmdir whose every
      // target resolves (hardened canonicalizer) strictly inside a
      // designated scratch zone runs WITHOUT consent, leaving an audit row
      // + a Vitals history record. Any miss holds. Protected-identity and
      // global denies already ran above (isDestructiveCall + the manifest
      // exec check), so this only narrows what holds, never widens what
      // can be deleted.
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
        // Fall through to executeTool: no hold, no consent ask.
      } else if (!consumeApproval(agentId, gateSig, JSON.stringify(tc.arguments ?? {}))) {
        const gateAgentRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
        const callDescription = `${tc.name}(${JSON.stringify(tc.arguments).slice(0, 300)})`;
        let refusal: string;
        // D-B v2 Part 3: a held Healer consent is QUEUED, not an error;
        // the turn continues normally. Only a filing FAILURE is a genuine
        // block (isError). Every OTHER agent keeps the primary-approver
        // path (isError as before).
        let heldIsError = true;
        if (isHealerAgent(agentId)) {
          // D-B step 2: the Healer answers to the OWNER, so its held
          // destructive calls route to a single owner-approval object (a
          // healer_proposals row carrying the bound token + THIS canonical
          // signature), NOT to the primary. Owner approval mints the
          // consumable destructive_approvals row that the retry consumes.
          const held = await fileHealerApprovalProposal({
            agentId,
            agentName: gateAgentRow?.name ?? agentId,
            toolName: tc.name,
            signature: gateSig,
            kind: destructiveKind,
            callDescription,
            argsJson: JSON.stringify(tc.arguments ?? {}),
            heldDirectDestructiveCall: true,
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
          broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
          broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: refusal.slice(0, 500) });
        } catch { /* best effort */ }
        return { state, refusal: { toolCallId: tc.id, name: tc.name, content: refusal, isError: heldIsError } };
      } else {
        // Approval consumed: the call is cleared to run exactly once.
        if (isHealerAgent(agentId)) {
          // D-B step 2: the owner-approved held action just cleared the gate.
          // Record the bound proposal as applied so runHealingCycle stops
          // re-presenting it and a stray re-issue cannot re-hold the now-
          // consumed token into a fresh proposal.
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
