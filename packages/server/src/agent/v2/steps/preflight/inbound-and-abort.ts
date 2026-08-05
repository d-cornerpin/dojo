// ════════════════════════════════════════
// PHASE-6 T2 (CUT 9) — `preflight` §2: THE INBOUND CHANNEL, AND THE ABORT REVERT.
//
// Where the turn learns what channel it is being spoken to on, and where it arms the
// N-1 / D8 hand-back: the closure that returns BOTH claims — the human ask's ticket
// and the engine event's — when a turn aborts having produced no answer.
//
// ⚠ THAT CLOSURE IS ONE OF THE THREE THAT READ THE TURN'S STATE **LIVE**, and it is
// why this tranche's carrier commit exists. It reads
// `turnCtx.state!.nonIdempotentCallsThisTurn` AT ABORT TIME: by value the counter is
// frozen at 0, every abort reads as a clean retry, and an ask is handed back to the
// waiting set AFTER the email was sent. That is the duplicate effect its own comment
// calls the correctness-critical clause. The bag is a live binding on both sides.
// ════════════════════════════════════════

import type { Database } from 'better-sqlite3';
import { resolveInbound, type InboundChannel } from '../../inbound-channel.js';
import { findUnrepliedAssignForAgent, type UnrepliedAssign } from '../../../a2a-replies.js';
import { releaseEngineEventByRowid } from '../../../../memory/message-store.js';
import { recordEngineEventDeliveryFailure, type WaitingConversation } from '../../counterparty.js';
import { revertAskClaimOnAbort, noteUnsettled } from '../../../../work/store.js';
import type { ChannelInboundContext } from '../../state.js';
import type { TurnContext } from '../../../turn-context.js';
import type { PreflightContext, PreflightScratch } from './index.js';

/** What §1 produced that this section reads. */
export interface InboundAndAbortInputs {
  readonly db: Database;
  readonly triggerRow: WaitingConversation['latest'];
  readonly triggerWorkId: string | null;
  readonly lastUserMessageContent: string;
}

/** What this section hands the sections after it. The two engine-claim locals it
 *  used to declare are on `PreflightScratch` instead — they are written by §3 and §4
 *  and read back HERE, inside the abort closure, so they are the only shape a value
 *  parameter could not carry. */
export interface InboundAndAbortOutputs {
  readonly revertTriggerStampOnAbort: () => void;
  readonly latestUserSource: 'voice' | 'text' | null;
  readonly latestTtsEngine: 'local' | 'cloud' | null;
  readonly triggeredByIMessage: boolean;
  readonly inboundChannel: InboundChannel;
  readonly inboundContext: ChannelInboundContext | null;
  readonly unrepliedAssign: UnrepliedAssign | null;
}

