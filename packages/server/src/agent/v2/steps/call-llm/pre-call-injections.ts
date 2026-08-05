// ════════════════════════════════════════
// PHASE-6 T5 (CUT 5) — WHAT GOES INTO THE CALL, moved from `loop.ts` with its
// bodies byte-unchanged: the pre-flight capability gate, then every VOLATILE
// injection this turn makes — turn-context, the engine-verified outbound facts,
// peer-status, current-time — and the debug-gated context receipt.
//
// ⚠ THIS FILE IS OR7 GROUND. Everything it appends rides the TAIL, past the
// cached prefix, and the ORDER is the contract (roadmap non-negotiable #10,
// research 25). The two golden gates — the assembled-array golden and the
// cache-prefix matrix — ran before the commit that moved it and both reference
// files are byte-unmoved. Nothing here was reordered; the comments that explain
// each position moved with the line they explain.
// ════════════════════════════════════════

import type { ModelCallParams } from '../../../model.js';

/** The array the assembler hands over and the injections append to. */
type ModelMessage = ModelCallParams['messages'][number];
import { advance, type AgentTurnState } from '../../state.js';
import { injectRegistryMessage } from '../../../../prompt/registry/assembler.js';
import type { AssemblyContext } from '../../../../prompt/registry/types.js';
import type { AssembledContext } from '../../../../memory/assembler.js';
import { collectMessageLaneIds } from '../../../../memory/message-lane-tag.js';
import { renderDeliveriesLaneMessage } from '../../../../memory/deliveries-lane.js';
import { buildOpenWorkInjection } from '../../../../work/obligations.js';
import { getRecentOutbound, relativeTimeAgo, channelLabel } from '../../outbound-ledger.js';
import { pushEngineMessage } from '../../engine-message.js';
import { markSteerAttempted, markSteerDelivered } from '../../steer-queue.js';
import { writeContextReceipt } from '../../receipt.js';
import type { TurnCounterparty } from '../../counterparty.js';
import type { SteerEntry } from '../../steer-queue.js';
import type { TurnContext } from '../../../turn-context.js';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../../../../logger.js';

const logger = createLogger('v2-loop');

export interface PreCallInjectionInputs {
  readonly agentId: string;
  readonly turnNumber: number;
  readonly modelId: string;
  readonly messages: ModelMessage[];
  readonly systemPrompt: string;
  readonly ctx: AssembledContext;
  readonly mctx: AssemblyContext;
  readonly volatileFrom: number | undefined;
  readonly counterparty: TurnCounterparty;
  readonly steerAwaitingConfirm: SteerEntry | null;
  readonly turnCtx: TurnContext;
  readonly db: Database;
}

