// What the engine records once a tool result exists: the cross-turn attempt record, effectful-call
// counters, heavy-load accounting, explicit-send tracking, the send badge and permission alternatives.
// None of it can run before the result or decides whether the call runs.

import path from 'node:path';
import type { ToolCall } from '@dojo/shared';
import { isTrainerAgent } from '../../../../config/platform.js';
import { resolveRecipientDisplay } from '../../../../contacts/resolve-recipient.js';
import { redactDeclaredSecretArgs } from '../../../../credentials/secret-fields.js';
import { estimateTokens } from '../../../../memory/budget.js';
import { getFilteredTools } from '../../../tools/surface.js';
import { recipientIdsMatch } from '../../../recipient-identity.js';
import { failureNotes, recordToolOutcome } from '../../attempt-record.js';
import { LOADING_RESULT_MIN_TOKENS, isLoadCountExemptRead, isStructuringTool } from '../../classifiers/hoarding.js';
import { canonicalToolSignature } from '../../classifiers/loop.js';
import { permissionAlternativeFinder } from '../../classifiers/permission.js';
import { advance, type AgentTurnState } from '../../state.js';
import { bumpEffectfulCalls } from '../../turn-record.js';
import { createLogger } from '../../../../logger.js';
import { isEffectfulTool } from './effectful-call.js';
import type { ExecuteContext, PendingToolResult } from './index.js';
import { homeDir } from '../../../../home.js';

const logger = createLogger('v2-loop');

// The trainer reading inside its own ~/.dojo/techniques tree is its core job, so it never counts toward
// the hoarding budget; other agents and other paths count normally.
const TECHNIQUES_ROOT = path.join(homeDir(), '.dojo', 'techniques');
function isTrainerOwnTechniquesRead(
  agentId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
): boolean {
  if (!isTrainerAgent(agentId)) return false;
  if (toolName !== 'file_read' && toolName !== 'file_list') return false;
  const rawPath = typeof args?.path === 'string' ? args.path : null;
  if (!rawPath) return false;
  // Resolve ~ first: the trainer often passes ~/.dojo/techniques/...
  const resolved = rawPath.startsWith('~') ? path.join(homeDir(), rawPath.slice(1)) : rawPath;
  return resolved.startsWith(TECHNIQUES_ROOT + path.sep) || resolved === TECHNIQUES_ROOT;
}

