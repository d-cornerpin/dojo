// ════════════════════════════════════════
// PHASE-6 T7 (CUT 7) — EVERYTHING THE ENGINE RECORDS ONCE A RESULT EXISTS, moved
// byte-faithfully out of `loop.ts`'s `execute` span: the cross-turn attempt record
// (Invariant II), the effectful-call counters in memory AND durably, the
// anti-hoarding heavy-load accounting on MEASURED result size, the explicit
// channel-send tracking the end-of-turn reply resolver reads, the resolved-recipient
// send badge, the technique-ack gate's state sync, and the permission-denial
// alternatives appendix.
//
// One file because they are one moment — none of them can run before the result
// exists and none of them decides whether the call runs. `isTrainerOwnTechniquesRead`
// came with them: its only use was here.
// ════════════════════════════════════════

import os from 'node:os';
import path from 'node:path';
import { classifyTool, parseTechniqueFreshRead } from '@dojo/shared';
import type { ToolCall } from '@dojo/shared';
import { isTrainerAgent } from '../../../../config/platform.js';
import { resolveRecipientDisplay } from '../../../../contacts/resolve-recipient.js';
import { redactDeclaredSecretArgs } from '../../../../credentials/secret-fields.js';
import { estimateTokens } from '../../../../memory/budget.js';
import { getFilteredTools } from '../../../tools/surface.js';
import { recipientIdsMatch } from '../../../recipient-identity.js';
import { crossTurnFailureNote, recordToolOutcome } from '../../attempt-record.js';
import { LOADING_RESULT_MIN_TOKENS, isLoadCountExemptRead, isStructuringTool } from '../../classifiers/hoarding.js';
import { canonicalToolSignature } from '../../classifiers/loop.js';
import { permissionAlternativeFinder } from '../../classifiers/permission.js';
import { advance, type AgentTurnState } from '../../state.js';
import { bumpEffectfulCalls } from '../../turn-record.js';
import { createLogger } from '../../../../logger.js';
import { FIRE_AND_FORGET_GEN_TOOLS, SEND_TO_PEOPLE_SET } from './tool-sets.js';
import type { ExecuteContext, PendingToolResult } from './index.js';

const logger = createLogger('v2-loop');

// v2.7.8, anti-hoarding gate carve-out.
//
// Returns true when the trainer agent is reading a file or directory
// INSIDE its own ~/.dojo/techniques tree. Those reads are the trainer's
// core job, auditing scripts, cross-checking TECHNIQUE.md, reviewing
// supporting files, and counting them against the hoarding-gate
// budget produces nonsense like "open a tracker project before you can
// look at your own technique's files." Other agents, other paths, and
// trainer reads OUTSIDE the techniques tree still count normally.
const TECHNIQUES_ROOT = path.join(os.homedir(), '.dojo', 'techniques');
function isTrainerOwnTechniquesRead(
  agentId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
): boolean {
  if (!isTrainerAgent(agentId)) return false;
  if (toolName !== 'file_read' && toolName !== 'file_list') return false;
  const rawPath = typeof args?.path === 'string' ? args.path : null;
  if (!rawPath) return false;
  // Resolve ~ before the prefix check, the trainer often passes
  // ~/.dojo/techniques/... and a literal startsWith on the resolved
  // root would miss it.
  const resolved = rawPath.startsWith('~') ? path.join(os.homedir(), rawPath.slice(1)) : rawPath;
  return resolved.startsWith(TECHNIQUES_ROOT + path.sep) || resolved === TECHNIQUES_ROOT;
}