export async function injectAndRecord(
  stateIn: AgentTurnState,
  input: PreCallInjectionInputs,
): Promise<{ state: AgentTurnState; useTools: boolean }> {
  const { agentId, turnNumber, modelId, messages, systemPrompt, ctx, mctx, volatileFrom, counterparty, steerAwaitingConfirm, turnCtx, db } = input;
  let state = stateIn;
  // ── Pre-flight capability enforcement (matches v1 runtime.ts:995) ──
  // Routes images through the fallback vision model when configured
  // (replacing each image block with a text description), or strips
  // them if no fallback is set. Returns useTools=false if model
  // lacks tool support (with banner). Now async because the
  // fallback caption call is a network round-trip.
  const { enforceModelCapabilities } = await import('../../../runtime.js');
  const { useTools } = await enforceModelCapabilities(agentId, modelId, messages);

  // If tools are disabled, inject a one-shot note so the model knows it
  // can only respond with text. Only inject on first iteration when last
  // message is assistant (alternation safety).
  if (!useTools && state.loopCount === 1 && messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
    injectRegistryMessage('msg.tool-note', messages, mctx);
  }

  // Precise clock time as the FINAL message, after every other engine
  // injection, so its per-minute churn falls past the entire cached
  // prefix (system + tools + conversation history + other injections)
  // instead of breaking it. The system prompt carries date-only; this is
  // the live time. Always injected.
  // C28 Part 1: the per-turn routing/presence block (reply destination, the
  // sole routing authority C5, channel landscape, phone conduct, counterparty
  // header, bridge state, waiting/conversational hints) injects HERE, right
  // before current-time, so the volatile route sits past the cached prefix.
  injectRegistryMessage('msg.turn-context', messages, mctx);

  // ── RC-12 / RC-1: engine-verified outbound facts (volatile lane) ──
  // Injected HERE, in the same volatile region as turn-context / current-time
  // (after the fresh tail, past the cached prefix), so they never break the
  // prompt-cache prefix. Human turns only: an engine fact that survives the
  // conversation scoping the model context is subject to, so the model can
  // answer truthfully about what it did send and bind a bare answer to the
  // question it asked. Rebuilt each iteration with the rest of this block, so a
  // single copy lands per model call.
  if (counterparty.kind === 'user') {
    const pendConvId = turnCtx.root?.conversationId ?? null;
    try {
      // RECENT OUTBOUND (RC-12 item 7): the last N sends in 24h, engine-verified.
      // Survives scoping (receipts are not conversation rows), so a denial or a
      // "did you send it" is answerable from fact, not scoped-away memory.
      const recentOut = getRecentOutbound(agentId, 24, 5);
      if (recentOut.length > 0) {
        const outLines = recentOut.map(
          (d) => `${relativeTimeAgo(d.createdAt)} ${channelLabel(d.channel)} -> ${d.recipient ?? 'unknown'}`,
        );
        pushEngineMessage(messages, `RECENT OUTBOUND (engine-verified):\n${outLines.join('\n')}`, 'engine.recent-outbound'); // registry-exempt(2026-07-16): RC-12 receipts block reads per-iteration ledger state; migrate with the volatile-injection registry refactor
      }

      // ── THE DELIVERIES LANE (PHASE-3 T7 Step 1, research 18 §open-1) ──
      // Quote the agent's own recent messages TO THIS counterparty (never another
      // conversation's content) so a bare answer ("5550001234") is bindable even by
      // the weakest model. It reads the `deliveries` rows natively and is DECLARED in
      // the lane table (`lane.deliveries`: position 1860, a 316-token reserve, and a
      // real `truncate()`), which is what lets the cross-conversation ECHO ROW
      // DUPLICATION be stripped in T7 Step 2 — until now those persisted rows were the
      // primary and this header was the fallback they suppressed.
      //
      // The read, the render and the fit live in `memory/deliveries-lane.ts`. What
      // stays HERE is the one thing only the array's holder can answer: is this text
      // already visible? (The echo rows are still being written during T7's quiet
      // window; quoting a row the tail already carries would duplicate it.) When the
      // echo writer dies the predicate stops matching and the lane carries the job
      // whole — nothing else about this site changes.
      mctx.deliveriesLane = renderDeliveriesLaneMessage({
        agentId,
        conversationId: pendConvId,
        counterpartyName: counterparty.name,
        recipientHints: [counterparty.senderId, counterparty.name].filter(
          (h): h is string => !!h && h.trim().length > 0,
        ),
        alreadyVisible: (probe) => probe.length > 0 && messages.some(
          (mRow) => mRow.role === 'assistant' && typeof mRow.content === 'string' &&
            mRow.content.includes('[Sent via') && mRow.content.includes(probe),
        ),
      });
      injectRegistryMessage('msg.deliveries', messages, mctx);
    } catch (err) {
      logger.debug('RC-12/RC-1 volatile outbound injection failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }

    // OPEN WORK (PHASE-2 T7): what this agent still OWES — the current
    // conversation's open asks and commitments first, then up to 3 from other
    // conversations labelled as such. Reads the work spine directly; the rows
    // are created when the obligation is made (4a), so nothing here parses a
    // summary or matches prose. Aged rows are excluded and go to the daily
    // brief instead (4b: ageing demotes, it never closes). Same volatile lane
    // as the outbound facts above, so it never breaks the prompt-cache prefix.
    //
    // Keyed on `conversation_id`, not on `conv_key`: the deleted block compared
    // conv_key strings, which is the column that also carried the claim token
    // and the park sigils, so a parked row changed which party its items
    // belonged to.
    //
    // ── PHASE-6 T13: THIS INJECTION HAS ITS OWN SCOPE, AND ITS OWN FAILURE IS LOUD ──
    // It used to sit inside the best-effort `try` above, under a `catch` that logs at
    // DEBUG and swallows — so a throw in the recent-outbound ledger read or in the
    // deliveries render silently took "what you still owe" off the model's desk, and
    // `buildOpenWorkInjection` was never even CALLED. That is not an equivalence of
    // concerns: those two are enrichments, and this is the mechanism a promise survives
    // a turn BY (`promise-survives-the-turn`'s `inFrontOfModel` clause is exactly this
    // block's own rendering). Whether that swallow fired on the scenario's own red is
    // NOT claimed here — the catch logged at debug, so no record exists either way.
    // What is fixed is that the injection had no independent failure path.
    // WARN, not debug: a person is owed something and the model cannot see it.
    try {
      const openWorkBlock = buildOpenWorkInjection(agentId, pendConvId);
      if (openWorkBlock) pushEngineMessage(messages, openWorkBlock, 'engine.open-work'); // registry-exempt(2026-07-16): the open-work block reads conv-scoped rows mid-iteration; migrate with the volatile-injection registry refactor
    } catch (err) {
      logger.warn('OPEN WORK injection FAILED — work this agent owes is NOT in front of the model this call', {
        agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }

    // RECENTLY ANSWERED (ticket-stamps plan A4, owner-approved): the
    // last few asks of THIS conversation that already have answers,
    // read from the per-ask answer stamps (mig 113), so answered-ness
    // survives compaction structurally and the model never re-answers
    // a settled question. Bounded: 3 lines; human turns; volatile lane.
    if (turnCtx.conversationId) {
      try {
        const answeredAsks = db.prepare(
          `SELECT content, created_at FROM messages
            WHERE agent_id = ? AND conversation_id = ? AND role = 'user'
              AND answer_message_id IS NOT NULL
            ORDER BY created_at DESC LIMIT 3`,
        ).all(agentId, turnCtx.conversationId) as Array<{ content: string; created_at: string }>;
        if (answeredAsks.length > 0) {
          const lines = answeredAsks.map((a) => {
            const excerpt = a.content.replace(/^\[[^\]]*\]\s*/g, '').trim().slice(0, 90);
            return `- answered ${relativeTimeAgo(a.created_at)}: "${excerpt}"`;
          });
          pushEngineMessage(messages, `RECENTLY ANSWERED in this conversation (engine record; do NOT re-execute this work. If asked about it again, a brief restatement of the answer's content is fine, or point at the earlier answer; never silence, and never re-run the work itself):\n${lines.join('\n')}`, 'engine.recently-answered'); // registry-exempt(2026-07-22): reads per-iteration conv-scoped answer stamps; migrate with the volatile-injection registry refactor
        }
      } catch { /* best effort */ }
    }
  }

  // ── RULING P3-R1 (PHASE-3 T3): msg.peer-status, RESTORED. ──
  // The entry has been registered at MessageSlot.PeerStatus (1875) since `5cb1758` and
  // NO injection site has ever existed, so the live idle/working state the 2026-07-16
  // cache fix relocated out of the cached group roster has never reached a model. No
  // decision removed it (#15: the absence is not a ruling) — that commit's own stated
  // intent was to RELOCATE, and the relocation only ever landed its first half.
  // It goes HERE because the near-tail order 1850 -> 1875 -> 1900 is a preserved
  // contract (this phase's Global Constraints): after msg.turn-context, before
  // msg.current-time, behind the cache boundary by construction.
  injectRegistryMessage('msg.peer-status', messages, mctx);

  injectRegistryMessage('msg.current-time', messages, mctx);

  // ── Context receipt (debug-gated, fire-and-forget) ──
  // Last touch point before the provider call: every injector and
  // post-assembly mutation has run, so this records exactly what the
  // model receives this iteration.
  // PHASE-4 T3: DELIVERED-TO-MODEL, RECORDED not assumed — the lane ids are read off the
  // array the provider is handed, so a steer pushed and then dropped is NOT delivered.
  const laneIdsForThisCall = collectMessageLaneIds(messages);
  if (steerAwaitingConfirm) {
    state = advance(state, {
      steerQueue: laneIdsForThisCall.includes('msg.pending-nudge')
        ? markSteerDelivered(state.steerQueue, steerAwaitingConfirm)
        : markSteerAttempted(state.steerQueue, steerAwaitingConfirm),
    });
  }
  writeContextReceipt({
    agentId,
    modelId,
    turnNumber,
    loopCount: state.loopCount,
    systemPrompt,
    messages,
    useTools,
    systemEntryIds: ctx.systemEntryIds,
    // PHASE-3 T6 (F21): read OFF THIS ARRAY, not off `ctx.messageEntryIds` — the
    // assembler's copy stops at `volatileFrom` and would miss every tail-append below.
    messageEntryIds: laneIdsForThisCall,
    volatileFrom,
    // F20/F22: the allocator's own record, and the assembly's own numbers.
    allocation: ctx.allocation,
    freshTailDropped: ctx.freshTailDropped,
    systemVolatileChars: (ctx.systemVolatile ?? '').length,
    reserveTokens: ctx.reserveTokens,
  });

  return { state, useTools };
}