export async function recordToolResultEffects(
  state: AgentTurnState,
  tc: ToolCall,
  toolResult: PendingToolResult,
  ctx: ExecuteContext,
): Promise<{ state: AgentTurnState; toolResult: PendingToolResult }> {
  const { agentId, turnNumber, db, counterparty, persistRoutingMarker } = ctx;


  // Cross-turn attempt record: failures accumulate by canonical signature and a success clears it, so a
  // call that keeps failing across turns carries a note telling the model to stop re-trying it verbatim.
  try {
    // The signature is a persisted row (no TTL, exported by diagnostics), so it is built from redacted
    // args: calls differing only in a secret share one signature.
    const crossTurnSig = canonicalToolSignature(tc.name, redactDeclaredSecretArgs(tc.name, tc.arguments));
    const failCount = recordToolOutcome(agentId, tc.name, crossTurnSig, toolResult.isError === true, typeof toolResult.content === 'string' ? toolResult.content : null);
    if (toolResult.isError) {
      const note = typeof toolResult.content === 'string' ? failureNotes(tc.name, failCount, toolResult.content) : null;
      if (note && typeof toolResult.content === 'string') {
        toolResult = { ...toolResult, content: toolResult.content + note };
        logger.warn('v2: failing result carries an engine note (remedy and/or repeated failure)', {
          tool: tc.name, failCount, signature: crossTurnSig.slice(0, 120),
        }, agentId);
      }
    }
  } catch { /* recording is best-effort */ }

  // Success-only, same discipline as the once-guard: a failed call performed no
  // side effect and must not block the abort re-arm.
  const wasEffectful = toolResult.isError !== true && isEffectfulTool(tc.name);
  state = advance(state, {
    toolCallsExecutedThisTurn: state.toolCallsExecutedThisTurn + 1,
    nonIdempotentCallsThisTurn: state.nonIdempotentCallsThisTurn + (wasEffectful ? 1 : 0),
  });
  // The same increment durably, with the effect: boot reconciliation after a kill can only read the row.
  if (wasEffectful) bumpEffectfulCalls(agentId, turnNumber);

  // Heavy-load accounting: one tick per successful result whose raw text is at least
  // LOADING_RESULT_MIN_TOKENS, whatever the tool; failed calls loaded nothing. Structuring calls,
  // internal-state reads and the trainer's own technique reads never count.
  if (
    !toolResult.isError &&
    !isStructuringTool(tc.name, tc.arguments) &&
    !isLoadCountExemptRead(tc.name, tc.arguments) &&
    !isTrainerOwnTechniquesRead(agentId, tc.name, tc.arguments)
  ) {
    const rawText = typeof toolResult.content === 'string'
      ? toolResult.content
      : JSON.stringify(toolResult.content ?? '');
    if (estimateTokens(rawText) >= LOADING_RESULT_MIN_TOKENS) {
      state = advance(state, { heavyLoadsThisTurn: state.heavyLoadsThisTurn + 1 });
    }
  }

  // Track explicit channel sends so the end-of-turn reply resolver skips channels already handled.
  if (!toolResult.isError) {
    // Also whether it hit this turn's counterparty: a relay to a third party must not swallow the reply.
    if (tc.name === 'imessage_send') {
      const cpRecip = counterparty.kind === 'user' && counterparty.channel === 'imessage' ? counterparty.senderId : null;
      // An omitted recipient defaults to the inbound sender, so it counts as counterparty-bound.
      const imArgRecip = tc.arguments?.to ?? tc.arguments?.recipient ?? tc.arguments?.handle;
      const toCp = cpRecip == null || imArgRecip == null || String(imArgRecip).trim() === '' || recipientIdsMatch(imArgRecip, cpRecip);
      state = advance(state, {
        explicitSendThisTurn: { ...state.explicitSendThisTurn, imessage: true },
        repliedToCounterpartyThisTurn: { ...state.repliedToCounterpartyThisTurn, imessage: state.repliedToCounterpartyThisTurn.imessage || toCp },
      });
    } else if (tc.name === 'teams_send_message') {
      const cpChat = state.inboundContext?.chatId ?? null;
      const teamsArgChat = tc.arguments?.chat_id ?? tc.arguments?.chatId;
      const toCp = cpChat == null || teamsArgChat == null || String(teamsArgChat).trim() === '' || recipientIdsMatch(teamsArgChat, cpChat);
      state = advance(state, {
        explicitSendThisTurn: { ...state.explicitSendThisTurn, teams: true },
        repliedToCounterpartyThisTurn: { ...state.repliedToCounterpartyThisTurn, teams: state.repliedToCounterpartyThisTurn.teams || toCp },
      });
    } else if (tc.name === 'outlook_reply' || tc.name === 'gmail_reply') {
      // A reply targets the inbound thread, so it inherently goes to the counterparty.
      state = advance(state, {
        explicitSendThisTurn: { ...state.explicitSendThisTurn, email: true },
        repliedToCounterpartyThisTurn: { ...state.repliedToCounterpartyThisTurn, email: true },
      });
    } else if (tc.name === 'sms_send') {
      const cpNum = state.inboundContext?.smsFromNumber ?? null;
      const smsArgNum = tc.arguments?.to ?? tc.arguments?.number ?? tc.arguments?.recipient;
      const toCp = cpNum == null || smsArgNum == null || String(smsArgNum).trim() === '' || recipientIdsMatch(smsArgNum, cpNum);
      state = advance(state, {
        explicitSendThisTurn: { ...state.explicitSendThisTurn, sms: true },
        repliedToCounterpartyThisTurn: { ...state.repliedToCounterpartyThisTurn, sms: state.repliedToCounterpartyThisTurn.sms || toCp },
      });
    }
    // Fresh email sends are not tracked here: the email auto-route is reply-only, and the deliveries
    // ledger records them like every other send.
  }

  // Badge an explicit send with the recipient's resolved name via the same persisted routing marker
  // the auto-route writes, identical live and on refetch. Replies and Teams have no resolvable name.
  if (!toolResult.isError) {
    try {
      // The send's delivery row is written at the transport door; this list only decides the badge.
      let sendMarkerLabel: string | null = null;
      if (tc.name === 'imessage_send') {
        const to = String(tc.arguments?.to ?? tc.arguments?.recipient ?? tc.arguments?.handle ?? '').trim()
          || (counterparty.kind === 'user' && counterparty.channel === 'imessage' ? (counterparty.senderId ?? '') : '');
        if (to) sendMarkerLabel = `iMessage to ${resolveRecipientDisplay('imessage', to)}`;
      } else if (tc.name === 'sms_send') {
        const to = String(tc.arguments?.to ?? tc.arguments?.number ?? tc.arguments?.recipient ?? '').trim()
          || (state.inboundContext?.smsFromNumber ?? '');
        if (to) sendMarkerLabel = `SMS to ${resolveRecipientDisplay('sms', to)}`;
      } else if (tc.name === 'gmail_send' || tc.name === 'outlook_send') {
        const to = String(tc.arguments?.to ?? '').trim();
        if (to) sendMarkerLabel = `email to ${resolveRecipientDisplay('email', to)}`;
      }
      if (sendMarkerLabel) persistRoutingMarker(sendMarkerLabel);
    } catch { /* outbound labeling is best-effort; never block a send */ }
  }

  // Permission denial suggestion appendix
  if (toolResult.isError && toolResult.content.includes('[BLOCKED]')) {
    try {
      const { getAgentPermissions } = await import('../../../permissions.js');
      const manifest = getAgentPermissions(agentId);
      const tools = getFilteredTools(agentId);
      const suggestions = permissionAlternativeFinder({
        toolName: tc.name,
        toolArgs: (tc.arguments ?? {}) as Record<string, unknown>,
        denyReason: toolResult.content,
        manifest,
        hasSendToAgent: tools.some((t) => t.name === 'send_to_agent'),
        hasCompleteTask: tools.some((t) => t.name === 'complete_task'),
      });
      if (suggestions.suggestions.length > 0) {
        toolResult = {
          ...toolResult,
          content: `${toolResult.content}\n\nAlternatives:\n${suggestions.suggestions.map((s) => `  • ${s}`).join('\n')}`,
        };
      }
    } catch { /* best effort */ }
  }
  return { state, toolResult };
}
