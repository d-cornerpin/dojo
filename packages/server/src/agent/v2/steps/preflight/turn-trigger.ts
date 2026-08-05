// ════════════════════════════════════════
// PHASE-6 T2 (CUT 9) — `preflight` §1: THE TURN'S TRIGGER.
//
// The agent and its model, the waiting-conversation set, the C3 continuation
// restore, and the PICKUP CLAIM — the atomic edge that decides whether this process
// serves this message at all. ONE of the step's two `abandon` sites is here, and it
// is the D-2 cross-process race: another process stamped the trigger between our
// read and our stamp, so this turn stops rather than running a duplicate.
//
// ⚠ THE ORDER PAIR `conversation-identity-is-the-fk` PINS IS IN THIS FILE AND MUST
// STAY IN IT. Its clause pairs `chosenConversationId = resolveOrCreateConversation(`
// with `turnCtx.conversationId = `, and `engineFileWithBoth` THROWS when an order
// pair straddles two files — so the seam below the second of them is load-bearing,
// not cosmetic.
// ════════════════════════════════════════

import type { Database } from 'better-sqlite3';
import { createLogger } from '../../../../logger.js';
import { getDb } from '../../../../db/connection.js';
import { AgentError } from '../../../errors.js';
import { getContextWindow } from '../../../model.js';
import { continuationContext } from '../../../turn-state.js';
import { turnContinuationCounts } from '../../../shared-state.js';
import { stampConversationIdByRowid } from '../../../../memory/message-store.js';
import { resolveOrCreateConversation } from '../../../../memory/conversations.js';
import { claimAsk, isStateConflict } from '../../../../work/store.js';
import { getWaitingHumanConversations, type WaitingConversation, type TurnCounterparty } from '../../counterparty.js';
import { hasOpenHumanWork, resumeWorkOnOwnerAsk } from '../../answered-edge.js';
import { preflightAbandon, preflightProceed, type PreflightOutcome } from '../step-outcome.js';
import type { TurnContext } from '../../../turn-context.js';
import type { PreflightContext } from './index.js';

const logger = createLogger('v2-loop');

/** What this section hands the eight after it. Every type is the one the checker
 *  already inferred at the declaration inside `runV2TurnBody`; nothing was widened
 *  or re-spelled, because a relocation that re-types a value is not a relocation. */
export interface TurnTriggerOutputs {
  readonly db: Database;
  readonly agent: Record<string, unknown>;
  readonly configuredModelId: string;
  readonly isAutoRouted: boolean;
  readonly contextModelId: string;
  readonly contextWindow: number;
  readonly waitingConvs: WaitingConversation[];
  readonly openHumanWorkAtTurnStart: boolean;
  readonly continuation: { convKey: string; conversationId: string | null; counterparty: TurnCounterparty } | undefined;
  readonly isHumanContinuation: boolean;
  readonly chosenConvKey: string;
  readonly chosenConversationId: string | null;
  readonly triggerRow: WaitingConversation['latest'];
  readonly lastUserMessageContent: string;
  readonly lastUserMessageId: string | null;
  readonly triggerWorkId: string | null;
  readonly triggerConversationId: string | null;
}

