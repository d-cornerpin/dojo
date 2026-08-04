// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — THE A2A MISSED-REPLY ENFORCER AND ITS HARDCAP, moved
// byte-faithfully out of `loop.ts`'s `postCallClassify` span. A peer asked a question
// that needs an answer and the agent wrote prose at the user instead; the enforcer
// nudges once, and the HARDCAP ends the turn if the nudge is ignored.
//
// THE HARDCAP IS ONE OF THE SPAN'S SEVEN EXITS and it carries its own incident: before
// v2.5.31 the enforcer kept re-nudging a model that pattern-matched "user wants a
// summary" and ignored `send_to_agent` — about thirty loops until the turn budget
// killed it. The cap is why that cannot happen twice.
//
// It opens with a STRIP note kept deliberately: the cross-conversation re-answer
// DETECTOR was deleted at PHASE-3 T7 under RULING P3-R3, and the note stays so the
// deletion keeps its reason.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../../../../gateway/ws.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { type AgentTurnState } from '../../state.js';
import { steerFired } from '../../steer-queue.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { a2aReplyEnforcer } from '../../classifiers/a2a.js';
import { hasPriorReplyOnThread } from '../../../a2a-replies.js';
import { continueLoop, proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

/** The A2A missed-reply nudge and the hardcap that ends the spiral. */
export function runMissedReply(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): StepOutcome {
  const {
    a2aReplyAssignMessageId, a2aReplyContext, agentId, result, turnNumber,
    unrepliedAssign,
  } = ctx;
  const { persistedContent } = sc;
  // ── STRIP (PHASE-3 T7 Step 2, 2026-08-01, RULING P3-R3) — the cross-conversation
  // re-answer DETECTOR is deleted, with `re-answer-guard.ts`, `re-answer-sink.ts` and
  // the eslint `node:fs` allowance booked against that sink. It was log-only telemetry:
  // a Jaccard similarity between this turn's reply and answers delivered in OTHER
  // conversations, recorded and never acted on. The plan's own design had it retiring
  // here — "keep as the migration's proof instrument, then delete" (scar-tissue ledger).
  //
  // IT IS DELETED AS AN ALARM THAT NEVER WORKED, NOT AS ONE THAT WENT QUIET. Its
  // exclusion argument was `chosenConvKey` — a conv KEY — against a `conversation_id !=
  // ?` filter on a UUID column, so `conversation_id != 'owner'` never excluded a single
  // row and the reply's OWN conversation was always in the comparison set. Measured:
  // 656 of 656 conversation ids are 36-char UUIDs; two of the three fires in the driven
  // FLIPSTRIP arm matched the reply's own conversation (`616f857b…` on both sides), on
  // two independent builds. Its whole quiet history was evidence in neither direction.
  // The third fire is the OTHER known class and is not a defect: the harness asks the
  // same scripted research question every run, which is verbatim the false positive that
  // demoted this floor to log-only on 2026-07-10 — and scripted repeats are the only
  // traffic a box nobody uses can have, so fixing it could not produce clean evidence
  // here either. Both are in `dojo/DOJO-ISSUES-LOG.md`.
  //
  // requirement preserved — DELIVERED HISTORY IS NEVER DELETED FROM THE WINDOW, which is
  // the CAUSE this heuristic was watching for downstream of:
  //   * `checks/check-reanswer-ghost.mjs` — 54 delivered messages seeded into an empty
  //     session, all 54 required back out of the real assembler, no model call. It is
  //     now on the kit's prompt-gate roster AND `deploy/checks/check-prompt-gate-record`'s
  //     REQUIRED list, green in-roster, and bite-proven (breaking the assembler's
  //     own-output rule makes the release reader refuse). It was WIRED AND REPAIRED
  //     BEFORE this deletion, in this same task, because RULING P3-R2 tried to delete
  //     against it while it was unwired and red and RULING P3-R3 corrected that order.
  //   * `settled-work-stays-settled` (kit battery) — the behavioural half: after a real
  //     delivery is closed, an unrelated wake produces no re-answer and no new artifact.
  // A deterministic gate on the cause replaces a similarity heuristic on the symptom.
  //
  // `~/.dojo/logs/re-answer-detector.jsonl` is LEFT ON DISK deliberately: it is the
  // historical record of what the instrument saw, and the ledger's disposition is that
  // it stays as evidence. Nothing reads it now; nothing writes it either.

  // Settled-context tripwire: MOVED to the end-of-turn route site (search
  // "Settled-context hold"). The tripwire fires when a wake turn whose visible
  // conversations were all answered produces user-facing outbound; its 2026-07-18
  // upgrade (phantom-outreach fix) HOLDS the auto-route channel push for the
  // narrow phantom shape, which can only be done where the destination is
  // resolved. Keeping it here (inside the model loop, log-only, on the
  // loop-local persistedContent) would leave two implementations that could
  // drift, so the single implementation now lives at the route decision.

  // v2.5.31, Hardcap: if the missed-reply nudge already fired once
  // for this assign id and the LLM STILL produced text-no-tool, end
  // the turn instead of nudging again. This is the loop-breaker for
  // models that genuinely can't be talked into a tool call by a
  // system message (they pattern-match "user wants summary" and
  // ignore the directive). Pre-fix this looped ~30 times before
  // the time/token budget killed it (loop.txt 2026-05-13).
  if (
    a2aReplyAssignMessageId &&
    steerFired(state.steerQueue, 'a2a-missed-reply', a2aReplyAssignMessageId ?? '') &&
    !state.sentToAgentThisTurn &&
    persistedContent && persistedContent.trim().length > 0
  ) {
    // Hardcap engaged to prevent the pre-v2.5.31 nudge spiral (the enforcer
    // kept re-nudging a model that pattern-matched "user wants a summary" and
    // ignored the send_to_agent directive, ~30 loops until the budget killed it).
    const stopMsg = (
      `[System: Ending the turn. You wrote text instead of calling send_to_agent, so the message from the other agent is still unanswered. ` +
      `If it still needs a reply, call send_to_agent on your next turn; otherwise leave it.]`
    );
    const stopId = uuidv4();
    insertMessageIfAbsent({ id: stopId, agentId, role: 'system', content: stopMsg, turnNumber });
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id: stopId, agentId, role: 'system' as const,
        content: stopMsg,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
    return requestExit(state, 'a2a-missed-reply-hardcap');
  }

  // Missed-reply nudge (subsumes v1 runtime.ts:1344-1378)
  const replyDecision = a2aReplyEnforcer({
    triggeredByReplyNeededIntent: a2aReplyContext !== null,
    sentToAgentThisTurn: state.sentToAgentThisTurn,
    alreadyNudgedForMissedReply:
      !!a2aReplyAssignMessageId && steerFired(state.steerQueue, 'a2a-missed-reply', a2aReplyAssignMessageId),
    // Raw model text, NOT persistedContent, on an inter-agent turn the
    // text is display-suppressed (persistedContent nulled) but the enforcer
    // still needs to know the agent wrote a reply as chat instead of calling
    // send_to_agent, so it can nudge a retry.
    agentProducedText: !!(result.content && result.content.trim().length > 0),
    intent: a2aReplyContext?.intent,
    threadShort: a2aReplyContext?.threadShort,
    fromName: a2aReplyContext?.fromName,
    // v2.5.31, soften the nudge text when we know the agent already
    // replied earlier on this thread. Prevents the "system says
    // receiver got nothing but I sent the message" cognitive
    // dissonance that drove the loop.txt spiral.
    priorReplyOnSameThread:
      !!a2aReplyContext?.threadShort && hasPriorReplyOnThread(agentId, a2aReplyContext.threadShort, unrepliedAssign?.threadId ?? null),
  });
  if (replyDecision.decision === 'nudge') {
    // RC-19: via persistEngineSteer so the retry nudge reaches the model
    // (the steer queue) AND keeps its dashboard row. The bare role='system' row
    // was stripped by the assembler, so the "you wrote text instead of
    // send_to_agent, retry" steer never reached the model it addressed; only
    // the hardcap above actually bounded the loop. Mark the nudge fired for
    // this assign id (extra) so the next enforcer call returns no_action and
    // the hardcap engages if the agent doubles down on text.
    state = persistEngineSteer(
      state,
      {
        agentId,
        content: replyDecision.nudgeText,
        turnNumber,
        floor: 'a2a-missed-reply',
        atLoop: state.loopCount,
        // KEYED on the assign id; §T0-PINS F's no-latch branch latches on the empty key.
        key: a2aReplyAssignMessageId ?? '',
      },
      { broadcast },
    );
    // Continue loop so the agent reads the nudge and retries
    return continueLoop(state);
  }

  return proceed(state);
}
