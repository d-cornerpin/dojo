// ════════════════════════════════════════
// PHASE-6 T2 (CUT 9) — `preflight` §5: THE TURN'S CLOSURES.
//
// Eight things the turn hands to the steps after it, and they are FUNCTIONS rather
// than values on purpose: the C4 stranded-ask re-arm, the C3 continuation stash, the
// two row-writers (`persistRoutingMarker`, `persistAndBroadcastSystemRow`), the
// truthful-answer key's ONE setter, the two per-turn registers, and the engine ack.
//
// ⚠ TWO OF THESE READ THE TURN'S STATE **LIVE**, which is the other half of this
// tranche's carrier. `reArmIfStrandedNoAnswer` reads four fields that all move during
// the turn — by value `nonIdempotentCallsThisTurn` is frozen at 0, so every abort
// reads as a clean retry and an ask is re-served AFTER the email was sent. A function
// VALUE keeps the bindings it closed over, so passing these preserves live-read
// semantics by construction; what could NOT be preserved by value is the `state` they
// close over, and that is why it is on the bag.
//
// `terminalAnswerRowId` — the truthful-answer key this file's ONE setter writes — is
// on `PreflightScratch`, because §9's `teardownContext` reads it LIVE at call time,
// after every statement of the turn has had its chance to set it.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { formatRoutingMarker, type DisplayKind } from '@dojo/shared';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { resolveRecipientDisplay } from '../../../../contacts/resolve-recipient.js';
import { continuationContext } from '../../../turn-state.js';
import type { TurnContext } from '../../../turn-context.js';
import { type RepeatCallState } from '../../identical-call-brake.js';
import type { TurnCounterparty } from '../../counterparty.js';
import { withOutboundAsync } from '../../outbound.js';
import type { PreflightContext, PreflightScratch } from './index.js';

const logger = createLogger('v2-loop');

/** What the sections before this one produced that it reads. */
export interface TurnClosuresInputs {
  readonly counterparty: TurnCounterparty;
  readonly chosenConvKey: string;
  readonly chosenConversationId: string | null;
  readonly turnNumber: number;
  readonly revertTriggerStampOnAbort: () => void;
}

/** What this section hands the sections after it, and — for all but the two
 *  registers — the rest of the turn. */
export interface TurnClosuresOutputs {
  readonly reArmIfStrandedNoAnswer: () => void;
  readonly stashContinuationIfHuman: () => void;
  readonly persistRoutingMarker: (label: string) => void;
  readonly persistAndBroadcastSystemRow: (content: string) => string;
  readonly noteTerminalAnswer: (rowId: string, surface: string) => void;
  readonly identicalCallState: RepeatCallState;
  readonly reminderLaneRefusedSigs: Set<string>;
  readonly deliverEngineUserAck: (
    text: string, originIntent?: string | null, reuseId?: string | null, displayKind?: DisplayKind | null,
  ) => Promise<void>;
}

