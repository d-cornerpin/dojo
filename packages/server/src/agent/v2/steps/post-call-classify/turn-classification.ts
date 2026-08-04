// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — WHAT KIND OF TURN THIS WAS, decided AFTER the model spoke and
// moved byte-faithfully out of `loop.ts`'s `postCallClassify` span: the text
// sanitiser, the deliberate-engine-surface exemption, the near-duplicate guard, and
// the union that decides whether this turn's text is inter-agent traffic.
//
// ⚠ THE OWNER LAW OF 2026-07-09 LIVES HERE AND IS THE REASON THIS BLOCK IS ITS OWN
// FILE: with a human counterparty the `interAgentTurn` union is FORCED false, so
// neither the live turnKind stamp nor the persisted `source: 'a2a'` visibility can
// reclassify a user turn mid-flight. The law is written at its site, in capitals, and
// the step's contract test asserts both the behaviour and the words.
//
// One of the span's seven exits is here: a reply byte-for-byte (or near) identical to
// the last assistant message is not persisted twice — it ends the loop instead.
// ════════════════════════════════════════

import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { type AgentTurnState } from '../../state.js';
import { isNearDuplicateText } from '../../classifiers/loop.js';
import { sanitizeAssistantText } from '../../classifiers/output.js';
import { proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

/** Classify the turn the model just produced. Writes `interAgentTurn` and
 *  `deliberateSurfaceTurn` onto the scratch; both are read by five later sections. */
export function runTurnClassification(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): StepOutcome {
  const {
    agentId, chosenConvKey, counterparty, db, hasUnansweredUser, isA2ATurn,
    isEngineTurn, isHumanContinuation, mostRecentInbound, mostRecentIsA2A,
    pendingEngineEvent, result, triggerRow, turnCtx, turnNumber, waitingConvs,
  } = ctx;
  // Sanitize text before persistence (#39, v1 runtime.ts:1208-1219).
  // Weak models emit literal `\n` and over-pad blank lines.
  result.content = sanitizeAssistantText(result.content ?? null) ?? '';

  // Deliberate engine surface (scheduler digest / reminder / completion
  // report): text meant to REACH THE USER, exempt from both dedup guards
  // below (2026-07-03, see the G-SUP-3 note). E-A2: read from the PENDING
  // engine event too, in the race case mostRecentInbound is the human that
  // out-raced the event, so checking only mostRecentInbound would wrongly
  // suppress a reminder's text on the engine turn. (Declared here, above
  // the dedup guards, all inputs are turn-invariant.)
  const deliberateSurfaceTurn =
    mostRecentInbound?.origin_intent === 'scheduler' || mostRecentInbound?.origin_intent === 'completion_report' ||
    (isEngineTurn && (pendingEngineEvent?.originIntent === 'scheduler' || pendingEngineEvent?.originIntent === 'completion_report'));

  // Dedup check (#40, v1 runtime.ts:1221-1232). If the model produced
  // the exact same text as the most recent assistant message AND there
  // are no tool calls, break the loop without persisting. Catches the
  // "model regenerated identical text" failure mode (multiple triggers,
  // model stalls). Tool-bearing turns are exempt, even with identical
  // text, the tool calls themselves carry new state.
  // GOVERNING RULE (comms-audit G-SUP-3, sibling of G-SUP-1): never suppress on
  // a turn a human is waiting on. This dedup compares against the most recent
  // assistant message ACROSS turns, so when a user RE-ASKS the same thing the
  // correct answer is necessarily near-identical to the prior turn's answer
  // ("capital of France?" → "Paris" twice) and was being silently eaten, the
  // re-ask got no reply at all. Restrict the dedup to non-user turns (a genuine
  // mid-stall regeneration with no one waiting); a fresh user ask is always
  // answered. A tool-less reply ends the turn, so this cannot loop.
  //
  // 2026-07-03: same rule extends to DELIBERATE ENGINE SURFACES (scheduler /
  // reminder / completion-report turns). Their user-facing text is repeated
  // near-identical BY DESIGN ("Time to stretch!" every day), and the surface
  // IS the point of the turn. The behavioral harness caught both dedup
  // guards eating a reminder delivery entirely (run bmr5637ptnc: two model
  // attempts suppressed as cross-turn near-duplicates, turn ended silent,
  // the user never got the reminder). deliberateSurfaceTurn is computed
  // above from structured origin (origin_intent / pending engine event),
  // exactly the signal E-A2 already anticipated for this failure shape.
  if (result.content && result.toolCalls.length === 0 && !triggerRow && !deliberateSurfaceTurn) {
    const lastAssistant = db
      .prepare(
        "SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(agentId) as { content: string } | undefined;
    if (lastAssistant && isNearDuplicateText(lastAssistant.content, result.content)) {
      logger.warn('v2: skipping duplicate assistant response (identical or near-identical to last message)', {
        loopCount: state.loopCount,
      }, agentId);
      return requestExit(state, 'duplicate-assistant-response');
    }
  }

  // Broadcast streaming complete + persist assistant message.
  // v3.1.10 (attribution redesign §5, Phase 4): drive suppression off the
  // STRUCTURED counterparty, never prose. counterparty.kind === 'agent' exactly
  // when isA2ATurn (resolveTurnCounterparty), so this is the same authoritative
  // signal with the legacy [SOURCE: GROUP BROADCAST / PM AGENT POKE] includes()
  // tails deleted (per the prime directive: decide by origin, not string-match).
  // Companion rule (channel-awareness): a turn that is NOT a conversation with a
  // present user must not emit user-visible text. The leak this closes: on an
  // autonomous/background turn (owner asleep, no user waiting) the agent
  // SPONTANEOUSLY messages another agent, send_to_agent / broadcast, and its
  // trailing reasoning ("It's 1 AM, the owner's asleep, let me reply to the PM agent about
  // the homepage copy…") persisted into the owner's chat. That is the agent
  // talking out loud about what it will tell the PM. Such text is coordination,
  // never a message to the owner, so suppress it. A genuine user turn
  // (hasUnansweredUser) still persists even if it also pings an agent; deliberate
  // surfaces (scheduler digest, completion report) don't do A2A, so they persist.
  const spontaneousA2ATurn =
    !hasUnansweredUser &&
    (state.sentToAgentThisTurn ||
      result.toolCalls.some(tc => tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group'));
  // Also: a turn whose most-recent trigger is an A2A poke, with NO fresh user
  // waiting, is a background/inter-agent turn even if isA2ATurn is false (the
  // poke was already replied to, so unrepliedAssign is null). Without this, a
  // PM poke with nothing new to do flips to a "user turn" and the agent
  // RE-EMITS a user-facing summary ("a few things before you log off…") on
  // every poke. Fresh user always wins (hasUnansweredUser guard).
  const a2aBackgroundTurn = mostRecentIsA2A && !hasUnansweredUser;
  // The agent is mid A2A exchange: it was poked by an agent (mostRecentIsA2A)
  // AND it messaged an agent back this turn (sentToAgent). Its terminal text is
  // coordination addressed to that agent, so suppress it.
  // T-5 (comms-audit / PHANTOM-FLIP): but ONLY when no human is waiting. When a
  // user message is waiting, "user wins" makes THIS a user turn (trigger = the
  // waiting human), so its text is the USER's reply, suppressing it here dropped
  // the user's answer. The other A2A classifiers already carry this guard; this
  // one was missing it (the old comment's "suppress even if a user is waiting"
  // wrongly assumed the user gets a separate turn, this turn already IS it).
  const a2aExchangeTurn = mostRecentIsA2A && state.sentToAgentThisTurn && !hasUnansweredUser;
  // Pure background/wakeup turn: no user waiting, no fresh trigger, not A2A, not a
  // deliberate engine surface (scheduler digest / completion report). The agent's
  // text here ("3 AM, you're asleep, let me make progress…") is internal, suppress.
  // (deliberateSurfaceTurn is declared above the dedup guards, 2026-07-03.)
  // C3: a human-task continuation (auto-continued after MAX_TOOL_LOOPS / budget /
  // compaction) has no waiting human but IS finishing a human's ask, its final
  // answer must be delivered + routed to the restored counterparty, never suppressed
  // as background chatter.
  const pureBackgroundTurn = !hasUnansweredUser && !triggerRow && !mostRecentIsA2A && !deliberateSurfaceTurn && !isHumanContinuation;
  // USER TURNS ARE NEVER RECLASSIFIED (owner law 2026-07-09, same guard as the
  // pre-model stamp): with a human counterparty this union is forced false, so
  // neither the live turnKind stamp nor the persisted source:'a2a' visibility
  // can hide a user-facing turn after it delegates mid-turn.
  const interAgentTurn = counterparty.kind !== 'user' && (isA2ATurn || counterparty.kind === 'agent' || spontaneousA2ATurn || a2aBackgroundTurn || a2aExchangeTurn || pureBackgroundTurn);
  // LIVE = RELOAD (incident 2026-07-06): the dashboard's live suppression keys
  // on the turnKind stamp, but the PERSISTED visibility keys on
  // `source: interAgentTurn ? 'a2a' : null` below, and interAgentTurn is a
  // SIX-way union of which the turn-start stamp knew only isA2ATurn. Any turn
  // that became inter-agent via the other five terms (agent counterparty,
  // spontaneous/background/exchange/pure-background) streamed into regular-mode
  // chat live and then vanished on refresh. Re-stamp the turn kind HERE, from
  // the SAME predicate the persistence uses, before any chunk is emitted (this
  // point precedes the model call); the heartbeat re-broadcasts the same map.
  if (interAgentTurn && turnCtx.kind !== 'a2a') {
    turnCtx.kind = 'a2a';
    broadcast({ type: 'agent:status', agentId, status: 'working', turnKind: 'a2a', userFacing: !!chosenConvKey });
  }
  // [DIAGNOSTIC] phantom-waiting-user: an A2A poke that should be a background turn
  // is being flipped to a user turn by a stale waiting conversation. Log which
  // conversation is keeping hasUnansweredUser true so the served-tracking edge can
  // be pinned. (Remove once fixed.)
  if (mostRecentIsA2A && hasUnansweredUser) {
    logger.warn('v2 PHANTOM-FLIP: A2A turn flipped to user by waiting conversation', {
      agentId, turnNumber,
      waiting: waitingConvs.map(w => ({ key: w.key, oldest: w.oldestWaitingRowid, latest: String(w.latest.content).slice(0, 45) })),
    }, agentId);
  }
  sc.deliberateSurfaceTurn = deliberateSurfaceTurn;
  sc.interAgentTurn = interAgentTurn;
  return proceed(state);
}
