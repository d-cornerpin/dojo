// ════════════════════════════════════════
// PHASE-6 T2 (CUT 9) — `preflight` §3: WHAT KIND OF TURN THIS IS.
//
// A2A or not, engine event or not, notification or not, and — the rule every one of
// those defers to — a waiting human always wins the turn. The terminal-wake
// detection and its buried-wake fallback live here, and so does the SECOND of the
// step's two `abandon` sites: the engine event was already served, so another
// process owns it and this turn stops rather than running a duplicate engine turn.
//
// The section is the span's largest because the classification is one decision made
// from eight signals, and splitting it further would put the "user always wins"
// gate in a different file from the flags it gates.
// ════════════════════════════════════════

import type { Database } from 'better-sqlite3';
import { deriveOrigin, legacyOriginInputs } from '@dojo/shared';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { isRowUnserved } from '../../../../memory/message-store.js';
import { forceA2ATurn, lastTurnWasA2A } from '../../../turn-state.js';
import type { TurnContext } from '../../../turn-context.js';
import type { UnrepliedAssign } from '../../../a2a-replies.js';
import { parseA2ATrigger } from '../../classifiers/a2a.js';
import { getPendingEngineEvent, type WaitingConversation } from '../../counterparty.js';
import { resolveServedWork } from '../../stale-work-ids.js';
import { preflightAbandon, preflightProceed, type PreflightOutcome } from '../step-outcome.js';
import type { PreflightContext, PreflightScratch } from './index.js';

const logger = createLogger('v2-loop');

/** What the sections before this one produced that it reads. */
export interface TurnClassificationInputs {
  readonly db: Database;
  readonly waitingConvs: WaitingConversation[];
  readonly openHumanWorkAtTurnStart: boolean;
  readonly triggerRow: WaitingConversation['latest'];
  readonly chosenConvKey: string;
  readonly lastUserMessageContent: string;
  readonly unrepliedAssign: UnrepliedAssign | null;
}

/** What this section hands the sections after it. */
export interface TurnClassificationOutputs {
  readonly mostRecentInbound: {
    rowid: number; content: string; lane: string; origin_intent: string | null;
    source_agent_id: string | null; a2a_thread_id: string | null; a2a_intent: string | null;
    a2a_requires_response: number | null; inbound_meta: string | null; served_by_turn: number | null;
  } | undefined;
  readonly mostRecentIsA2A: boolean;
  readonly terminalWakeA2A: { intent: string; threadShort: string; threadId: string; fromName: string; rowid: number } | null;
  readonly hasUnansweredUser: boolean;
  readonly isA2ATurn: boolean;
  readonly terminalWakeDrivesTurn: boolean;
  readonly pendingEngineEvent: { rowid: number; id: string; taskId: string | null; runId: string | null; content: string; originIntent: string | null } | null;
  readonly isEngineTurn: boolean;
  readonly settledContextWakeTurn: boolean;
  readonly isNotificationTurn: boolean;
  readonly a2aReplyContext: { intent: string; threadShort: string; fromName: string } | null;
  readonly a2aReplyAssignMessageId: string | null;
  readonly a2aCounterpartyIdentity: { intent: string; threadShort: string; fromName: string } | null;
}