export async function recordToolResultEffects(
  state: AgentTurnState,
  tc: ToolCall,
  toolResult: PendingToolResult,
  ctx: ExecuteContext,
): Promise<{ state: AgentTurnState; toolResult: PendingToolResult }> {
  const { agentId, turnNumber, db, counterparty, persistRoutingMarker } = ctx;


  // Cross-turn attempt record (Invariant II): failures accumulate in
  // the DB by canonical signature; a success clears its signature.
  // When the SAME call keeps failing across separate turns, the
  // failing result carries a note so the model stops re-trying it
  // verbatim ("works in circles" had no cross-turn guard at all).
  try {
    // T5b: this signature is a DB row under a PRIMARY KEY with no TTL and
    // it is what diagnostics export, so it is built from the persist-side
    // arguments. Two credential_add calls that differ only in the secret
    // now share a signature — which is the right identity for "this call
    // keeps failing", and the service_name that says WHICH one survives.
    const crossTurnSig = canonicalToolSignature(tc.name, redactDeclaredSecretArgs(tc.name, tc.arguments));
    const failCount = recordToolOutcome(agentId, tc.name, crossTurnSig, toolResult.isError === true);
    if (toolResult.isError) {
      const note = crossTurnFailureNote(tc.name, failCount);
      if (note && typeof toolResult.content === 'string') {
        toolResult = { ...toolResult, content: toolResult.content + note };
        logger.warn('v2: cross-turn repeated failure', {
          tool: tc.name, failCount, signature: crossTurnSig.slice(0, 120),
        }, agentId);
      }
    }
  } catch { /* recording is best-effort */ }

  // Success-only, same discipline as the once-guard: a failed call performed no
  // side effect and must not block the abort re-arm.
  const wasEffectful = toolResult.isError !== true &&
    (classifyTool(tc.name) === 'effectful-action' ||
     FIRE_AND_FORGET_GEN_TOOLS.has(tc.name) ||
     SEND_TO_PEOPLE_SET.has(tc.name));
  state = advance(state, {
    toolCallsExecutedThisTurn: state.toolCallsExecutedThisTurn + 1,
    nonIdempotentCallsThisTurn: state.nonIdempotentCallsThisTurn + (wasEffectful ? 1 : 0),
  });
  // T3/P6b: the same increment, DURABLY, in the same breath as the effect. The
  // in-memory counter dies with the process; a kill right here is exactly the case
  // the boot reconciliation has to decide, and it can only decide it from the row.
  if (wasEffectful) bumpEffectfulCalls(agentId, turnNumber);

  // ── Anti-hoarding heavy-load accounting (2026-07-08 measured-size) ──
  // The counter ticks on the MEASURED SIZE of the result's text payload,
  // tool-agnostic: any successful result carrying at least
  // LOADING_RESULT_MIN_TOKENS of text is one heavy load, so a new/unknown
  // reader that returns real corpus counts by construction and there is no
  // LOADING_TOOLS name-set to rot. This also subsumes the old OPEN-16
  // decrement: a FAILED call loaded nothing into context, and now it simply
  // never increments (we only count successful results), so failed retries
  // (e.g. a multi-account outlook_search erroring on a missing `account`)
  // can't pad the count and trip the advisory on a legitimate lookup.
  //
  // We measure the RAW result text (toolResult.content), not the JSON
  // tool_result block the row is persisted as, so it is the actual payload
  // the model reads, not wrapper overhead. Structuring calls and the
  // internal-state reads (own conversation / own tracker, see
  // isLoadCountExemptRead) never count; the trainer-reading-its-own-
  // techniques carve-out (per-agent + per-args) applies here too.
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

  // v2.7.23, track explicit channel-send tool calls so the
  // end-of-turn reply-destination resolver can skip auto-routing
  // for channels the agent already handled directly.
  if (!toolResult.isError) {
    // D16: also record whether the send targeted THIS turn's counterparty.
    // The auto-reply is suppressed on that, not on "any send on the
    // channel", a relay to a 3rd party must not swallow the reply to the
    // person who wrote in. When the counterparty's own recipient is unknown
    // (owner-bound / proactive), fall back to the old suppress-on-any-send.
    if (tc.name === 'imessage_send') {
      const cpRecip = counterparty.kind === 'user' && counterparty.channel === 'imessage' ? counterparty.senderId : null;
      // AUDIT-FIX: an OMITTED recipient defaults to the inbound sender (per the
      // tool contract), so it is counterparty-bound; treating it as a non-match
      // double-messaged the sender (explicit send + end-of-turn auto-route).
      const imArgRecip = tc.arguments?.to ?? tc.arguments?.recipient ?? tc.arguments?.handle;
      const toCp = cpRecip == null || imArgRecip == null || String(imArgRecip).trim() === '' || recipientIdsMatch(imArgRecip, cpRecip);
      state = advance(state, {
        explicitSendThisTurn: { ...state.explicitSendThisTurn, imessage: true },
        repliedToCounterpartyThisTurn: { ...state.repliedToCounterpartyThisTurn, imessage: state.repliedToCounterpartyThisTurn.imessage || toCp },
      });
      // STRIP (T7 Step 2): the cross-recipient iMessage echo. requirement preserved:
      // the deliveries lane (see the STRIP note on the deleted writer).
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
      // STRIP (T7 Step 2): the cross-recipient SMS echo. requirement preserved:
      // the deliveries lane (see the STRIP note on the deleted writer).
    }
    // STRIP (T7 Step 2): the whole `gmail_send`/`outlook_send` branch went with the
    // echo. It existed ONLY to dual-home a fresh email to a non-counterparty — it
    // deliberately did not touch `explicitSendThisTurn` (the email auto-route is
    // reply-only), so with the echo deleted the branch's entire body was the echo
    // call. requirement preserved: the deliveries lane, which records email sends
    // through the same `deliveries` ledger as every other door (PHASE-2 T5).
  }

  // Issue 2 (Path A): label an explicit channel send with the recipient's
  // RESOLVED display name, via the SAME persisted routing marker the
  // auto-route path writes. The dashboard's outbound send bubble then
  // reads "to <name> via <channel>" instead of the raw handle the model
  // passed as the tool argument (observed defect: a saved contact's raw
  // number showed instead of her name). Persisted, so the badge is
  // identical live and on refetch; the client prefers this server-
  // resolved badge over its own tool-input reading, so there is no
  // double label. Skipped for replies (no explicit recipient — the
  // client's channel-only fallback is correct) and for Teams (a chat id,
  // not a name we can resolve without a network call).
  if (!toolResult.isError) {
    try {
      // PHASE-2 T5: the ROW for this send was written at the transport door, inside
      // the scope `executeTool` opened for the tool call — which is why the four-tool
      // list below no longer decides whether a send is recorded. It only decides
      // whether the BADGE can name a resolved recipient, which is all it was ever
      // competent to judge. `gmail_reply`, `outlook_reply`, the forwards, both Teams
      // sends and `voice_call` were the seven that fell off the end of this list and
      // recorded nothing; they are recorded now without appearing here.
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

  // ── Technique-acknowledgement gate state sync (v2.7.6) ──
  // Engage the gate after a successful technique_read / use_technique
  //, UNLESS the agent already has a pending or acknowledged ack
  // for this same technique. The "first read of a new technique"
  // is what needs forced engagement; subsequent reads of the same
  // technique (navigating sections, re-reading after compaction,
  // etc.) are part of working WITH the technique, not loading it
  // fresh, and shouldn't force a re-ack.
  //
  // Match by techniqueId (the slug/id arg the agent passed). Display
  // names can drift; the slug is canonical.
  if (!toolResult.isError) {
    if (tc.name === 'technique_read' || tc.name === 'use_technique') {
      const reqName = typeof tc.arguments?.name === 'string' ? tc.arguments.name : null;
      if (reqName) {
        const alreadyEngaged =
          state.pendingTechniqueAck !== null &&
          state.pendingTechniqueAck.techniqueId === reqName;
        if (alreadyEngaged) {
          // Same technique, gate already on, leave it alone.
          // Agent is still working through the load; one ack
          // covers all subsequent reads of this technique.
        } else {
          // Check whether the agent has ALREADY acknowledged this
          // same technique recently (no pending ack, but this is
          // the same technique they engaged with earlier in the
          // session). We persist the last-acknowledged technique
          // alongside the pending one so re-reads while working
          // don't trigger re-engagement.
          let lastAckedId: string | null = null;
          try {
            const r = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
            const cfg = r?.config ? JSON.parse(r.config) as Record<string, unknown> : {};
            const last = cfg.lastAcknowledgedTechniqueId;
            if (typeof last === 'string') lastAckedId = last;
          } catch { /* config unreadable, treat as no prior ack */ }
          if (lastAckedId === reqName && state.pendingTechniqueAck === null) {
            // Same technique the agent already acked. Don't
            // re-engage the gate, they're navigating around
            // their working technique.
            logger.debug('v2: technique re-read after prior ack, gate NOT re-engaged', {
              agentId, tool: tc.name, techniqueId: reqName,
            }, agentId);
          } else {
            // First read of this technique in this work-stream.
            // Engage the gate.
            let displayName = reqName;
            // PHASE-3 T5 (E19): was byte-identical to assembler.ts's. ONE extractor.
            const freshName = parseTechniqueFreshRead(toolResult.content);
            if (freshName) displayName = freshName;
            const pending = {
              techniqueId: reqName,
              techniqueName: displayName,
              loadedAtIso: new Date().toISOString(),
              fromTurnNumber: turnNumber,
            };
            // D6: track the pending ack IN-MEMORY only for this turn (it
            // no longer blocks anything, and technique_acknowledge stays
            // an optional affordance). NO cross-turn persistence to
            // agents.config, that used to resurrect a global tool lock on
            // an unrelated later turn.
            state = advance(state, { pendingTechniqueAck: pending });
            logger.debug('v2: technique read noted (advisory, non-blocking)', {
              agentId, tool: tc.name, techniqueId: reqName,
            }, agentId);
          }
        }
      }
    } else if (tc.name === 'technique_acknowledge') {
      // Executor already cleared the persisted pending ack.
      // Record this technique as the "last acknowledged" so
      // future re-reads of the same technique don't re-engage
      // the gate (option-a behavior). Sync in-memory state.
      const ackedName = typeof tc.arguments?.name === 'string' ? tc.arguments.name : null;
      if (ackedName) {
        try {
          const r = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
          const cfg = r?.config ? JSON.parse(r.config) as Record<string, unknown> : {};
          // Use the techniqueId from the pendingAck if the ack
          // name resolved to a display name, keeps the
          // re-read match working regardless of which form the
          // agent passes.
          const canonicalId = state.pendingTechniqueAck?.techniqueId ?? ackedName;
          cfg.lastAcknowledgedTechniqueId = canonicalId;
          db.prepare("UPDATE agents SET config = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(cfg), agentId);
        } catch { /* best effort */ }
      }
      if (state.pendingTechniqueAck) {
        state = advance(state, { pendingTechniqueAck: null });
        logger.info('v2: technique-ack gate cleared', { agentId, techniqueId: ackedName }, agentId);
      }
    }
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