export function runTurnClosures(
  turnCtx: TurnContext,
  ctx: PreflightContext,
  sc: PreflightScratch,
  input: TurnClosuresInputs,
): TurnClosuresOutputs {
  const { agentId } = ctx;
  const { counterparty, chosenConvKey, chosenConversationId, turnNumber, revertTriggerStampOnAbort } = input;
  // C4: re-arm a stranded human ask on a CLEAN-RETRY no-answer break. A deliberate
  // `break` that ends a turn with the trigger still stamped-served (at pickup) strands a
  // human ask that got no answer, it is never re-served (inv 2). This reverts the pickup
  // stamp so the runtime drain re-serves it, but ONLY when the turn is a clean retry:
  //   - no user-facing text (lastAssistantTextForIM), and
  //   - no surfaced reply, and
  //   - no delivery-tool send (explicitSendThisTurn), and
  //   - no NON-IDEMPOTENT execution (nonIdempotentCallsThisTurn === 0; P6b
  //     refinement of the old any-tools-at-all clause, which stranded asks on
  //     purely read-only turns).
  // The last clause is the correctness-critical one: a break after a real side
  // effect (created a task, wrote a file, sent a message) must never re-serve,
  // that would DUPLICATE the effect. Reads/lookups load context and nothing
  // else, so re-serving after them is a safe transient-empty retry. The
  // "did work but didn't reply" cases are owned by the note-then-stopped /
  // going-idle nudges, not by re-serving. Bounded by MAX_DRAIN_STUCK.
  // D8: on an ENGINE turn the same call also reverts the engine-event claim and
  // records the failed delivery (attempt counter + backoff), so an empty give-up
  // turn can't strand a reminder as "processed"; bounded by the 5-attempt lifecycle.
  const reArmIfStrandedNoAnswer = () => {
    if (
      !turnCtx.state!.lastAssistantTextForIM &&
      !turnCtx.state!.surfacedReplyThisTurn &&
      !Object.values(turnCtx.state!.explicitSendThisTurn).some(Boolean) &&
      turnCtx.state!.nonIdempotentCallsThisTurn === 0
    ) {
      revertTriggerStampOnAbort();
    }
  };

  // C3: before an engine auto-continue (MAX_TOOL_LOOPS / time-budget / emergency-compact /
  // block), stash the human conversation this turn is serving so the continuation turn, 
  // which fires with an EMPTY trigger and thus has no waiting human, restores it and
  // delivers the final answer to the right person/channel instead of suppressing it as
  // background chatter (see continuationContext). No-op on a non-human turn (chosenConvKey
  // null). On a continuation-of-a-continuation, chosenConvKey is the restored value, so it
  // re-stashes and the chain holds.
  const stashContinuationIfHuman = () => {
    if (chosenConvKey) continuationContext.set(agentId, { convKey: chosenConvKey, conversationId: chosenConversationId, counterparty });
  };

  // Persist + broadcast an outbound routing marker (a role='system'
  // `[Reply routed via <label>]` row). The dashboard hides the raw row and turns
  // it into a "to <recipient> via <channel>" badge on the preceding assistant
  // bubble (parseOutboundRouting + outboundBadge). ONE writer, shared by the
  // engine-ack channel pushes (deliverEngineUserAck, below) and the end-of-turn
  // reply-destination resolver, so every outbound delivery is labeled
  // identically and an engine-sent line is never an unlabeled bubble in the
  // owner's stream (the observed defect). The <label> always carries the
  // recipient the sender actually resolved (e.g. `iMessage to <name>`), never a
  // bare channel word.
  // P6b-2: the marker is the user-visible VIEW; the deliveries ROW is the RECORD everything
  // load-bearing reads.
  //
  // PHASE-2 T5: THIS FUNCTION NO LONGER WRITES THAT ROW. It used to take the delivery facts
  // as a parameter and insert them itself — which is how the ledger came to hold 44 rows of
  // one tool, every one of them written by a caller that had already decided the send worked.
  // A caller cannot know that; only the transport can. The row is now written by the door the
  // send passes through, inside the outbound scope each site below declares, and what is left
  // here is exactly what it should always have been: the badge the owner sees.
  const persistRoutingMarker = (label: string): void => {
    const tagId = uuidv4();
    const tagContent = formatRoutingMarker(label);
    insertMessageIfAbsent({ id: tagId, agentId, role: 'system', content: tagContent, turnNumber });
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id: tagId, agentId, role: 'system' as const,
        content: tagContent,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
  };

  // T9 (research 17 D4 — "reload-only rows"): the mirror image of the empty-bubble hack.
  // Three engine steers below each INSERTED a role='system' row and told nobody, so wordy
  // mode showed them after a refresh and never live. This helper is the pairing, in one
  // place, so it cannot come apart again. It adds NO new text: regular mode hides every
  // role='system' row (the client short-circuits before classification), so the only view
  // that changes is wordy — which now matches its own reload.
  const persistAndBroadcastSystemRow = (content: string): string => {
    const rowId = uuidv4();
    insertMessageIfAbsent({ id: rowId, agentId, role: 'system', content, turnNumber });
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id: rowId, agentId, role: 'system' as const, content,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
    return rowId;
  };

  // ── STRIP (PHASE-3 T7 Step 2, 2026-08-01) — `persistCrossConvSendEcho` and its three call
  // sites are DELETED. RC-1 dual-homed a cross-recipient send by PERSISTING A SECOND ROW: when
  // the agent asked Sam a question while replying to Maya, the sent text lived only in Maya's
  // tool rows, `scopeToHumanConversation` correctly kept it out of Sam's next turn, and Sam
  // then answered a question with no visible trace of ever being asked. The repair duplicated
  // the message into Sam's conversation. It worked, and it was a duplicate mechanism: history
  // the platform had already recorded, written a second time in a different shape, then re-read
  // as history and re-billed inside the fresh tail on every turn until it aged out — and it
  // could never be truncated, because it was indistinguishable from a real message.
  //
  // requirement preserved: (1) THE RECIPIENT'S NEXT TURN SEES THE QUESTION IT WAS ASKED —
  // `memory/deliveries-lane.ts` (T7 Step 1), which reads the `deliveries` rows natively for
  // the conversation being served, carries up to three of them newest-first against a declared
  // 316-token reserve, and renders the one-row case as RC-1's header byte for byte. Its
  // no-bleed half — a question asked in another conversation never surfaces here — is pinned by
  // `deliveries-lane.test.ts` "a send into ANOTHER conversation never surfaces on this turn",
  // written BEFORE this deletion. (2) THE SEND STAYS VISIBLE IN THE DASHBOARD FEED —
  // `persistRoutingMarker` (below), persisted and broadcast for exactly the three send families
  // this echo covered.
  //
  // Measured on this body at the strip: `SELECT COUNT(*) FROM messages WHERE
  // origin_intent='cross_conv_send_echo'` -> 0. That is an ABSENCE, not evidence of death
  // (#15): the writer was alive and this dev box simply never made a cross-recipient channel
  // send. The positive evidence is the named replacement above, not the row count.

  // ── Engine-enforced human acknowledgment (NEXT-WAVE item 1) ──
  // When the multistep classifier deems a user request tracker-project-worthy,
  // the person who asked MUST hear "on it" when the work starts and "done" when
  // it finishes, EVERY time, regardless of what the floor model chooses to emit
  // (architecture rule 1: the engine enforces correctness, it never relies on
  // the model obeying a prompt). The nudge-only path (BOOKKEEPING_NUDGE) failed
  // in production: the floor model ignored it and ended the turn on a
  // send_to_agent A2A, so the owner heard nothing on a real backup+reset job.
  //
  // This helper delivers ONE plain, user-voiced ack immediately to the person's
  // ACTUAL channel: the dashboard broadcast is universal, and for a live
  // iMessage / phone / SMS counterparty we also push it straight to that channel
  // so an away user hears it now, not only when they open the dashboard. It is
  // an assistant-role message (a real thing the agent said), NOT engine
  // suppression of the model's own reply. Fires only for user counterparties;
  // A2A / engine turns never reach the classifier that calls it.
  // PHASE-6 T6 (CUT 8): the delivery latch and its partner `deferredDeliveredByAck` MOVED to
  // the turn's bag — `postCallClassify` WRITES both and the wall-clock timer READS the first
  // at fire time, which by value would double-ack. Reasons at the fields (RULING P6-R3(1)).
  // Start-ack steer lifecycle (owner ruling 2026-07-22): requested (async-safe
  // intent set by the timer/first-tool hook) -> armed (steer injected at a loop
  // boundary, state write is loop-synchronous) -> delivered (the model's own
  // line surfaced via the capture site). The engine never composes the line.
  // PHASE-4 T3: `nudgedForGoingIdleWithInProgressThisTurn` carried TWO jobs — the steer's
  // one-shot latch (now the queue entry) and "the detector ran", read by the recurring-
  // dangler hardcap on the branch that deliberately does not steer. Only the first latched.
  // PHASE-6 T6 (CUT 8): on the turn's bag — read and written inside the `postCallClassify`
  // span, and it must survive the ITERATION. See the field.
  // PHASE-6 T4 (CUT 6): the four F10 start-ack steer locals MOVED to the turn's bag —
  // one mechanism, split across four spans, and the request flag is written from the
  // wall-clock TIMER below, which is the by-value test's own disqualifier. The cap
  // (2: first steer, one reminder) and the loop index the first steer rode are bounded
  // state, not a snapshot. Reasons at the fields (RULING P6-R3(1)).
  // originIntent stamps a machine-readable marker on the ack row so consumers
  // (the delivery-time ask settlement, the completion-ack cross-turn dedup, the
  // PM poke chain, the F10 replied-check) recognize a start-ack STRUCTURALLY
  // instead of by copy prefix, which is what lets the wording vary freely.
  // origin_kind is deliberately left NULL: `deriveOrigin` keys engine-origin off
  // origin_kind, so the row is still the agent speaking.
  //
  // ⚠ CORRECTED, UX-REPAIR T2 (2026-08-09). This block used to say "the display
  // classifier ignores origin_intent on assistant rows" and "the start-ack sites
  // pass 'engine_start_ack' explicitly". BOTH were false at the tree that carried
  // them: `shared/visibility.ts` classifies ANY origin_intent-stamped owner-lane
  // assistant row `fallback` (its own comment names the start-ack, from the era
  // when the ack WAS engine-composed), and there were ZERO production writers of
  // the value — the ONE caller passed null, which is the whole reason an ask could
  // be closed on an "On it".
  //
  // What is true now: there is exactly ONE production writer (the promoted start
  // line, `post-call-classify/terminal-text.ts`), it passes the intent AND an
  // explicit `displayKind: 'agent-text'`, and the explicit kind is what keeps the
  // row reading as ordinary agent speech. That is deliberate rather than
  // incidental: PHASE-4 T4 converted this lane to the model's own words, so
  // `agent-text` is the TRUTHFUL class and the `fallback` arm — kept intact for
  // the intents that really are engine-composed — is bypassed by declaration, not
  // by being weakened.
  //
  // originIntent still defaults to null so a non-ack caller (e.g. the thrash-block
  // user notice) keeps origin_intent NULL and stays a substantive reply.
  // Captured text-with-tools that MIGHT be the user's genuine answer (set by the
  // demotion block, consumed by G-SUP-2 / the start-ack / the [no-reply]
  // promotion). Declared HERE, above the ack closures, so the start-ack timer
  // can capture it (2026-07-16, the trivial-save sequence).
  // PHASE-6 T9 (CUT 4), RULING P6-R3(1): on the turn's bag — it crosses into the
  // `finalize` span, where G-SUP-2 recovers it. The declaration comment above kept a
  // reason that had stopped being true (the start-ack timer no longer reads it; that
  // branch was retired 2026-07-23); the measurement is recorded at the field.
  // Ghosted-work-ask floor (2026-07-22): the multistep classifier's verdict on
  // THIS turn's inbound, so the [no-reply] handling can tell a work ask (silence is
  // never valid) from chatter (silence is fine). 'user_creating_explicitly' counts as
  // work: multistep=false there only means the ENGINE defers scaffolding to the model,
  // not that no work was asked.
  // PHASE-6 T4 (CUT 6): MOVED to the turn's bag — `assemble` writes it and
  // `postCallClassify` reads the write. Reason at the field (RULING P6-R3(1)).
  // The TRUTHFUL answer key: PHASE-6 T2 (CUT 9) put it on `PreflightScratch`, because
  // §9's `teardownContext` reads it LIVE at call time — after every statement of the
  // turn has had its chance to set it — and a value handed to a module would be the
  // picture as of this line. What it means, and why it has exactly one setter, moved
  // with it to the field.
  /**
   * PHASE-2 T6 (C4, requirement 1g) — the truthful-answer key has ONE setter.
   *
   * Four bare assignments were four writers of one fact, which is how the fact drifts
   * (research 07: any non-JSON assistant text once counted, and silent-ending turns were
   * stamped answered). The four SURFACES stay; the rule is stated once and is greppable.
   * requirement preserved: this key and nothing else decides `turns.answered`, the outcome
   * ladder's `answered` rung, and the ticket stamps' answer/delivery columns.
   */
  const noteTerminalAnswer = (rowId: string, surface: string): void => {
    sc.terminalAnswerRowId = rowId;
    logger.debug('v2: truthful-answer key set', { agentId, rowId, surface }, agentId);
  };
  // True when the start-ack already delivered the deferred text as the turn's
  // user-visible answer; gates the terminal promotion and the redundant-closeout
  // floor so the answer can never double-send.
  // PHASE-6 T6 (CUT 8): on the turn's bag with its partner — see the field.
  // Identical-call brake state (2026-07-17): consecutive identical failing
  // tool calls this turn, keyed by exact call signature. See identical-call-brake.ts.
  const identicalCallState: RepeatCallState = new Map();
  // Terminal spin-brake state (owner ruling 2026-07-19): once ANY signature
  // goes terminal, the whole tool phase is over for this turn; every further
  // tool call returns a short note without executing, and after a small grace
  // of model iterations the loop concludes. The model's TEXT is never touched.
  // PHASE-6 T5 (CUT 5): both MIGRATED to the turn's bag under RULING P6-R3(1). This is
  // the one carrier family in this tranche whose by-value alternative is measurably
  // wrong in BOTH directions — the flag is latched in `execute` and read in `callLLM`,
  // the grace is written in `callLLM` and must survive into the next iteration. The
  // grace's initial value (2) moved with it, to the field's own initialiser.
  // `loopBlockFiredThisTurn` — DELETED, PHASE-2 T6 (C9; T1 adjudication #3). verdict: STRIP.
  // One assignment, zero reads (re-derived at this HEAD across packages/server,
  // packages/dashboard, watchdog and the tests), plus a docblock still describing its
  // deleted consumer — the going-idle `deliverable_shown` stamp — in the present tense.
  // requirement preserved: "a reply the engine FORCED with a STOP order is a status update,
  // not a delivery" is the TURN OUTCOME's job now (`exit_reason` computes `brake` ahead of
  // `answered`; task-stamps gates on `outcome === 'answered'`), locked by
  // `tracker/__tests__/coerced-reply-not-a-delivery.test.ts` including its ternary-order
  // conformance. That test is what makes this deletion safe rather than merely tidy.
  // Reminder-delivery lane refuse-once memory (turn-local): first non-owner
  // send on a reminder turn is refused with guidance; an identical repeat is
  // a deliberate confirmation and proceeds.
  const reminderLaneRefusedSigs = new Set<string>();

  const deliverEngineUserAck = async (
    text: string, originIntent: string | null = null, reuseId: string | null = null,
    displayKind: DisplayKind | null = null,
  ): Promise<void> => {
    // reuseId (2026-07-23, owner .19 report: doubled bubble): when the text
    // being delivered ALREADY streamed live under a bubble id, persist and
    // broadcast under THAT id so the streamed bubble becomes the delivered
    // message instead of a duplicate appearing next to a demoted note.
    //
    // displayKind (UX-REPAIR T2, 2026-08-09) — the declared override carrier
    // (`NewMessage.displayKind`), named by the ONE caller that has to say what
    // its row IS rather than let the classifier guess. Default `null` means
    // "classify me", which is byte-identically what every call did before this
    // parameter existed.
    const ackId = reuseId ?? uuidv4();
    try {
      insertMessageIfAbsent({
        id: ackId, agentId, role: 'assistant', content: text, turnNumber, originIntent,
        ...(displayKind ? { displayKind } : {}),
      });
      broadcast({
        type: 'chat:message',
        agentId,
        message: {
          id: ackId, agentId, role: 'assistant' as const,
          content: text,
          tokenCount: null, modelId: null, cost: null, latencyMs: null,
          createdAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      logger.warn('v2: engine user-ack persist/broadcast failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
    // Immediate delivery to a non-dashboard counterparty's own channel. The
    // dashboard already has it via the broadcast above; this reaches an away
    // user on the channel they wrote in on. Best-effort: a channel failure still
    // leaves the ack in chat + the store.
    // Stamp the SAME routing marker the reply resolver writes whenever this ack
    // is pushed to a non-dashboard channel, so an engine-sent line reaching an
    // away user's phone renders with a "to <recipient> via <channel>" badge in
    // the dashboard, identical to the model's own channel sends. Without this an
    // engine-pushed ack was an unlabeled bubble in the owner's interleaved
    // stream (the observed defect).
    try {
      // ⚠ OR2-PROVISIONAL: CLOSED, PHASE-4 T4 (2026-08-02), and the disposition is a
      // CORRECTION rather than a removal. The marker predicted this lane would be converted
      // to "steer + verify + system voice", because the lane was carrying engine-composed
      // prose. It no longer is: after T4 deleted E1-E5, `deliverEngineUserAck` has exactly
      // ONE production caller (`:4582`), and what it delivers there is `startLine` — THE
      // MODEL'S OWN WORDS, the start-ack steer working as designed (§T0-PINS E names it as
      // the shape OR2 WANTS and forbids removing it).
      //
      // So the `engine-ack` tool value survives, and it means something narrower and true:
      // this is the model's opening line pushed EARLY, ahead of its answer. That is why the
      // two `NON_ANSWERING_*` sets still exclude it (`answered-edge.ts`, `work/ask-settlement.ts`) —
      // not because the engine spoke, but because a start-ack is not an ANSWER, and closing
      // an ask on one would mark a question answered before anybody looked at it.
      if (counterparty.kind === 'user' && counterparty.channel === 'imessage' && counterparty.senderId) {
        const { sendResponseViaIMessage } = await import('../../../../services/imessage-bridge.js');
        const delivered = await withOutboundAsync(
          {
            agentId, tool: 'engine-ack', channel: 'imessage',
            recipientId: counterparty.senderId,
            conversationId: turnCtx.root?.conversationId ?? null,
          },
          async () => sendResponseViaIMessage(text, agentId, counterparty.senderId!, false),
        );
        if (delivered) persistRoutingMarker(`iMessage to ${delivered.name}`);
      } else if (counterparty.kind === 'user' && counterparty.channel === 'teams' && turnCtx.state!.inboundContext?.chatId) {
        // ⚠ UX-REPAIR ROUND 12 T51 — TEAMS YES (owner ruling 3, 2026-08-16). EMAIL NO, and
        // its absence below is the whole of the refusal.
        //
        // WHY THE ARM COMES FIRST AND THE PREDICATE SECOND. `v2/counterparty.ts`'s
        // `engineAckReachesTheirChannel` is DERIVED from this list — "the ack's own push
        // arms" — so widening the fast door without widening the ack would have made the
        // derivation false and armed a steer whose delivery reaches nobody: a bubble the
        // dashboard shows and the channel never got, which is the F-22 shape RC-9's internal
        // note exists to prevent. The two moved together, and the test that pins them
        // (`__tests__/the-ack-reaches-teams-and-never-email.test.ts`) reads BOTH.
        //
        // NOTHING NEW IS INVENTED HERE. This is `finalize/channel-push.ts`'s Teams branch,
        // the send the end-of-turn router already uses for a Teams reply — a synthetic
        // `teams_send_message` through `executeTool`, so auth, retries and audit logging are
        // the dispatcher's exactly as they are there — moved under this door's own outbound
        // identity (`engine-ack`/`teams`) and this door's own routing marker. Group chats are
        // the resolver's business, not this one's: the ack rides the chat the ask ARRIVED on
        // (`inboundContext.chatId`), and with no chat id there is nothing to push to and the
        // arm does not fire rather than claiming a delivery it did not make.
        const chatId = turnCtx.state!.inboundContext.chatId;
        const { executeTool } = await import('../../../tools/index.js');
        const result = await withOutboundAsync(
          {
            agentId, tool: 'engine-ack', channel: 'teams',
            recipientId: chatId, threadRoot: chatId,
            conversationId: turnCtx.root?.conversationId ?? null,
          },
          () => executeTool(agentId, {
            id: uuidv4(), name: 'teams_send_message',
            arguments: { chat_id: chatId, message: text },
          }),
        );
        if (result.kind === 'applied') persistRoutingMarker(`Teams to chat ${chatId.slice(0, 8)}…`);
        else {
          logger.warn('v2: engine user-ack Teams push refused (non-fatal; the ack still stands in chat)', {
            agentId, why: result.reason,
          }, agentId);
        }
      } else if (counterparty.kind === 'user' && counterparty.channel === 'phone' && turnCtx.state!.inboundContext?.phoneCallSid) {
        const { getCallSession } = await import('../../../../twilio/call-session.js');
        const session = getCallSession(turnCtx.state!.inboundContext.phoneCallSid);
        if (session && !session.isEnded()) {
          await withOutboundAsync(
            {
              agentId, tool: 'engine-ack', channel: 'phone',
              recipientId: turnCtx.state!.inboundContext.phoneFromNumber ?? counterparty.senderId ?? null,
              conversationId: turnCtx.root?.conversationId ?? null,
            },
            () => session.queueAgentSay(text),
          );
          persistRoutingMarker(`phone call to ${resolveRecipientDisplay('phone', turnCtx.state!.inboundContext.phoneFromNumber ?? counterparty.senderId ?? '(unknown)')}`);
        }
      } else if (counterparty.kind === 'user' && counterparty.channel === 'sms' && turnCtx.state!.inboundContext?.smsFromNumber) {
        const { sendSms } = await import('../../../../twilio/client.js');
        const { getDefaultFromNumber } = await import('../../../../twilio/auth.js');
        const fromNumber = turnCtx.state!.inboundContext?.smsToNumber ?? getDefaultFromNumber();
        if (fromNumber) {
          const smsTo = turnCtx.state!.inboundContext.smsFromNumber;
          await withOutboundAsync(
            {
              agentId, tool: 'engine-ack', channel: 'sms', recipientId: smsTo,
              conversationId: turnCtx.root?.conversationId ?? null,
            },
            () => sendSms(smsTo, text, fromNumber),
          );
          persistRoutingMarker(`SMS to ${resolveRecipientDisplay('sms', smsTo)}`);
        }
      }
    } catch (err) {
      logger.warn('v2: engine user-ack channel delivery failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  };

  return {
    reArmIfStrandedNoAnswer, stashContinuationIfHuman, persistRoutingMarker,
    persistAndBroadcastSystemRow, noteTerminalAnswer, identicalCallState,
    reminderLaneRefusedSigs, deliverEngineUserAck,
  };
}