export function runTurnTrigger(
  turnCtx: TurnContext,
  ctx: PreflightContext,
): PreflightOutcome<TurnTriggerOutputs> {
  const { agentId, setAgentStatus, startStatusHeartbeat } = ctx;
  const db = getDb();

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as
    | Record<string, unknown>
    | undefined;
  if (!agent) {
    throw new AgentError('Agent not found', agentId, { code: 'AGENT_NOT_FOUND' });
  }
  const configuredModelId = agent.model_id as string | null;
  if (!configuredModelId) {
    throw new AgentError('Agent has no model configured', agentId, { code: 'NO_MODEL' });
  }

  const isAutoRouted = configuredModelId === 'auto';
  const contextModelId = isAutoRouted ? '__auto__' : configuredModelId;
  const contextWindow = getContextWindow(contextModelId);

  setAgentStatus(agentId, 'working');
  startStatusHeartbeat(agentId);

  // Trigger context, read once at preflight (Part XIX preservation).
  //
  // v2.9.15: filter out rows that share `role='user'` but are NOT
  // actual user-channel inbounds. Without this, an A2A reply from a
  // sub-agent or a synthetic rate-limit-recovery notice shows up as
  // "the most recent user message" and the engine misattributes the
  // current turn's inbound channel - the canonical failure shape is:
  // user iMessages primary, primary delegates to a sub-agent, the
  // sub-agent's A2A reply lands as `role='user'` with content starting
  // `[A2A:`, and the primary's next-turn reply auto-routes to
  // dashboard instead of back to the original iMessage thread.
  // Recent role='user' rows with full attribution, newest first. The turn
  // trigger / counterparty is classified by STRUCTURED origin (deriveOrigin =
  // the origin_kind column + the legacy-marker shim), NOT a prose NOT-LIKE list.
  // The old query only excluded [SOURCE: SYSTEM / [A2A: / [SOURCE: AGENT MESSAGE,
  // so engine events written as role='user' (tracker / scheduler / thrash gate /
  // healer / …) became the "trigger" and resolved to a malformed
  // "a contact / engine / dashboard" counterparty, which then misclassified A2A
  // turns and leaked their planning text to the dashboard. origin.kind tells
  // human (user) from engine from agent unambiguously.
  // ── Counterparty serialization (turn continuity) ──
  // Serve the human conversation that has been WAITING longest with an
  // unanswered message (FIFO). Its LATEST message is the trigger, so multi-part
  // messages from one sender answer together. Because a turn only marks a
  // conversation "served" when it actually delivers a reply (below), a turn that
  // ends mid-task leaves its conversation waiting → the next turn RESUMES the
  // SAME one and routes to it, instead of jumping to whoever is newest (which
  // sent a Teams answer to a client's email). Same helper the runtime uses to
  // decide whether to re-trigger and drain the rest. Engine events / A2A are not
  // human conversations here.
  const waitingConvs = getWaitingHumanConversations(agentId);
  // PHASE-2 T6 (C8, requirement 1e): ONE QUERY on the spine, taken HERE — at the same
  // instant as the waiting set and BEFORE the pickup claim below. The instant is
  // load-bearing: the claim moves this turn's own trigger to `claimed`, so a read taken
  // afterwards answers "is anybody ELSE waiting" and turns every ordinary user turn into a
  // settled-context wake.
  const openHumanWorkAtTurnStart = hasOpenHumanWork(agentId);
  // C3: restore a human-task continuation. When a long human task hit MAX_TOOL_LOOPS /
  // the time budget / emergency compaction, the engine auto-continued with an empty
  // trigger and stashed the conversation here. This continuation turn has no waiting
  // human (the ask was stamped served at the original pickup), so without restoring it
  // the turn would be pureBackgroundTurn → its final answer suppressed + routed to
  // dashboard. Always consume the entry on read: a continuation is used once, and if a
  // real human turn arrived in between (waitingConvs non-empty) the entry is stale and
  // must be dropped so it can't falsely restore later.
  const continuation = continuationContext.get(agentId);
  continuationContext.delete(agentId);
  const isHumanContinuation = waitingConvs.length === 0 && !!continuation;
  const chosenConvKey = isHumanContinuation ? continuation!.convKey : (waitingConvs[0]?.key ?? null);
  // PHASE-2 T10I: the same choice as the FK. `conversationId` is resolved at ingest by the
  // producer and read straight off the trigger row here; the `??` fallback below (at the
  // pickup stamp) is what covers a row no door ever resolved for. `chosenConvKey` SURVIVES
  // beside it because four other tables are still keyed by the string — see
  // `TurnContext.conversationId`'s note in turn-context.ts.
  let chosenConversationId: string | null = isHumanContinuation
    ? (continuation!.conversationId ?? null)
    : (waitingConvs[0]?.oldest?.conversation_id ?? null);
  // F9: timestamp of the turn's most recent context assembly; sibling user rows
  // of the same conversation created before this instant were IN the assembled
  // context and are adjudicated at turn finalize (see assembledContextAsks and
  // work/ask-settlement.ts).
  // PHASE-6 T4 (CUT 6): MOVED to the turn's bag with its two siblings — the
  // `assemble` span writes it and the teardown closure reads it, so a by-value
  // hand-off would lose the stamp. Reason at the field (RULING P6-R3(1)).
  // FA-M1: the non-compressible overhead (assembled system prompt + tool-schema/
  // output reserve) the pre-call compaction gate subtracts from the window to get
  // the compressible budget. Refreshed from each assembly below; the pre-call gate
  // sits at the top of the iteration (before assembly), so it uses the prior
  // iteration's value (0 on the very first gate, i.e. old full-window behavior).
  // The stronger, exact anti-silent-loss signal is the eviction broadcast, which
  // fires whenever the assembler actually drops fresh-tail rows.
  // PHASE-6 T4 (CUT 6): both MOVED to the turn's bag — see `lastAssembledAtIso`
  // above. `freshTailDropWarned` is the once-per-TURN latch behind the CONTEXT_HIGH
  // banner, which is why it cannot ride by value into a step that runs per iteration.
  // E-C1: publish the conversation this turn serves so recall_recent_thread scopes
  // to it. null on engine/A2A turns (no waiting human) so recall doesn't latch the
  // last human conversation. Cleared when the agent goes idle.
  turnCtx.convKey = chosenConvKey;
  // The ID half of the same publication is written AFTER the pickup block below, where
  // `chosenConversationId` becomes final. See the note at that write.
  // OPEN-12: trigger on the OLDEST unanswered message in the chosen conversation,
  // so a conversation's pending messages are answered oldest-first, a later ping
  // ("are you there?") can never be answered before the request that came before it.
  const triggerRow = waitingConvs[0]?.oldest;
  const lastUserMessageContent = triggerRow?.content ?? null;
  // P1 lineage spine: the inbound ask's ROW ID, the origin key work records
  // born this turn will carry (the prose copy in lastUserMessageContent stays
  // for display; identity travels as this id).
  const lastUserMessageId: string | null = triggerRow?.id != null ? String(triggerRow.id) : null;
  turnCtx.root = lastUserMessageId ? { kind: 'ask', id: lastUserMessageId, sourceMessageId: lastUserMessageId, conversationId: (triggerRow as unknown as { conversation_id?: string | null })?.conversation_id ?? null } : null;
  // CLAIM this ask the moment the turn picks it up, so it reads as SERVED regardless of how
  // this turn ends. The old design only marked a conversation served when the turn
  // delivered a terminal reply (or [no-reply]), so a turn that did real, NON-IDEMPOTENT
  // work (created a project, wrote files, messaged the PM) but then ended via a suppressed
  // reply, a gate/limit, or an A2A hand-off tagged nothing, left the conversation
  // "waiting", and the runtime drain re-triggered the SAME message → the agent redid the
  // work → duplicate projects (the thrash spiral). A genuinely newer message in the same
  // conversation has its OWN ticket, so it still reads as waiting and is served on the next
  // turn; only the self-re-trigger of the message we are handling right now is killed.
  // Continuing a long task is the tracker/PM's job, never re-running the user's message.
  //
  // PHASE-2 T3: the claim is a STATE on the ask (`open → claimed`), not a NULL becoming a
  // string on `messages.conv_key`. The conv_key stamp stays as what it was always named
  // for — the conversation's IDENTITY, which conversation-scoped recall and the turn's own
  // output tagging read (07 §3g/3l) — and it no longer decides anything about the queue.
  // requirement preserved: restart-durable (still a DB fact, now on the ticket), one winner
  // across processes (the CAS is `expectedState: 'open'` inside `transition()`), and
  // identity untouched (a claim can no longer overwrite a channel).
  const triggerWorkId: string | null = waitingConvs[0]?.workId ?? null;
  // The conversation the trigger arrived on, read HERE at pickup and carried to the
  // delegation exit. PHASE-2 T4 copies it onto the join rather than re-resolving the channel
  // later from an `inbound_meta` blob, which is what the park machine had to do after it
  // overwrote the identity column.
  const triggerConversationId: string | null = waitingConvs[0]?.oldest?.conversation_id ?? null;
  if (chosenConvKey && triggerRow) {
    let claimed = true;
    if (triggerWorkId) {
      const res = claimAsk(triggerWorkId, agentId);
      claimed = res.kind === 'applied';
      if (!claimed && !isStateConflict(res)) {
        logger.warn('v2: pickup claim refused by the work spine', { agentId, workId: triggerWorkId, res }, agentId);
      }
      // PHASE-2 T6 (C3) — THE REOPEN EDGE. The owner has spoken, so work the engine parked
      // because it was waiting on them returns to the state it was paused from. Not
      // optional: a pause with no reopen is how a ticket rots quietly, which is what the P2
      // drive boundary was protecting against (T1 adjudication #2, rider b).
      if (claimed) {
        try { resumeWorkOnOwnerAsk(agentId); }
        catch (err) {
          logger.warn('v2: reopen-on-owner-ask failed (non-fatal)', {
            agentId, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
      }
    }
    // Identity, always, and independent of the claim: this row belongs to this
    // conversation whether or not this turn won the race to serve it.
    //
    // PHASE-2 T10I: the identity is `conversations.id`. Two cases, and the second is the
    // reason this write still exists after the backfill:
    //   * the producer resolved it at ingest (the normal path) — nothing to do, the row
    //     already carries it, and re-writing it from the turn's coarser view could only make
    //     it worse (a door knows the mail thread; a turn knows the sender);
    //   * the producer could NOT (`resolveOrCreateConversation` is best-effort by contract and
    //     returns null rather than blocking an inbound) or the row never passed a door at all
    //     — resolve it here, once, through the same one writer, from the identity the waiting
    //     set derived from this row's own stamped origin.
    // This is a DOOR-TIME resolution, not a backfill guess: the turn is genuinely having this
    // conversation right now, which is what `resolveOrCreateConversation` exists to record.
    // It logs when it fires, because a live occurrence means a producer is not stamping and
    // that is a finding rather than routine.
    if (!chosenConversationId) {
      const identity = waitingConvs[0]?.identity;
      if (identity) {
        try {
          chosenConversationId = resolveOrCreateConversation(agentId, identity);
          logger.info('v2: trigger row carried no conversation_id; resolved at pickup', {
            agentId, rowid: triggerRow.rowid, convKey: chosenConvKey, conversationId: chosenConversationId,
          }, agentId);
        } catch { /* best effort; the turn proceeds unscoped exactly as it would have */ }
      }
    }
    if (chosenConversationId) {
      try {
        stampConversationIdByRowid({ rowid: triggerRow.rowid, agentId, conversationId: chosenConversationId });
      } catch { /* best effort, served-tagging also happens at turn end */ }
    }
    // C24: reset the turn-continuation counter at the start of a genuinely NEW
    // human-triggered turn (a fresh trigger claimed here). The counter bounds CONSECUTIVE
    // time-budget auto-continuations of ONE turn; without a reset it accumulated across the
    // whole process, so three unrelated long turns would prematurely hard-stop the fourth.
    // Continuation turns (empty trigger → no pickup) never reach here, so a single long
    // task's own continuations still accumulate and cap correctly.
    if (claimed) turnContinuationCounts.delete(agentId);
    if (!claimed) {
      // D-2 (comms-audit): the atomic claim affected 0 rows, ANOTHER process already
      // stamped this trigger between our read and our stamp (cross-process race on one
      // SQLite DB). Bail cleanly instead of running a DUPLICATE turn on the same
      // message. Single-process production never hits this (changes is always 1); this
      // only guards the multi-process case (e.g. stray dev `tsx watch` processes). The
      // turn's own `finally` clears its context; the other process serves the message.
      logger.warn('v2: pickup claim lost, another process already claimed this trigger; skipping to avoid a duplicate turn', { agentId, rowid: triggerRow.rowid, workId: triggerWorkId }, agentId);
      setAgentStatus(agentId, 'idle');
      return preflightAbandon('pickup-claim-lost');
    }
  }

  // E-C1 / PHASE-2 T10I: publish the conversation this turn serves, as `conversations.id`.
  // PHASE-3 STRIP-3 MOVED IT HERE (it was beside its KEY sibling above) because THIS is where
  // `chosenConversationId` is final: the pickup repair just above resolves one for exactly the
  // trigger rows no producer stamped. Written early, the map said "no conversation" on a turn
  // that had one, `memory/assembler.ts` handed that null to `scopeToHumanConversation`, and
  // the own-output rule dropped every stamped answer — the model saw its asks with its replies
  // missing and answered again (dojo `8bc7d7a`'s re-answer ghost; 23.6% of user rows on the dev
  // body carry no `conversation_id`). MOVED, not doubled — a second `.set()` is two owners of
  // one fact. Pinned by integration.test.ts, "STRIP-3 … (b)".
  turnCtx.conversationId = chosenConversationId;

  return preflightProceed({
    db, agent, configuredModelId, isAutoRouted, contextModelId, contextWindow,
    waitingConvs, openHumanWorkAtTurnStart, continuation, isHumanContinuation,
    chosenConvKey, chosenConversationId, triggerRow, lastUserMessageContent,
    lastUserMessageId, triggerWorkId, triggerConversationId,
  });
}