export async function runTurnClassification(
  turnCtx: TurnContext,
  ctx: PreflightContext,
  sc: PreflightScratch,
  input: TurnClassificationInputs,
): Promise<PreflightOutcome<TurnClassificationOutputs>> {
  const { agentId, setAgentStatus } = ctx;
  const {
    db, waitingConvs, openHumanWorkAtTurnStart, triggerRow, chosenConvKey,
    lastUserMessageContent, unrepliedAssign,
  } = input;
  // ── A2A turn classification (v3.1.10) ──
  // A turn is a dedicated A2A-handling turn when EITHER the runtime forced one
  // (a still-unreplied A2A that a prior user turn deferred, forceA2ATurn) OR
  // the most-recent inbound is itself an unreplied wake-A2A and nothing newer
  // (a real user message) supersedes it. On any other turn A2A is stripped
  // from context (assembler) and the reply enforcer stays disarmed, so
  // inter-agent traffic cannot bleed into a user-facing reply. A deferred A2A
  // is not dropped: the runtime re-queues it as its own A2A turn (see
  // runtime.ts finally + turn-state.ts).
  const forcedA2ATurn = forceA2ATurn.has(agentId);
  forceA2ATurn.delete(agentId);
  // T6: ONE most-recent inbound, over every lane the agent owns. This was a two-arm
  // UNION with an anti-join dedup because peer A2A lived in a second physical table;
  // T4 folded it in, so a NEW peer ASSIGN is the most-recent trigger by insertion order
  // and mostRecentIsA2A → isA2ATurn → counterparty.kind='agent' without any merging.
  // requirement preserved: a peer ASSIGN that arrived last is the trigger the assembler
  // scopes the tail to. The `_src` tag is gone with the second table (one rowid space).
  const mostRecentInbound = db.prepare(`
    SELECT seq AS rowid, content, lane, origin_intent, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, inbound_meta, served_by_turn
      FROM messages
     WHERE agent_id = @agentId AND role = 'user'
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1
  `).get({ agentId }) as {
    rowid: number; content: string; lane: string; origin_intent: string | null;
    source_agent_id: string | null; a2a_thread_id: string | null; a2a_intent: string | null;
    a2a_requires_response: number | null; inbound_meta: string | null; served_by_turn: number | null;
  } | undefined;
  // A reply-needed peer A2A (QUESTION/ASSIGN/BLOCK) is most-recent. Engine-origin
  // rows (fromAgent='system') are NOT peer A2A, they drive an engine turn instead,
  // so they never count here (else they'd mis-frame the receiver toward send_to_agent).
  const mostRecentIsA2A =
    mostRecentInbound?.lane !== 'events' &&
    parseA2ATrigger(mostRecentInbound?.content ?? null) !== null;
  // ── Terminal-wake A2A detection (interagent-separation) ──
  // Terminal intents (DELIVERABLE/ANSWER/COMPLETE/FAIL) ALSO wake the receiver by
  // design (a sub-agent handing back the thing that was asked for), but they are
  // NOT reply-needed, so findUnrepliedAssignForAgent returns null and the old
  // isA2ATurn was false. With no human waiting the turn then fell to owner/engine
  // classification and scopeToHumanConversation->stripA2AFromTail REMOVED the very
  // deliverable that woke the agent: it woke blind to what it was woken for, and
  // could run a stale owner directive. Detect the wake structurally: the most-recent
  // inbound is a PEER (not engine) terminal A2A intent that actually woke this agent
  // (a2a_requires_response=1) and has not yet been claimed by a turn.
  //
  // PHASE-2 T10I: "not yet claimed" is `served_by_turn IS NULL`. It was `conv_key IS NULL`,
  // which is the LAST survivor of the claim job T4 already moved off this column: T4
  // re-pointed `findUnservedTerminalWake` onto `served_by_turn` and deleted the
  // `conv_key='a2a'` sentinel that fed it, but this second reader of the same fact was
  // missed, and it kept working only because nothing wrote the sentinel any more — i.e. it
  // was reading "unclaimed" off a column that no longer records claims. Now both readers of
  // that edge ask the same column the same question.
  // Gated with !hasUnansweredUser below so a waiting human always wins (no hijack).
  const TERMINAL_WAKE_INTENTS = new Set(['DELIVERABLE', 'ANSWER', 'COMPLETE', 'FAIL']);
  let terminalWakeA2A: { intent: string; threadShort: string; threadId: string; fromName: string; rowid: number } | null = null;
  if (
    mostRecentInbound &&
    mostRecentInbound.lane !== 'events' &&
    mostRecentInbound.a2a_thread_id &&
    mostRecentInbound.a2a_intent &&
    TERMINAL_WAKE_INTENTS.has(mostRecentInbound.a2a_intent) &&
    mostRecentInbound.a2a_requires_response === 1 &&
    mostRecentInbound.served_by_turn === null
  ) {
    const senderRow = mostRecentInbound.source_agent_id
      ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(mostRecentInbound.source_agent_id) as { name?: string } | undefined)
      : undefined;
    terminalWakeA2A = {
      intent: mostRecentInbound.a2a_intent,
      threadShort: mostRecentInbound.a2a_thread_id.slice(0, 8),
      threadId: mostRecentInbound.a2a_thread_id,
      fromName: senderRow?.name ?? mostRecentInbound.source_agent_id ?? 'another agent',
      rowid: mostRecentInbound.rowid,
    };
  }
  // Buried-wake fallback (2026-07-23): the check above only sees a wake when
  // it is the absolute most-recent inbound. A peer message landing after a
  // deliverable buried it, so the wake run served the peer and the
  // deliverable sat unserved until a slow periodic. Pick the newest UNSERVED
  // terminal wake instead; the human-wins gate below is unchanged.
  if (!terminalWakeA2A) {
    try {
      const { findUnservedTerminalWake } = await import('../../counterparty.js');
      const buried = findUnservedTerminalWake(agentId);
      if (buried) {
        const b = db.prepare('SELECT a2a_intent, a2a_thread_id, source_agent_id FROM messages WHERE rowid = ?')
          .get(buried.rowid) as { a2a_intent: string; a2a_thread_id: string; source_agent_id: string | null } | undefined;
        if (b) {
          const senderRow2 = b.source_agent_id
            ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(b.source_agent_id) as { name?: string } | undefined)
            : undefined;
          terminalWakeA2A = {
            intent: b.a2a_intent,
            threadShort: b.a2a_thread_id.slice(0, 8),
            threadId: b.a2a_thread_id,
            fromName: senderRow2?.name ?? b.source_agent_id ?? 'another agent',
            rowid: buried.rowid,
          };
          logger.info('v2: buried terminal wake selected (newer non-wake inbound had hidden it)', {
            agentId, intent: b.a2a_intent, thread: b.a2a_thread_id.slice(0, 8),
          }, agentId);
        }
      }
    } catch { /* best effort; the turn falls back to normal classification */ }
  }
  // The user always wins: if a real user-channel message is still unanswered
  // (newer than our last user-facing text reply), this is a user turn even if
  // an A2A is forced/pending, answer the user now, the A2A re-defers to its
  // own turn. Without this, a forced A2A turn hijacks a fresh user message and
  // the user's question is silently dropped. (Assistant text replies persist
  // as plain strings; tool-call/content-block messages persist as '[{...}]'.)
  // Is there a GENUINE human conversation still WAITING (an unanswered message,
  // per the per-conversation served tracking above)? This is the "user wins"
  // signal: a waiting human means this is a user turn and any pending A2A defers
  // to its own turn. Engine events and A2A are not human conversations, so they
  // never make this true (the bug that forced isA2ATurn=false and leaked A2A
  // chatter to the dashboard).
  const hasUnansweredUser = waitingConvs.length > 0;
  // An A2A turn is either the reply-needed case (an unreplied QUESTION/ASSIGN/BLOCK,
  // forced or most-recent) OR a terminal-wake (a peer handed back a DELIVERABLE/
  // ANSWER/COMPLETE/FAIL that woke us). Both need the live tail scoped to the A2A
  // thread (scopeToA2AThread) so the agent SEES the message instead of having it
  // stripped. The waiting-human guard is shared: a real user always wins the turn.
  const isA2ATurn =
    !hasUnansweredUser &&
    ((unrepliedAssign !== null && (mostRecentIsA2A || forcedA2ATurn)) || terminalWakeA2A !== null);
  if (isA2ATurn) lastTurnWasA2A.add(agentId); else lastTurnWasA2A.delete(agentId);
  // The terminal wake DRIVES this turn only when there is no competing reply-needed
  // obligation (an unreplied QUESTION/ASSIGN/BLOCK wins the counterparty + enforcer,
  // and its own thread is scoped instead). Only then is the terminal message the one
  // this turn scopes to and should claim.
  const terminalWakeDrivesTurn = isA2ATurn && terminalWakeA2A !== null && unrepliedAssign === null;
  // PHASE-2 T4: the terminal-wake claim is the SERVE edge, not a fake conversation.
  //
  // It used to stamp `conv_key='a2a'` — a sentinel that is not a conversation, on the column
  // that carries conversation IDENTITY, purely so `findUnservedTerminalWake` (whose predicate
  // was `conv_key IS NULL`) would stop returning the row. That is the same overloading the
  // owner-ask queue was rekeyed off at T3, and it is the last one in the A2A lane (3l).
  // `messages.served_by_turn` already means exactly "a turn took this", it is already stamped
  // on this row a few lines below, and the finder now reads it.
  // requirement preserved: the driving wake drives exactly ONE turn — without a stamp it stays
  // most-recent and unserved, and a later spurious wake would re-detect it and (worst case)
  // re-relay the deliverable to the owner.
  if (terminalWakeDrivesTurn && terminalWakeA2A) {
    // P1 lineage spine: an A2A wake turn's root is its thread.
    const twThread = (terminalWakeA2A as unknown as { a2a_thread_id?: string | null }).a2a_thread_id;
    if (twThread) turnCtx.root = { kind: 'a2a', id: String(twThread), sourceMessageId: null };
  }

  // ── Engine turn classification (OPEN-11) ──
  // A turn triggered by an engine event, a scheduler task or reminder firing
  // (a role='user' row with origin_kind='engine'). The owner always wins: only
  // when no human conversation is waiting and this isn't an A2A turn does the
  // engine event drive the turn. On an engine turn the assembler scopes the live
  // tail to the engine event (scopeToEngineTurn) instead of the owner's human
  // chat, so an hour-old already-answered request can't be run in place of the
  // scheduled task (the gastro-digest-ran-a-stale-RAM-rundown hijack). The
  // scheduler payload itself is the ACTIVE USER DIRECTIVE this turn.
  // E-A2: detect the engine turn from a PENDING (unprocessed) engine event, not
  // just "the most-recent inbound is engine." A human message that arrives in the
  // same window as a scheduler/reminder event makes mostRecentInbound non-engine;
  // the human wins this turn, and without this the engine event would never again
  // be most-recent and would be silently starved (task stuck in_progress). The
  // pending-event check + the runtime drain (which re-triggers while one is pending)
  // give it its own turn after the human is served.
  const pendingEngineEvent = (!isA2ATurn && !hasUnansweredUser) ? getPendingEngineEvent(agentId) : null;
  const isEngineTurn = !isA2ATurn && !hasUnansweredUser && pendingEngineEvent != null;
  // Settled-context wake (owner report 2026-07-09 9:39 PM, third re-chase
  // specimen): when NO human is waiting at turn start, every user conversation
  // this turn can see is, by definition, already answered (a fresh human ask
  // would be in waitingConvs). The engine's claim bookkeeping knows this; the
  // model cannot see that bookkeeping, so on background wakes it sometimes
  // re-answers the last visible question as if it were new. On these turns an
  // [Engine hint] is injected at the context tail (see the assembly site) and a
  // turn-end tripwire logs any user-facing outbound for calibration.
  // PHASE-2 T6 (C8, requirement 1e): ONE QUERY on the spine, taken at turn start (see
  // `openHumanWorkAtTurnStart` above), not the length of an array the loop had to build.
  // `hasUnansweredUser` still routes the TURN — it needs the conversations themselves —
  // but the settled consumers only ever needed the boolean, and building fifty rows with a
  // per-row origin re-derivation to learn it is the shape requirement 1e exists to remove.
  const settledContextWakeTurn = !openHumanWorkAtTurnStart;
  // Two readings of ONE fact, so a disagreement is a finding rather than a mystery. The
  // ticket gate and the waiting set apply the same `deriveOrigin` verdict to the same rows,
  // so they can only diverge on a ticket whose root message is gone, or on a producer that
  // opened one for something that is not a person asking — both defects, and both worth a
  // line in the log the day they appear. (They are the unauthorized-ticket family C7
  // disposes of, and this line is how a new producer of them announces itself.)
  if (openHumanWorkAtTurnStart !== hasUnansweredUser) {
    logger.warn('v2: the settled read and the waiting set DISAGREE about whether a person is waiting', {
      agentId, openHumanWorkAtTurnStart, waitingConversations: waitingConvs.length,
    }, agentId);
  }
  // RC-5.2: a NOTIFICATION turn, a wake with no trigger row, not A2A, not an engine
  // event, whose newest inbound row is an UNAUTHORIZED human notice (a mailbox event
  // about the owner's inbox, an unknown sender). resolveTurnCounterparty on a null
  // trigger falls through to the owner-on-dashboard header, which the awareness lane
  // contradicts; on the weak model the header won and every notification read as an
  // open channel to the owner. isNotificationTurn drives a dedicated header variant
  // (renderCounterpartyHeader) that tells the model NOT to greet/message the user
  // unless the item genuinely matters, and to end with [no-reply] otherwise. Distinct
  // from isEngineTurn (a scheduler/reminder the agent must act on) and from a settled
  // wake whose newest inbound was an already-answered authorized ask.
  const isNotificationTurn =
    !triggerRow &&
    !isA2ATurn &&
    !isEngineTurn &&
    mostRecentInbound != null &&
    mostRecentInbound.lane !== 'events' &&
    !mostRecentInbound.a2a_thread_id &&
    deriveOrigin({
      role: 'user',
      content: mostRecentInbound.content,
      ...legacyOriginInputs(mostRecentInbound.lane, null),
      sourceAgentId: mostRecentInbound.source_agent_id,
      a2aThreadId: mostRecentInbound.a2a_thread_id,
      a2aIntent: mostRecentInbound.a2a_intent,
      a2aRequiresResponse: mostRecentInbound.a2a_requires_response,
      inboundMeta: mostRecentInbound.inbound_meta,
      originIntent: mostRecentInbound.origin_intent,
    }).authorized === false;
  // Mark the engine event PROCESSED at pickup (mirrors the human pickup-stamp) so it
  // can't re-fire and so getPendingEngineEvent stops returning it.
  //
  // PHASE-2 T9: the sentinel `conv_key='engine'` is gone. "Processed" is `served_by_turn`,
  // the real serve edge, which this turn already stamps on this very row below — so the
  // ATOMIC claim moved down there (`claimEngineEventByRowid`), where the turn number it
  // records exists. What is left here is the cheap READ of the same edge, which still bails
  // the common stray-process case before the turn does any work.
  if (isEngineTurn && pendingEngineEvent) {
    let engineClaimed = true;
    try {
      engineClaimed = isRowUnserved(pendingEngineEvent.rowid, agentId);
    } catch { /* best effort: the CAS below is the authoritative answer */ }
    // D8: remember OUR intent to claim; `claimedEngineEvent` is only SET once the CAS wins,
    // so a no-answer abort can revert exactly what it took (see revertTriggerStampOnAbort).
    if (engineClaimed) sc.pendingEngineClaim = { rowid: pendingEngineEvent.rowid };
    // P1 lineage spine: this turn serves the engine event; if the row carries a
    // run/task referent (migration 112 columns), the root is that occurrence,
    // and the served task's kind/origin are published to turn-state so lanes
    // (reminder delivery) can read what this turn's output belongs to.
    if (engineClaimed) {
      turnCtx.root = pendingEngineEvent.runId
        ? { kind: 'occurrence', id: pendingEngineEvent.runId, sourceMessageId: null }
        : { kind: 'engine', id: pendingEngineEvent.id, sourceMessageId: null };
      if (pendingEngineEvent.taskId) {
        try {
          // PHASE-6 T0D: the map used to be set even when this read came back
          // EMPTY, publishing a dead task id to five readers — `stale-work-ids.ts`.
          const served = resolveServedWork(pendingEngineEvent.taskId, pendingEngineEvent.runId);
          if (served) turnCtx.servedWork = served;
          else {
            logger.warn('v2: the engine event names a task row that is not there; serving no work this turn', {
              agentId, taskId: pendingEngineEvent.taskId,
            }, agentId);
          }
        } catch { /* best effort; the lane simply stays inactive */ }
      }
    }
    if (!engineClaimed) {
      // C24: symmetry with the human pickup-claim above — the event is already served, so
      // ANOTHER process picked it up. Bail cleanly instead of running a DUPLICATE engine
      // turn. Single-process production never hits this; it guards stray dev `tsx watch`
      // processes on the one SQLite DB.
      logger.warn('v2: engine event already served, another process claimed it; skipping to avoid a duplicate engine turn', { agentId, rowid: pendingEngineEvent.rowid }, agentId);
      setAgentStatus(agentId, 'idle');
      return preflightAbandon('engine-event-claim-lost');
    }
  }

  // Now that the turn kind is known, record it and re-broadcast the working
  // status with it so the composer can stay quiet on pure A2A turns (unless
  // wordy mode is on). The DB status was already set to 'working' at turn start;
  // this is a broadcast-only update and the 30s heartbeat reads the same map.
  turnCtx.kind = isA2ATurn ? 'a2a' : 'user';
  // PHASE-6 T1: the two turn-entry clears here (`clearTurnReceipts`, `clearRecallBudget`)
  // are gone with their functions — C26's receipt register and RC-3's recall brake start
  // clean because the bag is new, not because two calls were remembered.
  broadcast({ type: 'agent:status', agentId, status: 'working', turnKind: isA2ATurn ? 'a2a' : 'user', userFacing: !!chosenConvKey });

  // Enforcer arms ONLY on A2A turns AND only for reply-needed intents. On a user
  // turn a pending/lingering A2A must not force a send_to_agent into the user-facing
  // reply. A terminal-wake turn is an A2A turn but is NOT reply-needed (the sender
  // handed back a deliverable and closed the thread), so a2aReplyContext stays null
  // and the missed-reply enforcer is not armed, exactly right: there is nothing to
  // reply to, only a deliverable to act on.
  const a2aReplyContext = isA2ATurn
    ? (unrepliedAssign
        ? { intent: unrepliedAssign.intent, threadShort: unrepliedAssign.threadShort, fromName: unrepliedAssign.fromName }
        : parseA2ATrigger(lastUserMessageContent))
    : null;
  const a2aReplyAssignMessageId = isA2ATurn ? (unrepliedAssign?.messageId ?? null) : null;
  // The A2A thread IDENTITY used to render the counterparty header and scope the
  // live tail (scopeToA2AThread). For a terminal wake there is no reply context, so
  // fall back to the terminal message's own thread/sender, without that, the
  // counterparty carries a null thread and scopeToA2AThread would drop the very
  // deliverable that woke the agent (the bug this fixes). Distinct from
  // a2aReplyContext, which stays null so the enforcer does not arm.
  const a2aCounterpartyIdentity = a2aReplyContext
    ?? (terminalWakeA2A
        ? { intent: terminalWakeA2A.intent, threadShort: terminalWakeA2A.threadShort, fromName: terminalWakeA2A.fromName }
        : null);

  return preflightProceed({
    mostRecentInbound, mostRecentIsA2A, terminalWakeA2A, hasUnansweredUser, isA2ATurn,
    terminalWakeDrivesTurn, pendingEngineEvent, isEngineTurn, settledContextWakeTurn,
    isNotificationTurn, a2aReplyContext, a2aReplyAssignMessageId, a2aCounterpartyIdentity,
  });
}