export function runInboundAndAbort(
  turnCtx: TurnContext,
  ctx: PreflightContext,
  sc: PreflightScratch,
  input: InboundAndAbortInputs,
): InboundAndAbortOutputs {
  const { agentId } = ctx;
  const { db, triggerRow, triggerWorkId, lastUserMessageContent } = input;
  // N-1 (comms-audit): re-arm a stranded human ask. The pickup claim above marks the ask
  // served so a concurrent turn can't double-serve it. If THIS turn then aborts BEFORE
  // producing any answer (model-call exhausted all retries, or no model available at all, a
  // transient rate-limit / provider outage), leaving the claim in place would drop the ask
  // from the waiting set FOREVER and the user would get permanent silence on a purely
  // transient infra failure, while the recovery toast promises "retrying automatically".
  // Handing the ticket back to `open` returns it to the waiting set so the runtime
  // finally-drain (runtime.ts) re-serves it once the provider recovers (bounded by
  // MAX_DRAIN_STUCK, so a persistent failure can't tight-loop). Call ONLY on no-answer
  // abort paths, never after any reply text has been produced, or it would resurrect an
  // answered ask and double-reply.
  //
  // PHASE-2 T3 — P6b NOW BINDS THE HUMAN RE-ARM TOO, AND THIS IS A DELIBERATE BEHAVIOUR
  // CHANGE. The engine-event half below has always been gated on
  // `nonIdempotentCallsThisTurn === 0`; the human half was gated only at the C4 CALLER
  // (`reArmIfStrandedNoAnswer`), so any of the five direct abort-path callers could re-arm
  // an ask whose turn had already sent an email. The rule is one rule now, enforced where
  // the revert happens rather than at each site that remembers to check: "a turn that
  // performed a side effect must never re-fire" (07 §2c, ledger P6b-1). The refusal is
  // recorded as a work event, so a held ask is a fact somebody can find.
  //
  // D8: set at the engine-event pickup below when THIS turn claims a pending engine
  // event (conv_key stamped 'engine'). PHASE-6 T2 (CUT 9): the declaration and its
  // sibling `pendingEngineClaim` are on `PreflightScratch` now — §3 and §4 write them
  // and this closure reads them back, so they are the only two values in this span
  // that a parameter could not carry. Their reasons moved with them, to the fields.
  const revertTriggerStampOnAbort = () => {
    if (triggerWorkId) {
      try {
        noteUnsettled(revertAskClaimOnAbort(
          triggerWorkId, turnCtx.state!.nonIdempotentCallsThisTurn,
          'turn aborted with no answer; handing the ask back to the waiting set (N-1)',
        ), 'v2: ask hand-back on abort', { workId: triggerWorkId });
      } catch { /* best effort, recovery, never block the abort */ }
    }
    // D8: symmetric revert for an ENGINE trigger claim. The engine pickup stamps the
    // serve edge the moment the event is picked up, so a model/provider abort
    // on the engine turn used to leave the event permanently "processed": the
    // reminder was never spoken and nothing ever retried it. Revert our own claim
    // (AND served_by_turn = OUR turn keeps it idempotent against a concurrent re-claim)
    // and record the failed delivery (attempt counter + backoff, migration 084) so
    // the retry timer / boot re-drain re-serves it, bounded by the 5-attempt /
    // 6-hour lifecycle. Guarded by the SAME no-non-idempotent-execution rule as
    // the C4 human re-arm below (P6b): a turn that performed a side effect
    // (sent the reminder via imessage_send, created a task) must not re-fire
    // the event, that would duplicate it; a read-only turn re-arms safely.
    if (sc.claimedEngineEvent != null) {
      try {
        if (turnCtx.state!.nonIdempotentCallsThisTurn === 0) {
          const reverted = releaseEngineEventByRowid({
            rowid: sc.claimedEngineEvent.rowid, agentId, turnNumber: sc.claimedEngineEvent.turnNumber,
          });
          if (reverted > 0) recordEngineEventDeliveryFailure(agentId, sc.claimedEngineEvent.rowid);
        }
      } catch { /* best effort, recovery, never block the abort */ }
    }
  };
  // T-6 (comms-audit, RESOLVED per the owner): rapid bursts are handled by PER-MESSAGE
  // serving, every message in a burst keeps its conv_key NULL until its own turn
  // picks it up, so none is ever DROPPED (the priority). The cost the owner accepted is
  // that a later message's turn can repeat an earlier answer from the tail. We do NOT
  // combine the burst onto one turn / stamp siblings served, because on the weak model
  // that risks marking a message answered without answering it (a dropped reply).
  // Phase 3, bind the inbound source for the whole turn. Computed once
  // here and threaded into every assembleContext call below so the
  // voice-conduct block stays in scope across tool-call iterations of
  // a single voice turn.
  // T6: the voice fact is `channel='voice'` now (T3-0b §3). This selects the
  // voice-conduct addendum, so it is under the cache-prefix rider: the four
  // ?source=voice|text × tts=local|cloud matrix cells must stay byte-identical.
  const latestUserSource: 'voice' | 'text' | null =
    triggerRow?.channel === 'voice' ? 'voice' : triggerRow ? 'text' : null;
  // Hume cloud-TTS brief, extend turn context with the active TTS engine
  // so the assembler can swap between the flat-voice (Kokoro) addendum
  // and the expressive (Hume) addendum that teaches the ((deliver: ...))
  // cue. Resolved once here so it stays stable across tool iterations.
  let latestTtsEngine: 'local' | 'cloud' | null = null;
  if (latestUserSource === 'voice') {
    try {
      const ttsRow = db.prepare("SELECT value FROM config WHERE key = ?")
        .get('voice.tts_engine') as { value: string } | undefined;
      latestTtsEngine = ttsRow?.value === 'cloud' ? 'cloud' : 'local';
    } catch {
      latestTtsEngine = 'local';
    }
  }
  const triggeredByIMessage = lastUserMessageContent?.includes('[SOURCE: IMESSAGE FROM') ?? false;
  // v2.9.16: once-per-turn latch for the voice-mode filler phrase.
  // Flipped true the first time we push a filler into the active TTS
  // burst so subsequent tool-using iterations in the same turn don't
  // double-fire ("on it ... checking ... give me a sec ...").
  // PHASE-6 T6 (CUT 8): on the turn's bag — the latch is read and written inside the
  // `postCallClassify` span and must survive the ITERATION. See the field.

  // v2.9.23, phone-call streaming TTS state. When this turn is
  // triggered by a live phone call, we keep a sentence-splitting
  // buffer attached to the model's onChunk callback. Each completed
  // sentence (or comma-separated clause for short replies) goes to
  // `CallSession.queueAgentSay` ASAP so audio starts playing on the
  // first sentence instead of waiting for the whole model output.
  // Cuts perceived latency by ~70 % on multi-sentence replies.
  // PHASE-6 T9 (CUT 4), RULING P6-R3(1): the BUFFER and the FLUSHED latch are on the
  // turn's bag, because both are written from the model's `onChunk` CALLBACK below
  // and the `finalize` span both reads and WRITES the buffer — a module boundary
  // passes values, so a by-value copy would take a stale tail and drop the clear.
  // PHASE-6 T5 (CUT 5): `phoneStreamCallSid` MIGRATED to the bag with the rest of its
  // family, exactly where CUT 4's note said it would — it crosses `callLLM` (the
  // streaming callback) and `postCallClassify` (the voice filler), so this is the
  // tranche that owed it. See the field's own comment for what the migration is and
  // is not claiming.

  // v3.0.9, inbound channel + reply context resolved in ONE place
  // (inbound-channel.ts). Priority: structured metadata (messages.inbound_meta,
  // stamped by the producer) → voice (source='voice') → a behavior-preserving
  // parse of the [SOURCE: ...] prose. Routing no longer depends on the engine
  // re-parsing notification wording, which is the recurring failure this
  // closes. The reply-destination resolver reads these at end of turn to
  // auto-route the model's terminal text back to the source channel.
  const resolvedInbound = resolveInbound({
    agentId,
    content: lastUserMessageContent,
    channel: triggerRow?.channel ?? null,
    inboundMeta: triggerRow?.inbound_meta ?? null,
  });
  const inboundChannel = resolvedInbound.inboundChannel;
  const inboundContext = resolvedInbound.inboundContext;
  // v2.9.23, bind the streaming TTS sink for a live phone call so audio
  // starts playing while the model is still generating (the onChunk callback
  // on the model call flushes sentence-complete chunks to queueAgentSay).
  if (inboundChannel === 'phone' && inboundContext?.phoneCallSid) {
    turnCtx.phoneStreamCallSid = inboundContext.phoneCallSid;
  }
  // v2.5.31, A2A reply context now sources from the durable a2a_replies
  // table, not just "is the most recent user message an [A2A:...] tag."
  // findUnrepliedAssignForAgent returns null if the most recent ASSIGN/
  // QUESTION/BLOCK has already been replied to via send_to_agent (in any
  // prior handleMessage invocation), which prevents the enforcer from
  // firing again for an already-handled inbound message. Falls back to
  // the legacy parse path so any pre-fix in-flight ASSIGNs (no row in
  // a2a_replies yet) still trigger the enforcer at least once.
  const unrepliedAssign = findUnrepliedAssignForAgent(agentId);

  return {
    revertTriggerStampOnAbort, latestUserSource, latestTtsEngine, triggeredByIMessage,
    inboundChannel, inboundContext, unrepliedAssign,
  };
}
