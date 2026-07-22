// ════════════════════════════════════════
// v2 control shell, runV2Turn
//
// The entire agent runtime. ~400 line target. Replaces v1's 2055-line
// runAgentLoop. Phase 2 implementation: real behavior wired throughout.
//
// Per Part XIX (preservation contract), every v1-visible behavior must
// work identically, see agent/v2/PRESERVATION_CHECKLIST.md.
//
// Phase 2 covers:
//   ✓ All 7 phases as real functions
//   ✓ All 14 Phase-1 classifiers wired
//   ✓ TRUE streaming (chunks broadcast immediately, not buffered)
//   ✓ complete_task / image_create loop exit
//   ✓ Status heartbeat preserved
//   ✓ Stop / preempt preserved (via shared-state)
//   ✓ Cost recording + embedding queueing preserved
//   ✓ chat:tool_call / chat:tool_result / chat:message broadcasts preserved
//   ✓ Synthetic Cancelled tool results when stopped mid-batch
//   ✓ Engine-injected ack (via ackInjector)
//   ✓ Tool partitioning (safe → parallel, others → serial)
//   ✓ Loop break detection (via loopDetector)
//   ✓ Permission denial nudging (via permissionAlternativeFinder)
//   ✓ Tracker enforcement (engine-side, no tool_use in context)
//   ✓ Spinning detection with model nudge (via progressClassifier)
//
// Landed since (via the remediation work):
//   ✓ Phase 3.5, large-files.ts removed; file_read has offset/limit
//   ✓ Phase 4, compaction + scaffolding reworked (memory remediation)
//   ✓ Phase 5, system-prompt diet (names-only tool index, trimmed SOUL)
// Still deferred (no inline markers; tracked here):
//   • Phase 6, full unified error cascade (Dreamer special case, etc.)
//   • Phase 7, squad shared memory namespaces
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import type Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../../logger.js';
import { getDb } from '../../db/connection.js';
import { broadcast } from '../../gateway/ws.js';
import type { Message, ToolCall, Channel } from '@dojo/shared';
// classifyTool is the canonical effectful/retrieval/bookkeeping classifier
// (test-covered against the full tool registry); the closeout machinery
// derives "did this turn do real work" from it instead of a hand list that
// drifted (missed every _ms variant and user_ twin, see countsAsTaskWork).
import { classifyTool } from '@dojo/shared';
import { deriveOrigin } from '@dojo/shared';

import { assembleContext } from '../../memory/assembler.js';
import { callModel, getContextWindow, STREAM_IDLE_TIMEOUT_ERROR } from '../model.js';
import { writeContextReceipt } from './receipt.js';
import { executeTool, agentCanSelfCompleteById } from '../tools.js';
import { resolveRecipientDisplay } from '../../contacts/resolve-recipient.js';
import { hasHandedCredentialValues, redactHandedCredentials } from '../../credentials/tools.js';
// recordError intentionally NOT imported, handleMessage's catch path calls
// it. Calling here would double-count errors and trip the loop-detector
// pause prematurely.
import { AgentError, clearErrors } from '../errors.js';
import {
  parseSafeSenders,
} from '../../services/imessage-bridge.js';
import { resolveInbound } from './inbound-channel.js';
// recordCost intentionally NOT imported, callModel records cost internally.
import { queueEmbedding } from '../../memory/embeddings.js';
import { isPrimaryAgent, isTrainerAgent, isPMAgent, isHealerAgent, isDreamerAgent } from '../../config/platform.js';
import os from 'node:os';
import path from 'node:path';
import { turnBoundary, forceA2ATurn, lastTurnWasA2A, currentTurnKind, currentTurnConvKey, currentTurnImRecipient, currentModelRequestId, currentTurnNumber, currentTurnRoot, currentTurnServedWork, currentToolCallId, continuationContext, clearTurnReceipts, clearRecallBudget, accumulateUntrackedWorkAcrossTurns, getUntrackedWorkAcrossTurns, clearUntrackedWorkAcrossTurns } from '../turn-state.js';
import { persistEngineSteer } from './engine-steer.js';
import { pushEngineMessage } from './engine-message.js';
import { findRecentDeliveries, findRecentDeliveriesKeyed, getRecentOutbound, mostRecentDeliveryTo, mostRecentDeliveryToConversation, relativeTimeAgo, channelLabel } from './outbound-ledger.js';
import { writeToolReceipt } from '../../receipts/store.js';
import { resolveToolAlias } from '../../tools/aliases.js';

import {
  stoppedAgents,
  preemptedAgents,
  activeAbortControllers,
  pendingWakeups,
  statusHeartbeats,
  turnContinuationCounts,
  recoveryRunStreak,
  backgroundDrains,
} from '../shared-state.js';

// Force-import side-effect: also register the runtime singleton getter so v2
// can fire self-continuation handleMessage() calls (matches v1 behavior).
import { getAgentRuntime } from '../runtime.js';

import {
  type AgentTurnState,
  initState,
  advance,
  bumpLoopSignature,
  nextOutputEscalation,
} from './state.js';

import { partitionTools, type ToolBatch } from './classifiers/concurrency.js';
import { complexityClassifier } from './classifiers/complexity.js';
import { loopDetector, RECENT_TOOL_WINDOW, canonicalToolSignature, isNearDuplicateText } from './classifiers/loop.js';
import { recordToolOutcome, crossTurnFailureNote } from './attempt-record.js';
// Engine message-injection now flows exclusively through the registry channel
// (injectRegistryMessage); the legacy pushEngineMessage, detectContextGap, and
// getPromptAssemblerMode call sites were removed at R7b.
import { injectRegistryMessage, buildAssemblyContext } from '../../prompt/registry/assembler.js';
import type { AssemblyContext } from '../../prompt/registry/types.js';
import { isDestructiveCall, manifestPermitsDestructiveCall, consumeApproval, requestApproval } from '../destructive-gate.js';
import { recipientIdsMatch } from '../recipient-identity.js';
import { fileHealerApprovalProposal, markHealerProposalAppliedBySignature, maybeAutoApproveHealerScratch } from '../../healer/approval-routing.js';
import {
  isStructuringTool,
  isLoadCountExemptRead,
  LOADING_GATE_THRESHOLD,
  LOADING_RESULT_MIN_TOKENS,
} from './classifiers/hoarding.js';
// ackInjector intentionally NOT imported, engine ack disabled per invariant
// review (see "Engine-injected ack, DISABLED" comment below).
import { composeStartAck, composeCompletionAck, extractDeliverableLinks, condenseResultProse, isForwardPromiseReply, pickA2AHandoffAck } from './ack-copy.js';
import { findCrossConvReAnswer } from './re-answer-guard.js';
import { compactionGate } from './classifiers/compaction.js';
import { checkAndCompact, estimateAssembledTokens, getUncompactedGapCount, UNCOMPACTED_GAP_THRESHOLD, TOOL_AND_OUTPUT_RESERVE } from '../../memory/compaction.js';
import { estimateTokens } from '../../memory/store.js';
import { insertInterAgentEngineRow, insertInterAgentOwnOutput, tagInterAgentOwnOutputConvKey } from '../../memory/interagent.js';
import { buildOpenLoopsInjection } from '../../memory/open-loops.js';
import { a2aReplyEnforcer, parseA2ATrigger } from './classifiers/a2a.js';
import { resolveTurnCounterparty, getWaitingHumanConversations, getPendingEngineEvent, recordEngineEventDeliveryFailure, claimAssembledSiblings, getOwedMidTurnArrivals, conversationKey, type TurnCounterparty, type EngineEventSrc } from './counterparty.js';
import { resolveOwnerAffinityChannel, affinityPromotionAllowed, recordAffinityPromotion, affinityPromotionRefusedNoBasis } from './owner-affinity.js';
import { getProactiveSendStreak, bumpProactiveSendStreak, resetProactiveSendStreak, PROACTIVE_SEND_DEMOTE_THRESHOLD } from './proactive-budget.js';
import { findUnrepliedAssignForAgent, hasPriorReplyOnThread } from '../a2a-replies.js';
import { outputTruncationClassifier, outputPersistenceClassifier, sanitizeAssistantText, isGenericCloseout, stripLeadingTimeStamp } from './classifiers/output.js';
import { identicalCallSignature, checkIdenticalCallRefusal, recordIdenticalCallResult, isSignatureTerminal, type RepeatCallState } from './identical-call-brake.js';
import { SEND_TO_PEOPLE } from '../sensei-policy.js';
import { getPresence } from '../../services/presence.js';
import { recordTurnStart, finalizeTurn } from './turn-record.js';
import { recordDelivery, type DeliveryInput } from './deliveries.js';
const SEND_TO_PEOPLE_SET: ReadonlySet<string> = new Set(SEND_TO_PEOPLE);
import { detectUngroundedDeliveryClaim, detectDeliveryDenial } from './classifiers/grounding.js';
import { progressClassifier, buildSpinningNudge } from './classifiers/progress.js';
import { permissionAlternativeFinder } from './classifiers/permission.js';
import { semanticTechniqueMatches, SEMANTIC_STRONG_THRESHOLD, buildTechniqueMatchQuery } from './classifiers/technique.js';
import { listTechniques } from '../../techniques/store.js';

const logger = createLogger('v2-loop');

/** Max send_to_agent / broadcast_to_group calls to ONE recipient in a single
 *  turn before the re-send cap refuses further sends to them. Set well above any
 *  genuine multi-send (two distinct messages, a retry or two) so it only ever
 *  catches a pathological async re-send loop. */
const A2A_SEND_CAP_PER_RECIPIENT = 5;

/** Standard tail appended to false-positive-prone engine refusals: makes the
 *  agent the tripwire for a wrong block. The engine can't always tell a genuine
 *  action from a pathological one, so when it refuses, the agent, which DOES
 *  have the context, is told to surface a wrong-looking block to the user
 *  instead of silently giving up. Strictly additive: it never blocks anything,
 *  it only adds a chance the user hears about a block that shouldn't have
 *  happened. (Model-dependent, so not a guarantee, a safety net, not a gate.) */
const ENGINE_BLOCK_ESCAPE_HATCH =
  'If you believe this block is a mistake and it is stopping something the user genuinely needs, ' +
  'do NOT silently give up, tell the user what you were trying to do and that the engine blocked it, ' +
  'so they can decide.';

// Fire-and-forget media generators. Each posts a "started" ack and delivers
// the finished asset later as a synthetic message (from a background worker
// or poller), so the agent must NOT get a second turn, the loop exits
// immediately after one of these is called. This is the engine-enforced
// version of the tool result's "end your turn now" instruction, so a
// disobedient model can't retry-storm.
//
// HAND-PICKED, NOT DERIVABLE: this is the CLOSED set of async media-capability
// generators wired to the background-delivery pipeline (image/tts/music/video).
// "effectful-action" is far too broad, a gmail_send is effectful but is NOT
// fire-and-forget. Membership is tied to the delivery wiring, not the verb, and
// a new media generator would have to be wired here deliberately anyway.
const FIRE_AND_FORGET_GEN_TOOLS = new Set([
  'image_create',
  'tts_create',
  'music_create',
  'video_create',
]);

// v2.5.9, Just-in-time visibility hint helper.
//
// When a tool result contains content the user will not see (URLs the
// agent might want to share, file paths from the shared uploads dir),
// append a small informational note so the agent knows the user can't
// read its tool results directly. The note is intentionally NEUTRAL, 
// it doesn't tell the agent it MUST surface anything, just clarifies the
// visibility model. The agent retains full discretion about what to
// share, what to summarize, and what to keep internal.
//
// Trade-off: ~50 tokens per triggering tool result, vs. spending the
// same tokens in the system prompt every turn whether or not relevant.
const VISIBILITY_HINT = `\n\n[VISIBILITY: tool results are shown only to you, not to the user. The user sees only your reply text and any files you attach via show_to_user. If you want them to have a URL or detail from this result, include it inline in your reply, they cannot "see above". If there's nothing here worth surfacing, no action needed.]`;

// Match http(s) URLs OR file paths under the shared uploads dir.
// Conservative: only triggers on patterns that are typically things the
// agent might want to surface, not generic mentions of paths/URLs.
const VISIBILITY_TRIGGER_RE = /https?:\/\/\S+|[~/]\.dojo\/uploads\//;

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

function appendVisibilityHintIfRelevant<T extends { content?: string; isError?: boolean }>(toolResult: T): T {
  // Skip on errors, error messages aren't artifacts to share.
  if (toolResult.isError) return toolResult;
  const content = toolResult.content;
  if (typeof content !== 'string' || !content) return toolResult;
  if (!VISIBILITY_TRIGGER_RE.test(content)) return toolResult;
  return { ...toolResult, content: content + VISIBILITY_HINT };
}

// v2.7.22, Soft nudge after internal-bookkeeping tools. These tools
// (vault_remember, tracker_update_status, complete_task, credential_*,
// etc.) reliably trigger the model's "wrap up with a closeout line"
// reflex even though the prompt teaches [no-reply] as the escape
// hatch. The prompt sits at the top of the context; the tool result
// sits at the bottom right next to the model's next decision. This
// nudge appends a one-line reminder INSIDE the tool result so the
// escape hatch is in the model's face at the exact moment it would
// otherwise default to "All set." or "Done."
//
// Soft, not destructive: we don't strip anything; we only inform.
// The model still chooses. If a substantive reply is warranted (user
// asked a real question, work isn't done, etc.), it can ignore the
// nudge and write whatever it wants. Same machinery as the visibility
// hint above, append-on-condition, no behavior change to the tool.
//
// HAND-PICKED, NOT DERIVABLE: this is a curated subset of bookkeeping tools
// that specifically trigger the model's "wrap up with a closeout line" reflex
// when they are the LAST thing the user asked for ("save my key", "remember
// that"). It is intentionally narrower than classifyTool === 'bookkeeping' (we
// do not nudge after a scratchpad_set or a tracker read); drift here only mutes
// a soft nudge on a new tool, never a correctness issue.
const BOOKKEEPING_NUDGE_TOOLS = new Set([
  'tracker_update_status',
  'tracker_complete_step',
  'complete_task',
  'vault_remember',
  'vault_update',
  'vault_forget',
  'credential_add',
  'credential_update',
  'credential_delete',
]);

const BOOKKEEPING_NUDGE = `\n\n[Engine note: this was internal bookkeeping. If the user just asked you to do exactly this (e.g. "save my key", "remember that", "delete X"), reply with ONE short line confirming it is done (e.g. "Saved.", "Got it, stored your OpenWeather key.") so they get acknowledgment. If instead this was incidental to other work, something you did on your own initiative, or the user already has what they needed, end the turn with literal \`[no-reply]\` rather than a generic "Done." / "All set." / "Got it." closeout.]`;

// Marker-aware variant. When the task being closed belongs to a USER-REQUESTED
// project (its project description carries ENGINE_AUTO_MARKER, set by the
// turn-start multistep classifier when the user asked for the work), the
// [no-reply] branch is WRONG: a live failure had the floor model close a
// user-requested itinerary task and then go silent because the generic note
// offered exactly that escape. So for user-requested closes the note drops the
// [no-reply] option entirely and asks plainly for the outcome + any link. The
// generic note above stays for genuinely incidental / self-initiated
// bookkeeping, where silence is still the right call.
const BOOKKEEPING_NUDGE_USER_REQUESTED = `\n\n[Engine note: the user asked you to do this, so it is not incidental bookkeeping. Reply to them now with the outcome in one short line, and if your tool results above produced a link or file for them (a "Link:", "Open:", or "Share link:" line), include that link in your reply so they can open it. Do NOT end this turn with [no-reply].]`;

// Mirror of ENGINE_AUTO_MARKER in classifiers/multistep.ts (same duplication
// tracker/tools.ts keeps, to avoid a static import of the classifier from this
// hot path). The turn-start classifier prefixes it onto the PROJECT description
// of any user-requested multi-step work.
const ENGINE_AUTO_MARKER_MIRROR = '[engine:multistep] ';

// The two close tools whose task_id lets us tell a user-requested close from
// incidental bookkeeping. vault_*/credential_* have no task, so they always get
// the generic note (their [no-reply] reason is real).
const CLOSE_TOOLS_WITH_TASK_ID = new Set(['tracker_update_status', 'tracker_complete_step']);

/**
 * True when this close targets a USER-REQUESTED task (project description
 * carries the ENGINE_AUTO_MARKER) that the user has NOT yet been answered for,
 * i.e. the case where the "reply now with the outcome" note belongs instead of
 * the [no-reply] one. Reads the task by its task_id argument (full UUID or
 * 8-char prefix). Returns false, so the generic note (which keeps the [no-reply]
 * escape) is used, when: not a marker task, OR the user already received a
 * substantive reply for this work since the task was created (a silent
 * cross-turn close where silence IS correct, the same case the completion-ack
 * dedup handles). Synchronous DB reads, best-effort: any miss returns false.
 */
function userRequestedCloseWantsReply(
  toolName: string | undefined,
  args: Record<string, unknown>,
  agentId: string,
): boolean {
  if (!toolName || !CLOSE_TOOLS_WITH_TASK_ID.has(toolName)) return false;
  const rawId = args?.task_id;
  if (typeof rawId !== 'string' || !rawId.trim()) return false;
  const id = rawId.trim();
  try {
    const db = getDb();
    const task = db.prepare(`
      SELECT t.created_at AS created_at, t.source_message_id AS source_message_id FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.assigned_to = ?
        AND (t.id = ? OR t.id LIKE ?)
        AND (p.origin_kind = 'engine_scaffold' OR p.description LIKE ?)
      LIMIT 1
    `).get(agentId, id, `${id}%`, `${ENGINE_AUTO_MARKER_MIRROR}%`) as { created_at: string; source_message_id: string | null } | undefined;
    if (!task) return false;
    // Already answered, P4 rekey: the ask row that BIRTHED this task records
    // the reply that answered it (answer_message_id, migration 113). A keyed
    // read replaces the length>40 adjacency probe; the probe survives only as
    // the pre-spine fallback for rootless tasks.
    if (task.source_message_id) {
      const askAnswered = db.prepare(
        'SELECT answer_message_id FROM messages WHERE id = ?',
      ).get(task.source_message_id) as { answer_message_id: string | null } | undefined;
      if (askAnswered) return askAnswered.answer_message_id == null;
    }
    const alreadyAnswered = !!db.prepare(`
      SELECT 1 FROM messages
      WHERE agent_id = ? AND role = 'assistant' AND created_at >= ?
        AND (source IS NULL OR source != 'a2a')
        AND content NOT LIKE '[{%'
        AND origin_intent IS NULL
        AND length(trim(content)) > 40
      LIMIT 1
    `).get(agentId, task.created_at);
    return !alreadyAnswered;
  } catch {
    return false;
  }
}

// v3.1.11 (FN-9) + FA-T2: tracker mutation tools partitioned by whether a call
// proves the worker is TENDING open multi-step work.
//
// DISARMING (open / advance-to-active): creating a project or task, adding
// notes, editing a task/project, or advancing a step. A call to one of these
// means the agent is actively opening or pushing its work forward, so it
// disarms the multi-step enforcement floor (state.trackerWriteThisTurn).
//
// NON-DISARMING (close / abandon / handoff), and so DELIBERATELY absent:
// tracker_close_project, tracker_reassign_task, tracker_resolve_missed_runs, and
// tracker_update_status when its status ARGUMENT is a terminal / non-active value
// (complete / fallen / paused / blocked). These REMOVE or hand off the thing the
// PM watches, so they must NOT disarm, otherwise new multi-step work started
// LATER in the same turn rides in behind an earlier close and escapes both the
// nudge and the floor (FA-T2). For those the floor falls through to the
// hasRecentlyTendedTask DB check, which reflects whether an OPEN task actually
// still exists after the mutation.
//
// READS (tracker_get_status / tracker_list_active) are absent from both sets: a
// bare status peek never disarms enforcement (FN-9 invariant). PM / validation-
// lane governance tools (tracker_validate, tracker_retask, tracker_override,
// tracker_request_override, tracker_request_user_verdict,
// tracker_apply_user_verdict, tracker_apply_user_validation,
// tracker_pause_schedule, tracker_resume_schedule) are also absent: those are
// override/governance actions, not a worker opening or advancing its own task.
const TRACKER_DISARMING_MUTATION_TOOLS = new Set([
  'tracker_create_project',
  'tracker_create_task',
  'tracker_add_notes',
  'tracker_edit_task',
  'tracker_edit_project',
  'tracker_complete_step',
]);

// FA-T2: tracker_update_status disarms the floor ONLY when its status argument
// ADVANCES the task to an active state. These are the canonical active statuses
// plus the weak-model synonyms the tracker_update_status normalizer accepts for
// them (kept in sync with STATUS_SYNONYMS in tracker/tools.ts). A transition to
// complete / fallen / paused / blocked, an update with no status (a bare
// reassign/repriority), or an unrecognized value is NOT advancing and does not
// disarm, it falls through to the hasRecentlyTendedTask DB check. That is safe
// by construction: mis-reading an advancing synonym as non-advancing only defers
// to the DB, which then sees the freshly-tended open task and suppresses anyway;
// only wrongly reading a CLOSING status as advancing would be a real disarm hole,
// and this set never contains a terminal value.
const ADVANCING_STATUS_ARGS = new Set([
  'in_progress', 'inprogress', 'working', 'active', 'doing', 'started', 'wip',
  'on_deck', 'ondeck', 'todo', 'to_do', 'queued', 'backlog', 'pending',
]);
function isAdvancingStatusArg(rawStatus: unknown): boolean {
  if (typeof rawStatus !== 'string') return false;
  const key = rawStatus.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ADVANCING_STATUS_ARGS.has(key);
}

// FA-T3: read-only reconnaissance / utility / bookkeeping tools that do NOT
// count as multi-step WORK for the tracker floor. Mirrors the carve-out from the
// deleted classifiers/tracker.ts (get_current_time, load_tool_docs, complete_task,
// vault_search/remember/forget, history_search/get/expand) and adds the obvious
// read-only LOOKUPS a pure reconnaissance turn is made of: checking email,
// calendar, texts, contacts, the vault, chat history, and the clock. Before this,
// such a turn (~6 read-only lookups) tripped the >=6 work-call floor and
// auto-scaffolded a junk project, which then failed the close-out gate,
// auto-paused, and fired CLOSEOUT_MISS at the PM. Trivial lookups are not
// multi-step work.
//
// The line drawn: "looking things up" (your inbox / calendar / contacts / vault /
// history / the clock) is trivial; "producing or transforming an artifact" is
// work. So file_read is DELIBERATELY NOT here, reading a file to act on it is
// real work, and the untracked-multistep-floor scenario locks file_read +
// file_write as the NON-trivial signal that must keep driving the floor.
// Likewise exec, every send / create / write, and document/drive/pdf reads stay
// NON-trivial. (tracker_* reads are already excluded upstream by the tracker_
// prefix filter, so they aren't listed here.)
const TRIVIAL_TOOLS = new Set([
  // Time / utility (no artifact, no side effect)
  'get_current_time',
  'convert_time',
  'load_tool_docs',
  'complete_task',
  // Vault (search/get are reads; remember/forget are bookkeeping per the deleted carve-out)
  'vault_search',
  'vault_get',
  'vault_remember',
  'vault_forget',
  // Chat-history recall (read-only context recovery)
  'history_search',
  'history_get',
  'history_expand',
  'recall_recent_thread',
  // Read-only view surface
  'canvas_read',
  // Contacts / texts lookups
  'imessage_list_contacts',
  'contacts_search',
  'contacts_list',
  'contacts_get',
  // Email reconnaissance (list / search / inbox), Google + Microsoft
  'gmail_search',
  'gmail_read',
  'gmail_inbox',
  'gmail_list_labels',
  'outlook_search',
  'outlook_read',
  'outlook_inbox',
  // Calendar reconnaissance (agenda / list / search / free-busy), Google + Microsoft
  'calendar_agenda',
  'calendar_search',
  'calendar_list',
  'calendar_freebusy',
  'calendar_agenda_ms',
  'calendar_search_ms',
  'calendar_list_ms',
  'calendar_freebusy_ms',
]);

function appendBookkeepingNudgeIfRelevant<T extends { name?: string; content?: string; isError?: boolean }>(toolResult: T, userRequestedClose = false): T {
  if (toolResult.isError) return toolResult;
  if (!toolResult.name || !BOOKKEEPING_NUDGE_TOOLS.has(toolResult.name)) return toolResult;
  const content = toolResult.content;
  if (typeof content !== 'string') return toolResult;
  const note = userRequestedClose ? BOOKKEEPING_NUDGE_USER_REQUESTED : BOOKKEEPING_NUDGE;
  return { ...toolResult, content: content + note };
}

const STATUS_HEARTBEAT_INTERVAL_MS = 30_000;
// v3.1.11 (FN-9): "recently tended" window shared by the turn-start multistep
// guard and the runtime tracker floor. An assigned in_progress/on_deck task
// suppresses auto-scaffolding ONLY when it was touched within this window; a
// task that has gone quiet for longer is treated as stale and no longer
// disarms enforcement, so genuinely new untracked multi-step work can't ride
// in under an abandoned open task forever. Any tracker mutation bumps
// updated_at, so active cross-turn work naturally stays inside the window.
const STALE_TASK_WINDOW_MINUTES = 30;
const MAX_TOOL_LOOPS = 75;                     // matches v1
const TURN_TIME_BUDGET_MS = 15 * 60 * 1000;    // matches v1, 15 min/turn
const MAX_TURN_AUTO_CONTINUATIONS = 3;         // matches v1
const ACK_DEFAULT_TEXT = 'Working on it…';
// Elapsed-based start-ack floor (F10). The classifier and scaffold acks key off
// call accounting (project-worthy classification / 6 work calls), which can land
// long after the person started waiting or, on a quiet-phrased ask, never. This
// floor keys off the USER'S WAIT instead: quick lookups that finish in ~12s stay
// ceremony-free (the battery praised that), anything longer acks before the user
// starts wondering whether the agent heard them.
// Owner directive 2026-07-17: the ack is for work that takes LONGER than a
// person would normally wait for a reply, not for every turn that crosses a
// short threshold ("it fires for almost everything, even the smallest tasks").
// 12s acked nearly every tool-using turn on the floor model; 30s is roughly
// where a texting human starts wondering if they were heard.
const ENGINE_START_ACK_AFTER_MS = 30000;
// RC-4.4: streaming-race grace. When the start-ack timer / first-tool hook is about to
// fire but a model call is still streaming, wait up to this long for the real reply to
// land (startAckRepliedNow suppresses the ack then). Kills the F-11 double-ack (ack at
// +12s, model reply at +13s) while keeping the guarantee: a stalled model still gets the
// ack after the grace expires.
// Cap on waiting out an in-flight model call before the ack may speak anyway.
// Generous on purpose (the wait usually ends in the reply landing, which
// silences the ack entirely); the stream-idle watchdog owns truly hung calls.
const ENGINE_START_ACK_STREAM_GRACE_MS = 60000;

// ── Task-thrash detector ──
// Catches the "agent re-runs the SAME canonical tool call over and over"
// pattern.
//
// Signature semantics matter: reading 20 unique messages each once is NOT
// thrashing (the task asks for it). Reading the SAME message 4 times is.
// We key on canonicalToolSignature so a model that varies one parameter
// (limit=1000 vs no limit) doesn't slip past, but distinct args = distinct
// signatures = no false positive on legitimate iteration.
//
// REACTION (rewritten): instead of pausing the task and walking away
// (which strands work and forces the user to manually intervene), we
// inject a specific steer message naming the exact gated signature and
// activate a per-signature refusal gate. The agent can still call the
// same tool with DIFFERENT args. Only the exact spinning signature is
// refused. Cleared on any tracker_update_status.
//
// LAST RESORT: if the gate has had to refuse THRASH_GATE_BREAKER_LIMIT+
// calls without the agent transitioning, the engine auto-blocks the task
// so it reaches a real terminal state instead of looping.
// P6b-2 REKEY: the window is TURN IDENTITY, not wall clock. The old 2-minute
// clock was load-dependent (a slow provider saw fewer calls in the window and
// missed thrash; a fast one over-counted); the current turn plus its
// predecessor (auto-continued spirals span the boundary) is the same
// semantic window keyed on execution identity.
const THRASH_TURN_WINDOW = 1; // current turn and this many before it
const DUPLICATE_SIG_LIMIT = 4;
const THRASH_GATE_BREAKER_LIMIT = 6;
// Soft drift threshold: the engine NUDGES the agent once (no block), legitimate
// progress also varies signatures, so a block here would false-positive.
const THRASH_GATE_DRIFT_LIMIT = 8;
// Hard drift threshold: well above the soft one. If the agent keeps varying call
// signatures to dodge the gate for THIS many iterations DESPITE the nudge, it is a
// genuine signature-varying spiral (which never increments the refusal count, so the
// refusal-breaker never catches it), terminally block so it can't loop unbounded
// across auto-continued turns (comms-audit REG-1). The gap between 8 and 24 gives a
// genuinely-working task ample room past the nudge before any block.
const THRASH_GATE_DRIFT_HARD_LIMIT = 24;

// F12.5: shared derivation of an auto-scaffold title from a raw user message.
// Both scaffold sites (turn-start classifier + mid-turn engine floor) used to
// slice the raw prompt, producing kanban titles like "Can you go through my
// inbox and put together a lis". Strip leading politeness/filler, truncate at a
// word boundary within ~50 chars, capitalize. May return '' (no meaningful
// content), callers apply their own fallback. The PM rename handoff still runs
// afterward to give a proper umbrella name; this only makes the interim name
// readable instead of a mangled slice.
function deriveScaffoldTitle(raw: string): string {
  let s = (raw ?? '').split('\n')[0].trim();
  // Repeatedly strip leading politeness/filler so "Hey, can you ..." also cleans up.
  const FILLER_PREFIX = /^(can you|could you|would you|will you|please|hey|hi|ok so|okay so|ok|also)\b[,:\s]*/i;
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(FILLER_PREFIX, '').trimStart();
  }
  if (s.length > 50) {
    const cut = s.slice(0, 50);
    const lastSpace = cut.lastIndexOf(' ');
    s = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
  }
  s = s.replace(/[.!?]+$/, '').trim();
  if (s.length === 0) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// F9 (harness finding): the user EXPLICITLY routed work to the agent's own
// agents and the floor model silently did it itself, never mentioning the
// choice. Owner stance (middle): the agent keeps judgment, but the routing
// instruction must be SURFACED (delegate, or say why not); a silent override
// must be impossible in practice. This conservative detector recognizes an
// EXPLICIT routing instruction so the engine can inject the advice-voice steer.
//
// Anchor on an imperative delegation VERB + a "your agent(s)/team" object, or
// the word "delegate" used as a verb, or an explicit "spawn/spin up ... agent".
// It must NOT fire on mere MENTIONS of agents ("do you have any agents?", "how
// many agents...", "your agents are great"), so a bare noun reference never
// matches. Canonical positive (the battery phrase):
//   "Have one of your agents research it and report back to me."
const DELEGATION_PATTERNS: readonly RegExp[] = [
  // Imperative delegation verb targeting the agent's OWN agents/team. Requires
  // the possessive "your" (optionally "one of your ..."), so "do you have any
  // agents?" / "have you seen my agent" never match.
  /\b(have|get|ask|tell|assign|task)\s+(one of\s+)?your\s+(agents?|sub-?agents?|team|helpers?|assistants?)\b/i,
  // "delegate" as a verb with a work object ("delegate this/it/that", "delegate
  // the research"). \s after the word excludes "delegated"; a pronoun/the-object
  // excludes the noun "the delegate for ...".
  /\bdelegate\s+(this|it|that|these|those|the\b)/i,
  // "hand this/it (off) to (one of) your/an agent(s)/team". "the team" (not
  // "your"/"a"/"an") does not match, so "hand this to the team lead" is out.
  /\bhand\s+(this|it|that|these|those)\s+(off\s+)?to\s+(one of\s+)?(your|an?)\s+(agents?|sub-?agents?|team|helpers?)\b/i,
  // Explicit "spawn/spin up ... agent" (with an agent object, so "salmon spawn
  // in the river" and "the spawn point" never match).
  /\b(spawn|spin ?up|fire ?up|kick ?off)\s+(a |an |another |one )?(new\s+)?(sub-?)?agent\b/i,
];

/** True when the user text EXPLICITLY routes the work to the agent's agents. */
function detectExplicitDelegation(text: string): boolean {
  if (!text) return false;
  return DELEGATION_PATTERNS.some((re) => re.test(text));
}

// F9 hint body (shared by the live model-visible injection and the persisted
// EVENTS-lane row). Advice voice per the precedence ladder (tier-7), never an
// order. No em-dashes; plain layman language.
const DELEGATION_HINT_BODY =
  'the user explicitly asked for this to be delegated to one of your agents. ' +
  'Either delegate it (spawn_agent for a fresh helper, or send_to_agent to task ' +
  'an existing one) and synthesize the result back to the user, or, if doing it ' +
  'yourself is clearly better here, briefly tell the user you are handling it ' +
  'directly and why. Do not silently override their routing instruction.';

// F12.5: fire-and-forget PM rename handoff, factored out so BOTH scaffold sites
// (turn-start classifier and mid-turn engine floor) hand the ugly interim names
// to the PM agent to rewrite on its own turn via its local model. The user-facing
// agent never waits; a failed PM call just leaves the interim names in place.
async function dispatchPMRenameHandoff(params: {
  callingAgentId: string;
  projectId: string;
  taskId: string;
  projectTitle: string;
  taskTitle: string;
  originalPrompt: string;
}): Promise<void> {
  try {
    const { getPMAgentId, getPMAgentName, getPrimaryAgentName } = await import('../../config/platform.js');
    const pmId = getPMAgentId();
    const pmName = getPMAgentName();
    const primaryName = getPrimaryAgentName();
    if (!pmId || !pmName) return;
    const renameRequest = (
      `[ENGINE RENAME REQUEST] An auto-created project needs better names. ` +
      `The multi-step classifier just opened this from a user prompt and named both the project ` +
      `and the first task with a slice of that prompt, looks bad on the kanban.\n\n` +
      `Project id: ${params.projectId}\n` +
      `Current project title: ${params.projectTitle}\n` +
      `First task id: ${params.taskId}\n` +
      `Current first-task title: ${params.taskTitle}\n\n` +
      `Original user prompt:\n${params.originalPrompt.slice(0, 1500)}\n\n` +
      `Please call tracker_edit_project(project_id="${params.projectId}", title="<short 3-6 word umbrella name>") ` +
      `and tracker_edit_task(task_id="${params.taskId}", title="<short 3-6 word first-step name>"). ` +
      `The project name describes the WHOLE effort; the first-task name is the first concrete thing to do. ` +
      `Make them distinct, don't reuse the same string for both. After both edits land, send NO message ` +
      `back to anyone, this is a silent rename. Do not contact ${primaryName}.`
    );
    const renameMsgId = uuidv4();
    const db = getDb();
    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'user', ?, datetime('now'))
    `).run(renameMsgId, pmId, renameRequest);
    broadcast({
      type: 'chat:message',
      agentId: pmId,
      message: {
        id: renameMsgId, agentId: pmId, role: 'user' as const,
        content: renameRequest,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
    // Fire-and-forget wake. handleMessage queues itself if PM is busy.
    void getAgentRuntime().handleMessage(pmId, renameRequest).catch(err => {
      logger.warn('v2 multistep: PM rename wake failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      }, params.callingAgentId);
    });
    logger.info('v2 multistep: dispatched PM rename request', {
      agentId: params.callingAgentId, pmId, projectId: params.projectId, taskId: params.taskId,
    }, params.callingAgentId);
  } catch (renameErr) {
    logger.warn('v2 multistep: PM rename dispatch failed (non-fatal)', {
      agentId: params.callingAgentId,
      error: renameErr instanceof Error ? renameErr.message : String(renameErr),
    }, params.callingAgentId);
  }
}

// D16 recipient comparison moved to agent/recipient-identity.ts (P5c rekey:
// canonical contact/safe-sender identity first, digit-tail heuristic only as
// the both-unknown fallback).

// Reminder-delivery lane (2026-07-21, battery root-cause find; P1 spine
// consumer #1). A reminder task is BY DESIGN a delivery to the owner (or a
// household member the owner named). Production/battery incident: on an
// engine turn serving a reminder, the floor model resolved "deliver this to
// the user" to the most RECENT human it had chatted with (a third-party
// iMessage contact) and texted owner-bound content there, recipient chosen
// explicitly by the model, so no recency-map fix could catch it. This helper
// answers "is this recipient the owner?" from the channel's own approved
// sender records (is_primary), phone-tolerant via recipientIdsMatch.
function recipientIsChannelOwner(toolName: string, recipient: string): boolean {
  try {
    const db = getDb();
    const raw = (db.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined)?.value ?? null;
    // Lazy import avoided: parseSafeSenders is a pure parser; require the
    // bridge module statically below via the existing import surface.
    const senders = parseSafeSenders(raw);
    const owners = senders.filter((x) => x.is_primary);
    for (const o of owners) {
      if (recipientIdsMatch(recipient, o.address) || recipientIdsMatch(recipient, o.name)) return true;
    }
  } catch { /* conservative: unknown = not owner */ }
  return false;
}

function detectTaskThrashing(agentId: string): {
  thrashing: boolean;
  toolName?: string;
  signature?: string;
  count?: number;
} {
  try {
    const db = getDb();
    // Turn-keyed window (P6b-2). Rows with NULL turn_number (pre-113 or the
    // odd unstamped write) fall out of the window, which fails SAFE for a
    // detector (missing one row can only under-count).
    const minTurn = (currentTurnNumber.get(agentId) ?? 0) - THRASH_TURN_WINDOW;
    const rows = db.prepare(`
      SELECT content FROM messages
      WHERE agent_id = ? AND role = 'assistant'
        AND turn_number >= ?
      ORDER BY created_at ASC, rowid ASC
    `).all(agentId, minTurn) as Array<{ content: string }>;

    // AUDIT-FIX (D5): mutating-tool progress must be SUCCESS-aware. tool_use blocks
    // carry no result, so a failing file_write counted as "progress" and disabled
    // this breaker for any window containing a mutating call (and the `continue`
    // also hid failing loops from the thrash counts). Build the set of FAILED
    // tool_use ids from the window's tool-result rows; a mutating call only counts
    // as progress when it did not fail, and a FAILED one is counted toward thrash.
    const failedToolUseIds = new Set<string>();
    try {
      const toolRows = db.prepare(`
        SELECT content FROM messages
        WHERE agent_id = ? AND role = 'tool'
          AND turn_number >= ?
      `).all(agentId, minTurn) as Array<{ content: string }>;
      for (const tr of toolRows) {
        let blocks: unknown;
        try { blocks = JSON.parse(tr.content); } catch { continue; }
        if (!Array.isArray(blocks)) continue;
        for (const b of blocks) {
          const blk = b as { type?: string; tool_use_id?: string; is_error?: boolean };
          if (blk?.type === 'tool_result' && blk.is_error && blk.tool_use_id) {
            failedToolUseIds.add(blk.tool_use_id);
          }
        }
      }
    } catch { /* best effort, without result rows, fall back to name-based */ }

    const counts = new Map<string, { count: number; toolName: string }>();
    let madeProgress = false;
    for (const row of rows) {
      let blocks: unknown;
      try { blocks = JSON.parse(row.content); } catch { continue; }
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        const block = b as { type?: string; id?: string; name?: string; input?: Record<string, unknown> };
        if (block.type !== 'tool_use') continue;
        const name = String(block.name ?? '');
        if (!name) continue;
        const failed = block.id != null && failedToolUseIds.has(String(block.id));
        // tracker_update_status / complete_task count as forward progress,
        // an agent that calls these is at least transitioning. Same for
        // send_to_user / chat-style replies (they finish the work).
        // D5 (2026-07-08 defect-class sweep): a SUCCESSFUL effectful-action tool
        // is ALSO forward progress. This used to be a hand list (isMutatingTool,
        // ~10 file/channel-send names) that missed every _ms / user_ / Google-
        // write / calendar / drive variant, so an MS-heavy or upload-heavy work
        // turn could look like non-progress and get thrash-flagged. classifyTool
        // is the canonical, verb-derived effect classifier: creating a calendar
        // event (calendar_create/_ms), uploading a file (drive_upload/onedrive_
        // upload), editing a doc, or sending on any channel all classify as
        // 'effectful-action' and correctly count as work. A FAILED call is NOT
        // progress and falls through into the thrash counts below. (A genuine
        // re-run of the IDENTICAL effectful call still trips loopDetector on its
        // canonical signature, so counting effectful success as progress here
        // does not open a thrash hole.)
        if (
          !failed && (
            name === 'tracker_update_status' || name === 'complete_task' ||
            name === 'tracker_complete_step' || name === 'tracker_add_notes' ||
            classifyTool(name) === 'effectful-action'
          )
        ) {
          madeProgress = true;
          continue;
        }
        const sig = canonicalToolSignature(name, block.input);
        const cur = counts.get(sig) ?? { count: 0, toolName: name };
        counts.set(sig, { count: cur.count + 1, toolName: name });
      }
    }
    if (madeProgress) return { thrashing: false };
    let topSig = '';
    let topCount = 0;
    let topName = '';
    for (const [sig, v] of counts) {
      if (v.count > topCount) { topCount = v.count; topSig = sig; topName = v.toolName; }
    }
    if (topCount >= DUPLICATE_SIG_LIMIT) {
      return { thrashing: true, toolName: topName, signature: topSig, count: topCount };
    }
    return { thrashing: false };
  } catch {
    return { thrashing: false };
  }
}


// ── Heartbeat (mirrors v1 helpers, local copy so v2 can run standalone) ──

function startStatusHeartbeat(agentId: string): void {
  const existing = statusHeartbeats.get(agentId);
  if (existing) clearInterval(existing);
  const timer = setInterval(() => {
    try {
      // Carry the current turn kind on EVERY heartbeat. Without it, the client
      // (Chat.tsx) treats a missing turnKind as 'user' and re-shows the working
      // UI (thinking dots + stop button) on the next tick, clobbering the 'a2a'
      // turnKind that the turn-start broadcast set, so inter-agent turns flashed
      // the working UI back into the user's chat every heartbeat interval.
      broadcast({ type: 'agent:status', agentId, status: 'working', turnKind: currentTurnKind.get(agentId) ?? 'user', userFacing: typeof currentTurnConvKey.get(agentId) === 'string' });
    } catch {
      /* best effort */
    }
  }, STATUS_HEARTBEAT_INTERVAL_MS);
  statusHeartbeats.set(agentId, timer);
}

function stopStatusHeartbeat(agentId: string): void {
  const timer = statusHeartbeats.get(agentId);
  if (timer) {
    clearInterval(timer);
    statusHeartbeats.delete(agentId);
  }
}

export function setAgentStatus(agentId: string, status: string): void {
  try {
    const db = getDb();
    // Capture the turn's human-conversation binding BEFORE the idle boundary below
    // deletes it. currentTurnConvKey is a non-null conv_key on a genuine human turn
    // (dashboard / iMessage / voice) and null on a pure background a2a / engine
    // turn. Threaded onto the broadcast as `userFacing` so the composer can tell an
    // "idle after a user turn" from an "idle after background noise" without
    // guessing: on a busy box a queued dashboard send must keep its working-UI latch
    // across a background turn's idle (see AgentStatusEvent.userFacing).
    const turnConvKeyAtStatus = currentTurnConvKey.get(agentId); // string | null | undefined
    const userFacingTurn = typeof turnConvKeyAtStatus === 'string' && turnConvKeyAtStatus.length > 0;
    // FA-A2: clear the diagnostic ONLY on a clean turn end ('idle'), not on the
    // 'working' transition. A turn that errors and retries goes working → error →
    // working; clearing last_error on 'working' wiped the diagnostic on every
    // retry and raced the Healer's grace-delayed notify. Clearing on 'idle' lets
    // it survive across retries and clears once the turn actually finishes clean.
    // Genuine recovery also clears it via onAgentRecovered (injury-recovery.ts).
    if (status === 'idle') {
      db.prepare(`
        UPDATE agents SET status = ?, last_error = NULL, last_error_at = NULL, updated_at = datetime('now') WHERE id = ?
      `).run(status, agentId);
    } else {
      db.prepare(`
        UPDATE agents SET status = ?, updated_at = datetime('now') WHERE id = ?
      `).run(status, agentId);
    }
    if (status === 'idle') { currentTurnKind.delete(agentId); currentTurnConvKey.delete(agentId); currentTurnImRecipient.delete(agentId); currentModelRequestId.delete(agentId); currentTurnNumber.delete(agentId); currentTurnRoot.delete(agentId); currentTurnServedWork.delete(agentId); currentToolCallId.delete(agentId); clearTurnReceipts(agentId); clearRecallBudget(agentId); }
    // On 'working', carry the turn kind so the composer can stay quiet on pure
    // A2A turns (unless wordy mode). Defaults to 'user' until the counterparty
    // is resolved early in the turn.
    const turnKind = status === 'working' ? (currentTurnKind.get(agentId) ?? 'user') : undefined;
    // userFacing rides on EVERY status this seam emits (working AND idle/terminal),
    // captured above before the idle delete. `undefined` (no turn resolved yet, e.g.
    // the pre-classification 'working' at turn start) is omitted so the client keeps
    // its safe default there; the authoritative value lands on the post-resolution
    // working re-broadcast and on the terminal broadcast.
    broadcast({
      type: 'agent:status',
      agentId,
      status,
      ...(turnKind ? { turnKind } : {}),
      ...(turnConvKeyAtStatus !== undefined ? { userFacing: userFacingTurn } : {}),
    });
  } catch (err) {
    logger.warn('Failed to update agent status', {
      agentId,
      status,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

// Orb mood marker (`((mood: NAME))`) is an orb-only signal: the dashboard and
// TTS already strip it before display, but away text channels (iMessage / SMS /
// Teams / email) were sending it raw, breaking the prompt's promise that it's
// invisible to the user. Strip it from the channel-routed copy
// (lastAssistantTextForIM) at set-time; the persisted assistant message keeps
// the marker so the dashboard can still animate the orb.
const ORB_MOOD_MARKER_RE = /\(\(\s*mood\s*:\s*[a-z]+\s*\)\)/gi;
function stripOrbMood(text: string): string {
  return text.replace(ORB_MOOD_MARKER_RE, '').trim();
}

// ── Main entry ──

/**
 * Run a single user-message → agent-response cycle on the v2 runtime.
 * Mirrors v1's runAgentLoop semantics with the Control Shell pattern.
 */
export async function runV2Turn(agentId: string): Promise<void> {
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
  // F9: timestamp of the turn's most recent context assembly; sibling user rows
  // of the same conversation created before this instant were IN the assembled
  // context and are claimed at teardown (see claimAssembledSiblings).
  let lastAssembledAtIso: string | null = null;
  // FA-M1: the non-compressible overhead (assembled system prompt + tool-schema/
  // output reserve) the pre-call compaction gate subtracts from the window to get
  // the compressible budget. Refreshed from each assembly below; the pre-call gate
  // sits at the top of the iteration (before assembly), so it uses the prior
  // iteration's value (0 on the very first gate, i.e. old full-window behavior).
  // The stronger, exact anti-silent-loss signal is the eviction broadcast, which
  // fires whenever the assembler actually drops fresh-tail rows.
  let assemblerOverheadTokens = 0;
  let freshTailDropWarned = false;
  // E-C1: publish the conversation this turn serves so recall_recent_thread scopes
  // to it. null on engine/A2A turns (no waiting human) so recall doesn't latch the
  // last human conversation. Cleared when the agent goes idle.
  currentTurnConvKey.set(agentId, chosenConvKey);
  // OPEN-12: trigger on the OLDEST unanswered message in the chosen conversation,
  // so a conversation's pending messages are answered oldest-first, a later ping
  // ("are you there?") can never be answered before the request that came before it.
  const triggerRow = waitingConvs[0]?.oldest;
  const lastUserMessageContent = triggerRow?.content ?? null;
  // P1 lineage spine: the inbound ask's ROW ID, the origin key work records
  // born this turn will carry (the prose copy in lastUserMessageContent stays
  // for display; identity travels as this id).
  const lastUserMessageId: string | null = triggerRow?.id != null ? String(triggerRow.id) : null;
  currentTurnRoot.set(agentId, lastUserMessageId ? { kind: 'ask', id: lastUserMessageId, sourceMessageId: lastUserMessageId, conversationId: (triggerRow as unknown as { conversation_id?: string | null })?.conversation_id ?? null } : null);
  // CLAIM this conversation the moment the turn picks it up: stamp the trigger
  // inbound's conv_key so it reads as SERVED regardless of how this turn ends.
  // The old design only marked a conversation served when the turn delivered a
  // terminal reply (or [no-reply]), so a turn that did real, NON-IDEMPOTENT
  // work (created a project, wrote files, messaged the PM) but then ended via a
  // suppressed reply, a gate/limit, or an A2A hand-off tagged nothing, left the
  // conversation "waiting", and the runtime drain re-triggered the SAME message
  // → the agent redid the work → duplicate projects (the thrash spiral). Marking
  // the inbound at pickup is restart-durable (DB), idempotent (conv_key IS NULL
  // guard), and invisible to content-scoping (user rows scope by origin, not by
  // conv_key, see scopeToHumanConversation). A genuinely newer message in the
  // same conversation has a higher rowid, so it still reads as waiting and is
  // served on the next turn; only the self-re-trigger of the message we are
  // handling right now is killed. Continuing a long task is the tracker/PM's job,
  // never re-running the user's message.
  if (chosenConvKey && triggerRow) {
    let claimed = true;
    try {
      const res = db.prepare(
        `UPDATE messages SET conv_key = ? WHERE agent_id = ? AND rowid = ? AND conv_key IS NULL`,
      ).run(chosenConvKey, agentId, triggerRow.rowid);
      claimed = res.changes > 0;
    } catch { /* best effort, served-tagging also happens at turn end */ }
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
      // idle status clears the turn-state maps; the other process serves the message.
      logger.warn('v2: pickup claim lost, another process already claimed this trigger; skipping to avoid a duplicate turn', { agentId, rowid: triggerRow.rowid }, agentId);
      setAgentStatus(agentId, 'idle');
      return;
    }
  }

  // N-1 (comms-audit): re-arm a stranded human ask. The pickup stamp above marks the
  // trigger served so a concurrent turn can't double-serve it. If THIS turn then aborts
  // BEFORE producing any answer (model-call exhausted all retries, or no model available
  // at all, a transient rate-limit / provider outage), leaving the stamp in place would
  // drop the ask from the waiting set FOREVER and the user would get permanent silence on
  // a purely transient infra failure, while the recovery toast promises "retrying
  // automatically". Reverting the stamp to NULL returns the ask to the waiting set so the
  // runtime finally-drain (runtime.ts) re-serves it once the provider recovers (bounded by
  // MAX_DRAIN_STUCK, so a persistent failure can't tight-loop). `AND conv_key = ?` reverts
  // only our OWN stamp (idempotent, safe against a concurrent re-stamp). Call ONLY on
  // no-answer abort paths, never after any reply text has been produced, or it would
  // resurrect an answered ask and double-reply.
  // D8: set at the engine-event pickup below when THIS turn claims a pending engine
  // event (conv_key stamped 'engine'). Declared here, before the abort revert that
  // reads it, so the closure never touches a TDZ variable.
  // D-A step 4: also carry the source table (`src`) the event was found in, so the
  // revert reverts + records the failure against the row's ACTUAL home table
  // (per-table rowid, a wrong-table revert would re-deliver the event forever).
  let claimedEngineEvent: { rowid: number; src: EngineEventSrc } | null = null;
  const revertTriggerStampOnAbort = () => {
    if (chosenConvKey && triggerRow) {
      try {
        db.prepare(`UPDATE messages SET conv_key = NULL WHERE rowid = ? AND conv_key = ?`)
          .run(triggerRow.rowid, chosenConvKey);
      } catch { /* best effort, recovery, never block the abort */ }
    }
    // D8: symmetric revert for an ENGINE trigger claim. The engine pickup stamps
    // conv_key='engine' the moment the event is picked up, so a model/provider abort
    // on the engine turn used to leave the event permanently "processed": the
    // reminder was never spoken and nothing ever retried it. Revert our own claim
    // (AND conv_key = 'engine' keeps it idempotent against a concurrent re-stamp)
    // and record the failed delivery (attempt counter + backoff, migration 084) so
    // the retry timer / boot re-drain re-serves it, bounded by the 5-attempt /
    // 6-hour lifecycle. Guarded by the SAME no-non-idempotent-execution rule as
    // the C4 human re-arm below (P6b): a turn that performed a side effect
    // (sent the reminder via imessage_send, created a task) must not re-fire
    // the event, that would duplicate it; a read-only turn re-arms safely.
    if (claimedEngineEvent != null) {
      try {
        if (state.nonIdempotentCallsThisTurn === 0) {
          // D-A step 4: revert + record against the event's ACTUAL home table.
          const table = claimedEngineEvent.src === 'ia' ? 'inter_agent_messages' : 'messages';
          const res = db.prepare(`UPDATE ${table} SET conv_key = NULL WHERE agent_id = ? AND rowid = ? AND conv_key = 'engine'`)
            .run(agentId, claimedEngineEvent.rowid);
          if (res.changes > 0) recordEngineEventDeliveryFailure(agentId, claimedEngineEvent.rowid, claimedEngineEvent.src);
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
  const latestUserSource: 'voice' | 'text' | null =
    triggerRow?.source === 'voice' ? 'voice' : triggerRow ? 'text' : null;
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
  let voiceFillerFired = false;

  // v2.9.23, phone-call streaming TTS state. When this turn is
  // triggered by a live phone call, we keep a sentence-splitting
  // buffer attached to the model's onChunk callback. Each completed
  // sentence (or comma-separated clause for short replies) goes to
  // `CallSession.queueAgentSay` ASAP so audio starts playing on the
  // first sentence instead of waiting for the whole model output.
  // Cuts perceived latency by ~70 % on multi-sentence replies.
  let phoneStreamCallSid: string | null = null;
  let phoneStreamBuffer = '';
  let phoneStreamFlushedAny = false;

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
    source: triggerRow?.source ?? null,
    inboundMeta: triggerRow?.inbound_meta ?? null,
  });
  const inboundChannel = resolvedInbound.inboundChannel;
  const inboundContext = resolvedInbound.inboundContext;
  // v2.9.23, bind the streaming TTS sink for a live phone call so audio
  // starts playing while the model is still generating (the onChunk callback
  // on the model call flushes sentence-complete chunks to queueAgentSay).
  if (inboundChannel === 'phone' && inboundContext?.phoneCallSid) {
    phoneStreamCallSid = inboundContext.phoneCallSid;
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
  // D-A: read the MERGED most-recent inbound. Human/engine rows still live in
  // `messages`; peer A2A inbound now lives in inter_agent_messages. Merging both is
  // what lets a NEW store ASSIGN be seen as the most-recent trigger, so mostRecentIsA2A
  // is true → isA2ATurn → counterparty.kind='agent' → the assembler scopes (not strips)
  // the merged tail to that thread and the model actually sees the ASSIGN. `_src` tags
  // the source table so the terminal-wake claim UPDATE below hits the right one; the
  // messages arm dedups against store ids so a backfilled row is not seen twice.
  const mostRecentInbound = db.prepare(`
    SELECT rowid, content, origin_kind, origin_intent, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, inbound_meta, conv_key, created_at, 0 AS _tag, 'm' AS _src
      FROM messages
     WHERE agent_id = @agentId AND role = 'user'
       AND id NOT IN (SELECT id FROM inter_agent_messages WHERE agent_id = @agentId)
    UNION ALL
    SELECT rowid, content, origin_kind, origin_intent, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, NULL AS inbound_meta, conv_key, created_at, 1 AS _tag, 'ia' AS _src
      FROM inter_agent_messages
     WHERE agent_id = @agentId AND role = 'user'
    ORDER BY created_at DESC, _tag DESC, rowid DESC
    LIMIT 1
  `).get({ agentId }) as {
    rowid: number; content: string; origin_kind: string | null; origin_intent: string | null;
    source_agent_id: string | null; a2a_thread_id: string | null; a2a_intent: string | null;
    a2a_requires_response: number | null; inbound_meta: string | null; conv_key: string | null; _src: 'm' | 'ia';
  } | undefined;
  // A reply-needed peer A2A (QUESTION/ASSIGN/BLOCK) is most-recent. Engine-origin
  // rows (fromAgent='system') are NOT peer A2A, they drive an engine turn instead,
  // so they never count here (else they'd mis-frame the receiver toward send_to_agent).
  const mostRecentIsA2A =
    mostRecentInbound?.origin_kind !== 'engine' &&
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
  // (a2a_requires_response=1) and has not yet been claimed by a turn (conv_key NULL).
  // Gated with !hasUnansweredUser below so a waiting human always wins (no hijack).
  const TERMINAL_WAKE_INTENTS = new Set(['DELIVERABLE', 'ANSWER', 'COMPLETE', 'FAIL']);
  let terminalWakeA2A: { intent: string; threadShort: string; fromName: string; rowid: number; src: 'm' | 'ia' } | null = null;
  if (
    mostRecentInbound &&
    mostRecentInbound.origin_kind !== 'engine' &&
    mostRecentInbound.a2a_thread_id &&
    mostRecentInbound.a2a_intent &&
    TERMINAL_WAKE_INTENTS.has(mostRecentInbound.a2a_intent) &&
    mostRecentInbound.a2a_requires_response === 1 &&
    mostRecentInbound.conv_key === null
  ) {
    const senderRow = mostRecentInbound.source_agent_id
      ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(mostRecentInbound.source_agent_id) as { name?: string } | undefined)
      : undefined;
    terminalWakeA2A = {
      intent: mostRecentInbound.a2a_intent,
      threadShort: mostRecentInbound.a2a_thread_id.slice(0, 8),
      fromName: senderRow?.name ?? mostRecentInbound.source_agent_id ?? 'another agent',
      rowid: mostRecentInbound.rowid,
      src: mostRecentInbound._src,
    };
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
  // Claim the driving terminal-wake message so it drives exactly ONE turn: without a
  // stamp it stays most-recent + conv_key NULL and any later spurious wake would
  // re-detect it and (worst case) re-relay the deliverable to the owner. conv_key='a2a'
  // is a non-human sentinel; scopeToA2AThread keys agent rows on origin.kind+thread
  // (not conv_key), and the human waiting-set already ignores A2A rows, so the stamp is
  // inert to every other consumer. Mirrors the human/engine pickup-claim above.
  if (terminalWakeDrivesTurn && terminalWakeA2A) {
    try {
      // D-A: claim in whichever table the row lives in. A peer terminal-wake now
      // lives in inter_agent_messages; an engine one still in `messages`. rowid is
      // per-table, so the table MUST match the source or the claim silently misses.
      const claimTable = terminalWakeA2A.src === 'ia' ? 'inter_agent_messages' : 'messages';
      db.prepare(`UPDATE ${claimTable} SET conv_key = 'a2a' WHERE agent_id = ? AND rowid = ? AND conv_key IS NULL`)
        .run(agentId, terminalWakeA2A.rowid);
    } catch { /* best effort, exactly-once is a safety net, not a correctness gate */ }
    // P1 lineage spine: an A2A wake turn's root is its thread.
    const twThread = (terminalWakeA2A as unknown as { a2a_thread_id?: string | null }).a2a_thread_id;
    if (twThread) currentTurnRoot.set(agentId, { kind: 'a2a', id: String(twThread), sourceMessageId: null });
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
  const settledContextWakeTurn = !hasUnansweredUser;
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
    mostRecentInbound.origin_kind !== 'engine' &&
    !mostRecentInbound.a2a_thread_id &&
    deriveOrigin({
      role: 'user',
      content: mostRecentInbound.content,
      sourceAgentId: mostRecentInbound.source_agent_id,
      a2aThreadId: mostRecentInbound.a2a_thread_id,
      a2aIntent: mostRecentInbound.a2a_intent,
      a2aRequiresResponse: mostRecentInbound.a2a_requires_response,
      inboundMeta: mostRecentInbound.inbound_meta,
      originKind: mostRecentInbound.origin_kind,
      originIntent: mostRecentInbound.origin_intent,
    }).authorized === false;
  // Mark the engine event PROCESSED at pickup (mirrors the human pickup-stamp) so it
  // can't re-fire and so getPendingEngineEvent stops returning it. conv_key='engine'
  // is a non-human sentinel (the human waiting-set ignores engine rows by origin).
  if (isEngineTurn && pendingEngineEvent) {
    let engineClaimed = true;
    try {
      // D-A step 4: claim in whichever table the pending event lives in (tagged by
      // the merged getPendingEngineEvent read). rowid is per-table, so a claim against
      // the wrong table stamps nothing, leaves the event conv_key NULL, and it
      // re-delivers on every subsequent drain, forever, the worst regression here.
      const engineTable = pendingEngineEvent.src === 'ia' ? 'inter_agent_messages' : 'messages';
      const res = db.prepare(`UPDATE ${engineTable} SET conv_key = 'engine' WHERE agent_id = ? AND rowid = ? AND conv_key IS NULL`)
        .run(agentId, pendingEngineEvent.rowid);
      engineClaimed = res.changes > 0;
    } catch { /* best effort */ }
    // D8: remember OUR claim so a no-answer abort can revert it symmetrically with
    // the human trigger stamp (see revertTriggerStampOnAbort above).
    if (engineClaimed) claimedEngineEvent = { rowid: pendingEngineEvent.rowid, src: pendingEngineEvent.src };
    // P1 lineage spine: this turn serves the engine event; if the row carries a
    // run/task referent (migration 112 columns), the root is that occurrence,
    // and the served task's kind/origin are published to turn-state so lanes
    // (reminder delivery) can read what this turn's output belongs to.
    if (engineClaimed) {
      currentTurnRoot.set(agentId, pendingEngineEvent.runId
        ? { kind: 'occurrence', id: pendingEngineEvent.runId, sourceMessageId: null }
        : { kind: 'engine', id: pendingEngineEvent.id, sourceMessageId: null });
      if (pendingEngineEvent.taskId) {
        try {
          const servedTask = db.prepare('SELECT kind, origin_conv_key FROM tasks WHERE id = ?')
            .get(pendingEngineEvent.taskId) as { kind: string | null; origin_conv_key: string | null } | undefined;
          currentTurnServedWork.set(agentId, {
            taskId: pendingEngineEvent.taskId,
            runId: pendingEngineEvent.runId,
            taskKind: servedTask?.kind ?? null,
            originConvKey: servedTask?.origin_conv_key ?? null,
          });
        } catch { /* best effort; the lane simply stays inactive */ }
      }
    }
    if (!engineClaimed) {
      // C24: symmetry with the human pickup-claim above, the atomic engine-event claim
      // affected 0 rows, so ANOTHER process already picked up this engine event. Bail cleanly
      // instead of running a DUPLICATE engine turn. Single-process production never hits this
      // (changes is always 1); guards stray dev `tsx watch` processes on the one SQLite DB.
      logger.warn('v2: engine-event claim lost, another process already claimed it; skipping to avoid a duplicate engine turn', { agentId, rowid: pendingEngineEvent.rowid }, agentId);
      setAgentStatus(agentId, 'idle');
      return;
    }
  }

  // Now that the turn kind is known, record it and re-broadcast the working
  // status with it so the composer can stay quiet on pure A2A turns (unless
  // wordy mode is on). The DB status was already set to 'working' at turn start;
  // this is a broadcast-only update and the 30s heartbeat reads the same map.
  currentTurnKind.set(agentId, isA2ATurn ? 'a2a' : 'user');
  // C26: start each turn with a clean receipt register so receipts only ever
  // count for the turn that produced them (a later poked turn keeps the
  // prose-evidence path). Cleared again on idle at the boundary above.
  clearTurnReceipts(agentId);
  // RC-3: start each turn with a fresh recall budget (per-turn doom-loop brake).
  clearRecallBudget(agentId);
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

  // ── Turn counterparty (attribution redesign, Phase 3) ──
  // The single entity this turn is addressing, resolved from structured origin.
  // Drives the explicit "who you're talking to" header (Phase 3) and the
  // fresh-tail scoping (Phase 4). Derived from the same signals computed above.
  // C3: on a human-task continuation, restore the ORIGINAL counterparty so the final
  // answer routes to the conversation's real channel/person (the empty-trigger
  // continuation has no inbound to resolve from). Otherwise resolve normally.
  const counterparty: TurnCounterparty = isHumanContinuation
    ? continuation!.counterparty
    : resolveTurnCounterparty({
        isA2ATurn,
        a2aFromName: a2aCounterpartyIdentity?.fromName ?? null,
        a2aThreadShort: a2aCounterpartyIdentity?.threadShort ?? null,
        triggerContent: lastUserMessageContent,
        triggerSource: triggerRow?.source ?? null,
        triggerInboundMeta: triggerRow?.inbound_meta ?? null,
        inboundChannel,
      });

  // T-4: publish this turn's iMessage recipient (the human counterparty) so an
  // explicit no-recipient imessage_send / image_create reply goes to THIS person.
  if (counterparty.kind === 'user' && counterparty.channel === 'imessage' && counterparty.senderId) {
    currentTurnImRecipient.set(agentId, counterparty.senderId);
  } else {
    currentTurnImRecipient.delete(agentId);
  }

  // RC-10: owner-channel affinity, resolved ONCE here so the SAME value drives both the
  // counterparty header (so the model is never told "dashboard" on a turn the engine
  // will text) and the end-of-turn reply routing. Applies only when: the counterparty
  // is the owner (never a contact), the natural destination would be the dashboard (not
  // a bound routed channel, and never voice/phone), the owner's most recent contact was
  // iMessage within 48h, the bridge is configured, and the per-conversation rate limit
  // allows a promotion. The presence-away override at end-of-turn remains stronger.
  // RC-5.3: an authorized owner inbound (the owner is present and engaging) resets the
  // proactive-send backoff. A settled-context wake has no trigger row, so only a genuine
  // owner message clears the streak; every unanswered proactive ping keeps it climbing.
  if (triggerRow && counterparty.kind === 'user' && counterparty.relation === 'owner') {
    resetProactiveSendStreak(agentId);
  }

  // P5c: the affinity cooldown is keyed by the CONVERSATION ROW. Owner-addressed
  // dashboard-default turns (the only promotion case) all belong to the owner's
  // one dashboard conversation per agent, the same identity the chat route
  // stamps, so resolve that row lazily inside the promotion guard.
  let ownerAffinityConversationId: string | null = null;
  let ownerAffinityDestination: 'imessage' | null = null;
  {
    const destinationWouldBeDashboard =
      counterparty.channel !== 'imessage' && counterparty.channel !== 'teams' &&
      counterparty.channel !== 'email' && counterparty.channel !== 'sms' &&
      counterparty.channel !== 'phone' && counterparty.channel !== 'voice';
    if (counterparty.kind === 'user' && counterparty.relation === 'owner' && destinationWouldBeDashboard) {
      try {
        const { isImessageConfigured } = await import('../../services/presence.js');
        const bridgeConfigured = isImessageConfigured();
        const affinity = resolveOwnerAffinityChannel(agentId, { imessageBridgeConfigured: bridgeConfigured });
        if (affinity === 'imessage') {
          const { resolveOrCreateConversation } = await import('../../memory/conversations.js');
          ownerAffinityConversationId = resolveOrCreateConversation(agentId, {
            channel: 'dashboard', provider: null, counterpartyId: 'owner', threadRoot: null,
          });
          if (affinityPromotionAllowed(agentId, ownerAffinityConversationId)) {
            ownerAffinityDestination = 'imessage';
          }
        }
      } catch { /* best effort; a resolution failure just leaves the reply on the dashboard */ }
    }
  }

  // Determine v2 turn_number, read max from messages, increment.
  // Per Part XVIII §E: turn_number is per-agent, monotonically increasing,
  // resets to 0 on session reset (handled elsewhere).
  const lastTurn = db.prepare(
    'SELECT MAX(turn_number) as max_turn FROM messages WHERE agent_id = ?',
  ).get(agentId) as { max_turn: number | null } | undefined;
  const turnNumber = (lastTurn?.max_turn ?? 0) + 1;
  // RC-12: publish the turn number so writeToolReceipt can stamp turn_number on
  // engine receipts without threading it through every send executor. Cleared at
  // the turn boundary (idle), like currentTurnConvKey.
  currentTurnNumber.set(agentId, turnNumber);

  // ── P4 turn record: what this turn SERVES, forward-linked ──
  {
    const root = currentTurnRoot.get(agentId) ?? null;
    const kind: 'user' | 'a2a' | 'engine' | null =
      isEngineTurn ? 'engine' : (isA2ATurn ? 'a2a' : (chosenConvKey ? 'user' : null));
    const subjectKind = isEngineTurn ? 'engine_event' as const
      : isA2ATurn ? 'a2a_thread' as const
      : chosenConvKey ? 'conv' as const
      : isHumanContinuation ? 'continuation' as const
      : 'none' as const;
    const subjectId = isEngineTurn ? (pendingEngineEvent?.id ?? null)
      : isA2ATurn ? ((terminalWakeA2A as unknown as { a2a_thread_id?: string | null } | null)?.a2a_thread_id ?? null)
      : chosenConvKey;
    currentModelRequestId.set(agentId, `req_${uuidv4().replace(/-/g, '').slice(0, 16)}`);
    recordTurnStart({
      agentId, turnNumber, kind, subjectKind, subjectId,
      // P8: typed spoken-stream lane on the record.
      lane: latestUserSource === 'voice' ? 'voice' : inboundChannel === 'phone' ? 'phone' : null,
      rootKind: root?.kind ?? null, rootId: root?.id ?? null,
      sourceMessageId: root?.sourceMessageId ?? null, convKey: chosenConvKey,
    });
    // Per-ask forward link: the claimed trigger row records WHICH turn serves
    // it (the claim stamps above only made it invisible to the waiting set).
    try {
      if (triggerRow) {
        db.prepare('UPDATE messages SET served_by_turn = ? WHERE rowid = ?').run(turnNumber, triggerRow.rowid);
      }
      if (claimedEngineEvent) {
        db.prepare(`UPDATE ${claimedEngineEvent.src === 'ia' ? 'inter_agent_messages' : 'messages'} SET served_by_turn = ? WHERE rowid = ?`)
          .run(turnNumber, claimedEngineEvent.rowid);
      }
      if (terminalWakeA2A) {
        const twTable = (terminalWakeA2A as unknown as { src?: string }).src === 'ia' ? 'inter_agent_messages' : 'messages';
        db.prepare(`UPDATE ${twTable} SET served_by_turn = ? WHERE rowid = ?`).run(turnNumber, terminalWakeA2A.rowid);
      }
    } catch { /* best effort */ }
  }

  // Snapshot turn boundary so context assembly excludes mid-run user messages
  const turnStartedAt = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  turnBoundary.set(agentId, turnStartedAt);

  // Remediation Phase 5 (5a): if a technique gets injected this turn, the
  // turn's outcome (completed vs errored) is written back to its usage row.
  let turnInjectedTechniqueId: string | null = null;

  // D6: the technique-acknowledgement gate no longer blocks (the hard gate was
  // removed, see the tool loop) and is per-turn only. Do NOT hydrate it from
  // agents.config across turns: a pending ack left over from a prior turn used
  // to resurrect a global tool lock on an unrelated later turn with no expiry.
  const initialPendingTechniqueAck: import('./state.js').AgentTurnState['pendingTechniqueAck'] = null;

  // Initial state
  let state = initState({
    agentId,
    contextWindow,
    isAutoRouted,
    configuredModelId,
    turnNumber,
    triggeredByIMessage,
    triggeredByA2AReplyIntent: a2aReplyContext,
    lastUserMessageContent,
    lastUserMessageId,
    inboundChannel,
    inboundContext,
    pendingTechniqueAck: initialPendingTechniqueAck,
  });

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
      !state.lastAssistantTextForIM &&
      !state.surfacedReplyThisTurn &&
      !Object.values(state.explicitSendThisTurn).some(Boolean) &&
      state.nonIdempotentCallsThisTurn === 0
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
    if (chosenConvKey) continuationContext.set(agentId, { convKey: chosenConvKey, counterparty });
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
  // P6b-2: the marker is the user-visible VIEW; the deliveries ROW (written
  // first, when the caller passes structured facts) is the RECORD everything
  // load-bearing reads. A call without facts writes marker-only, no row.
  const persistRoutingMarker = (label: string, delivery?: Omit<DeliveryInput, 'agentId'>): void => {
    if (delivery) recordDelivery({ agentId, ...delivery });
    const tagId = uuidv4();
    const tagContent = `[Reply routed via ${label}]`;
    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
      VALUES (?, ?, 'system', ?, ?, datetime('now'))
    `).run(tagId, agentId, tagContent, turnNumber);
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

  // RC-1: dual-home a cross-recipient send. When the agent sends to someone who is
  // NOT this turn's counterparty (asking the owner for a datum while replying to a
  // contact), the send's text lives only in the current conversation's tool rows and
  // is filtered out of the RECIPIENT's next turn by scopeToHumanConversation. So the
  // recipient answers a question with no visible trace of it ever being asked (the
  // "easily confused" bug, F-1/F-3/K-1). This persists ONE additive assistant echo
  // row INTO the recipient's conversation (conv_key = recipient's key) carrying the
  // verbatim sent text, so on the recipient's next turn the model sees its own
  // question and can bind the bare answer. Additive and side-effect-free: it does NOT
  // retro-stamp the tool rows (that would destabilise the SENDING turn's own
  // assembly). origin_intent='cross_conv_send_echo' keeps it OUT of the start-ack
  // "did I reply" check (which requires origin_intent IS NULL) and lets the dashboard
  // render it as a routing chip. NOT broadcast live (it belongs to a different
  // conversation than the one on screen); it surfaces on the recipient's turn + on
  // reload. Skipped when the echo would land in this turn's own conversation.
  const persistCrossConvSendEcho = (
    channel: Channel,
    recipientId: string | null,
    recipientName: string,
    channelWord: string,
    sentText: string,
  ): void => {
    try {
      const text = (sentText ?? '').trim();
      if (!text) return;
      const echoKey = conversationKey(channel, recipientId, recipientName, null);
      // Defensive: never echo into the conversation this turn is already serving
      // (the toCp guard at the call site already excludes recipient==counterparty).
      if (!echoKey || echoKey === chosenConvKey) return;
      const echoId = uuidv4();
      const content = `[Sent via ${channelWord} to ${recipientName}]: ${text}`;
      db.prepare(`
        INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, conv_key, origin_intent, created_at)
        VALUES (?, ?, 'assistant', ?, ?, ?, 'cross_conv_send_echo', datetime('now'))
      `).run(echoId, agentId, content, turnNumber, echoKey);
      logger.info('RC-1: dual-homed cross-recipient send echo into recipient conversation', {
        agentId, turnNumber, echoKey, channel: channelWord,
      }, agentId);
    } catch (err) {
      logger.debug('RC-1 cross-conv echo failed (non-fatal, additive)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  };

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
  let engineStartAckDeliveredThisTurn = false;
  // originIntent stamps a machine-readable marker on the ack row so consumers
  // (the completion-ack cross-turn dedup, the PM poke chain, the F10 replied-
  // check) recognize an engine ack STRUCTURALLY instead of by copy prefix,
  // which is what lets the wording vary freely. origin_kind is deliberately
  // left NULL: an assistant row with only origin_intent still classifies as
  // normal user-visible agent speech (deriveOrigin keys engine-origin off
  // origin_kind, and the display classifier ignores origin_intent on assistant
  // rows), so the ack still shows in chat exactly as before.
  // originIntent defaults to null so a non-ack caller (e.g. the thrash-block
  // user notice) keeps origin_intent NULL and stays a substantive reply. The
  // start-ack sites pass 'engine_start_ack' explicitly.
  // Captured text-with-tools that MIGHT be the user's genuine answer (set by the
  // demotion block, consumed by G-SUP-2 / the start-ack / the [no-reply]
  // promotion). Declared HERE, above the ack closures, so the start-ack timer
  // can capture it (2026-07-16, the trivial-save sequence).
  let deferredUserReplyWithTools: string | null = null;
  // True when the start-ack already delivered the deferred text as the turn's
  // user-visible answer; gates the terminal promotion and the redundant-closeout
  // floor so the answer can never double-send.
  let deferredDeliveredByAck = false;
  // Identical-call brake state (2026-07-17): consecutive identical failing
  // tool calls this turn, keyed by exact call signature. See identical-call-brake.ts.
  const identicalCallState: RepeatCallState = new Map();
  // Terminal spin-brake state (owner ruling 2026-07-19): once ANY signature
  // goes terminal, the whole tool phase is over for this turn; every further
  // tool call returns a short note without executing, and after a small grace
  // of model iterations the loop concludes. The model's TEXT is never touched.
  let toolPhaseEndedBySpinBrake = false;
  let spinBrakeGraceCalls = 2;
  // Set when the loop detector hard-blocks a call this turn (set-only-true, so
  // concurrent runOne callbacks cannot clobber it). Consumed by the going-idle
  // reconciliation: a reply the engine itself forced with a STOP order is a
  // status update, not a delivery, and must never stamp deliverable_shown.
  // Interim guard until the P2 status-truth invariant removes the stamp
  // mechanism entirely (owner ruling 2026-07-21).
  let loopBlockFiredThisTurn = false;
  // Reminder-delivery lane refuse-once memory (turn-local): first non-owner
  // send on a reminder turn is refused with guidance; an identical repeat is
  // a deliberate confirmation and proceeds.
  const reminderLaneRefusedSigs = new Set<string>();

  const deliverEngineUserAck = async (text: string, originIntent: string | null = null): Promise<void> => {
    const ackId = uuidv4();
    try {
      db.prepare(
        `INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, origin_intent, created_at) VALUES (?, ?, 'assistant', ?, ?, ?, datetime('now'))`,
      ).run(ackId, agentId, text, turnNumber, originIntent);
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
      if (counterparty.kind === 'user' && counterparty.channel === 'imessage' && counterparty.senderId) {
        const { sendResponseViaIMessage } = await import('../../services/imessage-bridge.js');
        const delivered = sendResponseViaIMessage(text, agentId, counterparty.senderId, false);
        if (delivered) persistRoutingMarker(`iMessage to ${delivered.name}`, {
          tool: 'engine-ack', channel: 'imessage', outcome: 'delivered',
          recipientId: delivered.address, recipientDisplay: delivered.name,
          conversationId: currentTurnRoot.get(agentId)?.conversationId ?? null,
        });
      } else if (counterparty.kind === 'user' && counterparty.channel === 'phone' && state.inboundContext?.phoneCallSid) {
        const { getCallSession } = await import('../../twilio/call-session.js');
        const session = getCallSession(state.inboundContext.phoneCallSid);
        if (session && !session.isEnded()) {
          await session.queueAgentSay(text);
          persistRoutingMarker(`phone call to ${resolveRecipientDisplay('phone', state.inboundContext.phoneFromNumber ?? counterparty.senderId ?? '(unknown)')}`, {
            tool: 'engine-ack', channel: 'phone', outcome: 'delivered',
            recipientId: state.inboundContext.phoneFromNumber ?? counterparty.senderId ?? null,
            conversationId: currentTurnRoot.get(agentId)?.conversationId ?? null,
          });
        }
      } else if (counterparty.kind === 'user' && counterparty.channel === 'sms' && state.inboundContext?.smsFromNumber) {
        const { sendSms } = await import('../../twilio/client.js');
        const { getDefaultFromNumber } = await import('../../twilio/auth.js');
        const fromNumber = state.inboundContext?.smsToNumber ?? getDefaultFromNumber();
        if (fromNumber) {
          await sendSms(state.inboundContext.smsFromNumber, text, fromNumber);
          persistRoutingMarker(`SMS to ${resolveRecipientDisplay('sms', state.inboundContext.smsFromNumber)}`, {
            tool: 'engine-ack', channel: 'sms', outcome: 'delivered',
            recipientId: state.inboundContext.smsFromNumber,
            conversationId: currentTurnRoot.get(agentId)?.conversationId ?? null,
          });
        }
      }
    } catch (err) {
      logger.warn('v2: engine user-ack channel delivery failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  };

  // ── F10: wall-clock start-ack timer ──
  // The person who sent a fresh ask hears "on it" at ENGINE_START_ACK_AFTER_MS
  // if no user-visible reply has landed by then. A TIMER, not a loop-boundary
  // check: the first model round can alone take 25s+, so a boundary check
  // cannot fire until moments before the reply (observed: ack 3s before
  // completion, exactly the noise pattern this exists to kill). Armed ONLY
  // when this turn serves a waiting human NOW (triggerRow set, the same
  // "human is waiting" signal the close-out gate trusts): a queued-wakeup /
  // drain / continuation turn has a user counterparty too, and an ack fired
  // there reads as a stray "On it." attached to nothing (observed live).
  // Cancelled in the teardown finally; a fire after the reply is prevented by
  // the DB check (any user-visible assistant text already stamped with this
  // turn_number) plus the shared once-per-turn flag.
  // WORK-GATED (owner report 2026-07-10, slow-local-model screenshot): the ack
  // exists for WORK, not conversation. On a slow model every reply crosses the
  // wall-clock, so a purely time-based ack answered "Hey dude!" with "Starting
  // on this, back with you soon." The gate: the timer only speaks when the turn
  // has STARTED USING TOOLS by the time it fires; a slow chat reply just
  // streams (the working dots cover the wait). Work that begins later than the
  // threshold is covered by the first-tool-call hook at the execution site,
  // which fires this same routine the moment real work starts.
  let startAckTimer: ReturnType<typeof setTimeout> | null = null;
  let anyToolStartedThisTurn = false;
  // RC-4.4: true while a model call is streaming for this turn. The start-ack timer /
  // first-tool hook consults it to add a bounded streaming-race grace before firing, so
  // an ack does not land 1s before the model's real reply (the F-11 double-ack). Set
  // around the callModel await below.
  let modelCallInFlight = false;
  // RC-4.2: the turn counterparty is another Dojo agent texting over a human channel
  // (an iMessage safe-sender flagged is_agent). Channel-delivered engine acks (start /
  // completion / A2A-handoff) are gated OFF for such a counterparty: another agent does
  // not need "on it" reassurance, and each ack is a fresh inbound that wakes the peer
  // box, the ack ping-pong (H-5) that produced the duplicate texts to the owner. The
  // human owner's OWN engine acks about her agent's work are unaffected, those go to
  // her dashboard/owner conversation, not to an agent-flagged counterparty.
  const counterpartyIsAgentSender = counterparty.kind === 'user' && !!counterparty.senderIsAgent;
  const startAckArmed = counterparty.kind === 'user' && !!triggerRow && !counterpartyIsAgentSender;
  const startAckArmedAtMs = Date.now();
  // The person has heard something the moment EITHER a user-visible
  // assistant text row landed this turn (the DB check) OR the agent
  // delivered through a channel send TOOL (explicitSendThisTurn). The
  // tool-send case leaves NO assistant text row, so the DB check alone
  // was blind to it and fired a duplicate ack seconds after the model's
  // own send (the observed double-ack, and the stray "On it" after a
  // relay was already sent). `state` is read at fire time, so this sees
  // the flag set during the loop. When the agent truly did nothing on
  // any channel, both are false and the engine still speaks.
  const startAckRepliedNow = (): boolean =>
    Object.values(state.explicitSendThisTurn).some(Boolean) ||
    !!db.prepare(`
    SELECT 1 FROM messages
    WHERE agent_id = ? AND role = 'assistant' AND turn_number = ?
      AND content NOT LIKE '[{%'
      AND origin_intent IS NULL
      AND length(trim(content)) > 0
    LIMIT 1
  `).get(agentId, turnNumber);
  const fireStartAckIfOwed = async (via: 'timer' | 'first-tool'): Promise<void> => {
    try {
      if (engineStartAckDeliveredThisTurn || startAckRepliedNow()) return;
      engineStartAckDeliveredThisTurn = true;
      // Trivial-save fix (2026-07-16): if the model already WROTE the user's
      // answer this turn (text riding with its tool calls, captured by the
      // demotion block), the ack the engine owes is THAT text, not a canned
      // start line. Observed live: "Cool, diving into this now." fired three
      // seconds AFTER the save completed, while the real answer ("Saved.") sat
      // demoted as a working note. Deliver the model's own words with no
      // origin stamp (it IS the reply, so startAckRepliedNow and the terminal
      // floors count it) and mark it consumed so nothing double-sends.
      if (deferredUserReplyWithTools && deferredUserReplyWithTools.trim().length > 0) {
        const answer = deferredUserReplyWithTools.trim();
        deferredUserReplyWithTools = null;
        deferredDeliveredByAck = true;
        await deliverEngineUserAck(answer, null);
        logger.info('v2: start-ack delivered the captured text-with-tools answer instead of a canned line', {
          agentId, turnNumber, via, preview: answer.slice(0, 60),
        }, agentId);
        return;
      }
      // RC-4.4 + owner directive 2026-07-17: NEVER fire while a model call is in
      // flight; wait for the call's OUTCOME instead of a fixed grace. If the call
      // ends with the reply, the ack is moot (skip silently). If it ends with more
      // tool work, execution resumes and the ack fires then, while tools are
      // actually grinding, which is the only moment a start ack is honest.
      // Observed pre-fix: "Got it, starting on this now." landed AFTER the work
      // finished, five seconds before the composed answer. Bounded by a hard cap
      // so a hung call (stream-idle watchdog territory) can't defer forever.
      if (modelCallInFlight) {
        const capDeadline = Date.now() + ENGINE_START_ACK_STREAM_GRACE_MS;
        while (modelCallInFlight && Date.now() < capDeadline) {
          await new Promise((r) => setTimeout(r, 250));
          if (startAckRepliedNow()) {
            logger.info('v2 F10 / RC-4.4: start ack skipped, the in-flight reply landed while waiting for the call outcome', {
              agentId, turnNumber, via,
            }, agentId);
            return;
          }
        }
        // Call completed without a reply (more tool work queued), or the hard
        // cap elapsed on a genuinely wedged call: fall through and speak.
        if (startAckRepliedNow()) return;
      }
      // Seconds of slack here (the threshold already passed), so the wording
      // call is awaited inline; the pool fallback guarantees a line.
      const ackText = await composeStartAck({ userMessage: lastUserMessageContent ?? '', agentId });
      // Re-check AFTER composing: the wording call can take up to ~2s on a
      // box with a system model, and the real reply can land inside that
      // gap (observed live: reply at :16, stray ack at :17). An ack that
      // arrives after the answer is pure noise, so the moment of truth is
      // immediately before delivery, not before composition.
      if (startAckRepliedNow()) {
        logger.info('v2 F10: start ack skipped, the reply landed while the wording was being composed', {
          agentId, turnNumber,
        }, agentId);
        return;
      }
      await deliverEngineUserAck(ackText, 'engine_start_ack');
      logger.info('v2 F10: work-gated start ack delivered (no reply yet, work underway)', {
        agentId, turnNumber, via, thresholdMs: ENGINE_START_ACK_AFTER_MS,
      }, agentId);
    } catch (err) {
      logger.warn('v2 F10: start-ack fire failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  };
  if (startAckArmed) {
    startAckTimer = setTimeout(() => {
      if (!anyToolStartedThisTurn) {
        // Chat-shaped so far: the model is composing a reply with no tools.
        // Stay silent (dots cover the wait); if tools DO start later, the
        // first-tool-call hook delivers the ack then. Delivered-flag stays
        // unset on purpose so that hook can still speak.
        logger.info('v2 F10: start-ack threshold passed with no tool activity; staying quiet (chat-shaped turn)', {
          agentId, turnNumber,
        }, agentId);
        return;
      }
      void fireStartAckIfOwed('timer');
    }, ENGINE_START_ACK_AFTER_MS);
  }

  // ── v2.5.46: pre-turn close-out gate detection ──
  // Look up in_progress tasks the agent appears to have abandoned. Pre-
  // v2.7.17 this used `updated_at < turnStartedAt` (any task not touched
  // THIS turn), which made the gate fire every time the user interrupted
  // mid-conversation - even though the agent was actively working the task
  // a minute ago. Now uses a wall-clock threshold so genuinely abandoned
  // tasks are still caught but active mid-conversation work isn't.
  //
  // Per user spec ("if we default to agents creating tasks, they MUST
  // also close them out"): tracker hygiene is still a hard precondition,
  // just with a sane idle window before it kicks in.
  try {
    // (1) Tasks the agent is in_progress on but hasn't touched in the
    // last CLOSE_OUT_IDLE_MINUTES. Any tracker tool call (status update,
    // notes add/edit, complete_step) bumps updated_at, so an actively-
    // worked task naturally stays inside the window.
    const CLOSE_OUT_IDLE_MINUTES = 10;
    const inProgressDanglers = db.prepare(`
      SELECT id, title, 'in_progress' AS kind FROM tasks
      WHERE assigned_to = ?
        AND status = 'in_progress'
        AND is_paused = 0
        AND datetime(updated_at) < datetime('now', ?)
      ORDER BY updated_at ASC
      LIMIT 10
    `).all(agentId, `-${CLOSE_OUT_IDLE_MINUTES} minutes`) as Array<{ id: string; title: string; kind: string }>;

    // (2) Stranded on_deck tasks. Catches the Presenton-shaped failure:
    // agent created a project, did some of it, then abandoned it (often
    // because compaction made them forget the project existed and they
    // spun up a duplicate). The orphans sit in on_deck forever because
    // the existing in_progress-only gate never sees them and the PM's
    // STALE check only chats, doesn't auto-resolve.
    //
    // Criteria: on_deck task assigned to this agent, in a project this
    // agent created, the project has zero in_progress tasks, and the
    // task hasn't been touched in 30+ minutes. The 30-minute floor
    // prevents this from firing inside the same conversation as the
    // creation, only catches genuinely abandoned work between sessions.
    const strandedRows = db.prepare(`
      SELECT t.id, t.title, 'stranded' AS kind FROM tasks t
      INNER JOIN projects p ON p.id = t.project_id
      WHERE t.assigned_to = ?
        AND t.status = 'on_deck'
        AND t.is_paused = 0
        AND (t.scheduled_start IS NULL OR datetime(t.scheduled_start) <= datetime('now'))
        AND t.schedule_status != 'waiting'
        AND p.created_by = ?
        AND p.status = 'active'
        AND datetime(t.updated_at) < datetime('now', '-30 minutes')
        AND NOT EXISTS (
          SELECT 1 FROM tasks sib
          WHERE sib.project_id = p.id AND sib.status = 'in_progress'
        )
      ORDER BY t.updated_at ASC
      LIMIT 10
    `).all(agentId, agentId) as Array<{ id: string; title: string; kind: string }>;

    // BUG-2 (comms-audit convergence pass): NEVER arm the close-out gate on a turn a
    // human is waiting on (`triggerRow` set ⇒ this turn serves a waiting human, by the
    // user-always-wins rule). Task-closeout is Lane 2/3 machinery; per the lane-separation
    // law (see the nudge guard at "counterparty.kind !== 'user'" later in this file) it has
    // no business running in the middle of a Lane-1 conversation about something unrelated, 
    // the danglers are almost always pre-existing background leftovers, not this turn's work.
    // When armed on a conversation turn the gate (a) DELETED the agent's just-streamed reply
    // and (b) REFUSED the tool calls the agent needed to answer, both silent-drop / blocked-
    // turn failures (inv 2, inv 6) on the weak-model floor, where the model routinely answers
    // a fresh ask in plain text without first touching the tracker. Abandoned danglers are
    // still enforced off the conversation path: by this same gate on the next non-conversation
    // turn, and by the PM poke chain (where closeout enforcement belongs).
    const danglingRows = triggerRow ? [] : [...inProgressDanglers, ...strandedRows];
    if (danglingRows.length > 0) {
      state = advance(state, {
        danglingTaskIds: danglingRows.map((r) => r.id),
        nudgedForCloseOutThisTurn: true,
      });
      const inProgressList = inProgressDanglers
        .map((r) => `  - "${r.title}" (${r.id.slice(0, 8)})`)
        .join('\n');
      const strandedList = strandedRows
        .map((r) => `  - "${r.title}" (${r.id.slice(0, 8)})`)
        .join('\n');

      const sections: string[] = [];
      if (inProgressDanglers.length > 0) {
        sections.push(
          `${inProgressDanglers.length} in_progress task${inProgressDanglers.length === 1 ? '' : 's'} from a previous turn you never closed:\n${inProgressList}`
        );
      }
      if (strandedRows.length > 0) {
        sections.push(
          `${strandedRows.length} stranded on_deck task${strandedRows.length === 1 ? '' : 's'} (queued steps on a project you created but stopped working on more than 30 minutes ago, with no in_progress sibling):\n${strandedList}`
        );
      }

      const gateMsg = (
        `[System: REQUIRED close-out, you have abandoned work on the tracker.\n\n` +
        `${sections.join('\n\n')}\n\n` +
        `**This turn must start with a tracker tool call, not a user-facing reply.** ` +
        `Resolve at least one item before doing anything else - call tracker_complete_step (multi-step projects), ` +
        `tracker_update_status (status="complete" | "blocked" | "paused" with resume_at), ` +
        `tracker_add_notes (if you are STILL actively working it - then KEEP GOING on this same turn, do not stop after writing the note), ` +
        `or - if the whole project was abandoned/duplicated/superseded - tracker_close_project(project_id, status="cancelled", reason="..."). ` +
        `The engine will REFUSE every non-tracker tool call until one of those lands; after that the gate releases for the rest of the turn so you can keep resolving the others alongside other work. ` +
        `Do NOT generate a user-facing response on this turn until the gate is satisfied - the user does not expect a reply yet; they expect the tracker to come back in sync. ` +
        `Results already delivered to the user must NOT be repeated; after your tracker call, reply [no-reply] unless the user asked something new.]`
      );
      // F2.4: dedupe the gate message per wakeup batch. Queued wakeups re-arm this
      // gate on every attempt (three duplicate inserts were observed in 20s). The
      // enforcement state is already armed above (danglingTaskIds), so if the
      // dashboard already carries a close-out gate message from the last 5 minutes,
      // skip the redundant INSERT + broadcast while STILL arming enforcement.
      const recentGateMsg = db.prepare(`
        SELECT 1 FROM messages
        WHERE agent_id = ? AND role = 'system'
          AND content LIKE '[System: REQUIRED close-out%'
          AND created_at >= datetime('now', '-5 minutes')
        LIMIT 1
      `).get(agentId);
      const gateMsgId = uuidv4();
      if (!recentGateMsg) {
        try {
          // engine-steer-exempt (RC-19): the pre-turn close-out gate is ENFORCED at
          // the tool-execution layer (the engine REFUSES non-tracker tool calls until
          // a tracker call lands), so its behavior does not depend on the model seeing
          // this row. It also runs in the pre-turn setup, outside the loop's per-turn
          // pendingNudge scope. Guidance-only text; not dashboard-only theater.
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
            VALUES (?, ?, 'system', ?, datetime('now'))
          `).run(gateMsgId, agentId, gateMsg);
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: gateMsgId, agentId, role: 'system' as const,
              content: gateMsg,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
        } catch (msgErr) {
          logger.warn('v2: close-out gate system message insert failed', {
            agentId, error: msgErr instanceof Error ? msgErr.message : String(msgErr),
          }, agentId);
        }
      }
      logger.info('v2: pre-turn close-out gate armed', {
        agentId, danglingCount: danglingRows.length,
        sample: danglingRows.slice(0, 3).map((r) => `${r.id.slice(0, 8)}:${r.title}`),
      }, agentId);
    }
  } catch (err) {
    logger.warn('v2: dangling-task lookup failed; close-out gate disarmed for this turn', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  // ── Post-compaction recall flag (auto-injected via intercept, v2.7.2) ──
  // If compaction fired an unacknowledged recall nudge (no
  // recall_recent_thread call since), arm the one-shot auto-recall that
  // fires on the agent's first significant tool call this turn.
  //
  // v2.7.2, bounded by session_started_at. Previously this query swept
  // ALL of an agent's history for "Memory was just compacted", which
  // meant stale compaction nudges from prior sessions kept arming the
  // flag after a session_reset. Symptom: agent post-reset gets the
  // auto-recall on its very first tool call, recall replays a transcript
  // from before the reset, and the agent gets confused into duplicate
  // calls. The boundary makes the check session-local.
  try {
    const sessionRow = db.prepare(
      'SELECT session_started_at FROM agents WHERE id = ?',
    ).get(agentId) as { session_started_at: string | null } | undefined;
    const sessionBoundary = sessionRow?.session_started_at ?? null;
    const nudgeQuery = sessionBoundary
      ? `SELECT created_at FROM messages
         WHERE agent_id = ? AND role = 'system'
           AND content LIKE '[System: Memory was just compacted%'
           AND created_at >= ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      : `SELECT created_at FROM messages
         WHERE agent_id = ? AND role = 'system'
           AND content LIKE '[System: Memory was just compacted%'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`;
    const nudgeParams = sessionBoundary ? [agentId, sessionBoundary] : [agentId];
    const lastNudge = db.prepare(nudgeQuery).get(...nudgeParams) as { created_at: string } | undefined;
    if (lastNudge) {
      const recallQuery = sessionBoundary
        ? `SELECT created_at FROM messages
           WHERE agent_id = ? AND role = 'assistant'
             AND content LIKE '%"name":"recall_recent_thread"%'
             AND created_at >= ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`
        : `SELECT created_at FROM messages
           WHERE agent_id = ? AND role = 'assistant'
             AND content LIKE '%"name":"recall_recent_thread"%'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`;
      const recallParams = sessionBoundary ? [agentId, sessionBoundary] : [agentId];
      const lastRecall = db.prepare(recallQuery).get(...recallParams) as { created_at: string } | undefined;
      const nudgeTs = new Date((lastNudge.created_at.includes('Z') ? lastNudge.created_at : lastNudge.created_at + 'Z')).getTime();
      const recallTs = lastRecall
        ? new Date((lastRecall.created_at.includes('Z') ? lastRecall.created_at : lastRecall.created_at + 'Z')).getTime()
        : 0;
      if (nudgeTs > recallTs) {
        state = advance(state, { awaitingPostCompactRecall: true });
        logger.info('v2: post-compaction recall flag armed', { agentId }, agentId);
      }
    }
  } catch (err) {
    logger.warn('v2: post-compaction recall check failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  // G-SUP-2 (comms-audit): turn-scoped stash for user-facing text that rode with
  // tool calls and was deferred (suppressed as possible narration). Recovered at
  // turn-end ONLY if the turn delivered no proper tool-less reply, so a genuine
  // answer the weak model paired with a closing tool is never silently lost.

  // P4b: the F3 runway tripwire (a log-only guard on the guard) was DELETED
  // with the near-dup swallow; the turns record now audits the round.

  try {
    // ── Main loop ──
    //
    // v2.7.2, `taskClosedWithTextThisTurn` is checked here at the
    // boundary because internal phase transitions during the body
    // (preCallGates → assemble → callLLM → postCallClassify → execute →
    // postExecution) keep overwriting `phase`, so setting `phase: 'done'`
    // mid-body never survives to the next boundary check. The flag, on
    // the other hand, only gets set (never cleared) once the
    // text-plus-close-out pattern is detected, so the next loop turn
    // sees it and exits, after the current iteration's close-out tool
    // has already run.
    while (
      state.phase !== 'done' &&
      state.loopCount < MAX_TOOL_LOOPS &&
      !state.taskClosedWithTextThisTurn
    ) {
      state = advance(state, { loopCount: state.loopCount + 1, phase: 'preCallGates' });

      // Stop / preempt checks
      if (stoppedAgents.has(agentId)) {
        stoppedAgents.delete(agentId);
        logger.info('v2 agent stopped by user', {}, agentId);
        setAgentStatus(agentId, 'idle');
        break;
      }
      if (preemptedAgents.has(agentId)) {
        preemptedAgents.delete(agentId);
        logger.info('v2 run preempted, queued wakeup will fire', {}, agentId);
        setAgentStatus(agentId, 'idle');
        break;
      }

      // Last-resort auto-block. Two conditions trip it:
      //   (1) Refusal count exceeded, agent kept calling gated sigs and
      //       ignored the refusals.
      //   (2) Drift exceeded, gate has been on for THRASH_GATE_DRIFT_LIMIT
      //       iterations and the agent kept dodging the gate by varying
      //       its calls (different ids, get_current_time, tracker_get_status)
      //       without ever calling tracker_update_status to wrap up. This
      //       is the "look around to avoid finishing" failure mode.
      // We block (not pause) so the task hits a real terminal state.
      const drift =
        state.thrashGateActivatedAtLoopCount !== null
          ? state.loopCount - state.thrashGateActivatedAtLoopCount
          : 0;
      const refusalTrip = state.thrashGateRefusalCount >= THRASH_GATE_BREAKER_LIMIT;
      const driftSoftTrip = drift >= THRASH_GATE_DRIFT_LIMIT;
      const driftHardTrip = drift >= THRASH_GATE_DRIFT_HARD_LIMIT;
      // ── DRIFT-SOFT path (comms-audit G-BLK-1 + REG-1): NUDGE once, never block ──
      // Drift (gate on while the agent varies its call signatures) is a
      // false-positive-prone signal: legitimate progress varies signatures too, so a
      // block at the soft threshold is exactly the "engine stops genuine work" failure
      // the owner forbids. Inject ONE visible nudge (with the escape-hatch) and let the
      // agent continue. CRITICAL: do NOT reset the drift window here, the earlier
      // version did, which let a signature-varying spiral loop forever (it never
      // increments the refusal count, so the refusal-breaker never caught it, and on
      // MAX_TOOL_LOOPS the turn just auto-continued with drift reset to 0). Letting
      // drift keep accumulating means a genuine spiral eventually hits the HARD limit
      // below and terminates deterministically.
      if (!isPMAgent(agentId) && driftSoftTrip && !driftHardTrip && !refusalTrip) {
        if (!state.nudgedForThrashDriftThisTurn) {
          const driftNudge =
            `[Engine hint] The engine thrash gate has been active for ${drift} iterations and you keep ` +
            `varying your tool calls without recording progress. If you ARE making progress, record it with ` +
            `tracker_update_status (or tracker_add_notes), then continue. If you are stuck, wrap up and tell ` +
            `the user where things stand. ${ENGINE_BLOCK_ESCAPE_HATCH}`;
          const driftNudgeId = uuidv4();
          try {
            // Model-visible steer channel. A role='system' row would be stripped
            // by the assembler (dashboard-only theater), so this ladder rung would
            // never reach the model. Persist as an origin_kind='engine' inter-agent
            // row (the EVENTS lane surfaces it next turn) AND set pendingNudge so
            // the model receives it on the very next iteration. conv_key sentinel
            // 'engine-steer' keeps it un-selectable as a pending event (see the
            // thrash-steer C6 note below).
            insertInterAgentEngineRow({
      work: null,
              id: driftNudgeId,
              agentId,
              content: driftNudge,
              sourceAgentId: null,
              originIntent: 'thrash_drift',
              convKey: 'engine-steer',
              turnNumber,
            });
          } catch { /* best effort */ }
          // One-shot nudge only, the drift window is deliberately NOT reset (a
          // signature-varying spiral must keep accruing drift to the hard limit).
          state = advance(state, { nudgedForThrashDriftThisTurn: true, pendingNudge: driftNudge });
          logger.info('v2: thrash drift nudge (one-shot; drift keeps accruing to the hard limit)', {
            agentId, drift, loopCount: state.loopCount,
          }, agentId);
        }
        // fall through, soft drift never blocks; the hard limit below is the stop
      } else if (!isPMAgent(agentId) && (refusalTrip || driftHardTrip)) {
        // ── TERMINAL BLOCK: the agent either IGNORED explicit gate refusals
        // (refusalTrip), OR kept varying call signatures to DODGE the gate past the
        // HARD drift limit despite the nudge (driftHardTrip), a genuine spiral that
        // the refusal counter can't see. The task hits a real terminal state. The
        // AGENT is told on the model-visible steer channel (below), the USER is told
        // in plain language if the work is theirs (F1), and a dashboard toast fires,
        // so the block is VISIBLE and recoverable, not a mute dead-end.
        // Third-person reason for the task-log line and the dashboard toast.
        const breakerReason = refusalTrip
          ? `agent ignored the thrash gate ${state.thrashGateRefusalCount}× without wrapping up`
          : `agent kept varying call signatures for ${drift} iterations to dodge the thrash gate, never wrapping up`;
        // Second-person reason for the agent-facing note. Fixes the old
        // "because you agent ..." double-subject bug: the note prepends "because",
        // and BOTH branches of breakerReason start with "agent ...", so it read
        // "because you agent ...". This string starts with "you ...".
        const breakerReasonSecondPerson = refusalTrip
          ? `you ignored the thrash gate ${state.thrashGateRefusalCount}× without wrapping up`
          : `you kept varying call signatures for ${drift} iterations to dodge the thrash gate, never wrapping up`;
        // F1: does this blocked work trace to a user request? A user ask can be
        // continuing on a background (non-user) turn, so the engine-auto marker on
        // the project also counts as user-origin. If so, the engine tells the person
        // directly (below) rather than leaving the whole escalation ladder mute.
        let blockedWorkIsUserOrigin = counterparty.kind === 'user';
        try {
          const db2 = getDb();
          const { ENGINE_AUTO_MARKER } = await import('./classifiers/multistep.js');
          const task = db2.prepare(`
            SELECT id, title, project_id FROM tasks
            WHERE assigned_to = ? AND status = 'in_progress'
            ORDER BY updated_at DESC LIMIT 1
          `).get(agentId) as { id: string; title: string; project_id: string | null } | undefined;
          if (task) {
            if (!blockedWorkIsUserOrigin && task.project_id) {
              const proj = db2.prepare(`SELECT description FROM projects WHERE id = ?`).get(task.project_id) as { description: string | null } | undefined;
              if (proj?.description && proj.description.startsWith(ENGINE_AUTO_MARKER)) blockedWorkIsUserOrigin = true;
            }
            const noteLine = `Engine auto-blocked: ${breakerReason}. Likely needs human review or a re-stated goal.`;
            db2.prepare(`
              UPDATE tasks
              SET status = 'blocked',
                  blocked_validated = 1,
                  updated_at = datetime('now')
              WHERE id = ?
            `).run(task.id);
            // F1.4: no noteTransitionForReview call here. runPMReview surfaces any
            // blocked task after 30 minutes regardless of blocked_validated (the
            // pm-agent blocked-issue check), so the PM has its backstop. A fresh
            // block (<30 min) would be dropped by that 30-min gate anyway, and
            // re-validating a deterministic engine block would be theater:
            // blocked_validated=1 IS the engine's validation.
            void import('../../tracker/task-log.js').then(({ writeTaskLog }) => {
              writeTaskLog({
                taskId: task.id,
                fromEntity: 'engine',
                entryKind: 'observation',
                fromStatus: 'in_progress',
                toStatus: 'blocked',
                actionTaken: 'engine auto-block (thrash gate ignored)',
                reason: 'thrash:gate-ignored',
                note: noteLine,
              });
            }).catch(() => { /* best effort */ });
            void import('../../tracker/schema.js').then(({ getTask: schemaGetTask }) => {
              const fresh = schemaGetTask(task.id);
              if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
            }).catch(() => { /* best effort */ });
            logger.warn('v2: thrash gate breaker tripped, task auto-blocked', {
              taskId: task.id, refusalCount: state.thrashGateRefusalCount, loopCount: state.loopCount,
            }, agentId);
          }
          // F1.3: agent-facing block note on the model-visible steer channel. A
          // role='system' row is stripped by the assembler (dashboard-only theater),
          // so the block would never reach the model. No pendingNudge: the turn is
          // ending here (break below), so the next turn's EVENTS lane surfaces it.
          // conv_key sentinel keeps it un-selectable as a pending event.
          const agentNoteId = uuidv4();
          insertInterAgentEngineRow({
      work: null,
            id: agentNoteId,
            agentId,
            content:
              `[System] The engine auto-blocked your current task because ${breakerReasonSecondPerson}. Next turn, either ` +
              `re-state the goal and resume (tracker_update_status), or tell the user it is blocked and why. ` +
              `If this block looks wrong and is stopping something the user needs, tell them what you were attempting so they can decide.`,
            sourceAgentId: null,
            originIntent: 'thrash_block',
            convKey: 'engine-steer',
            turnNumber,
          });
        } catch (err) {
          logger.warn('v2: thrash auto-block failed', { error: err instanceof Error ? err.message : String(err) }, agentId);
        }
        // F1.1: user-visible notice. The engine speaks for the blocked agent, in
        // plain layman language, so a person waiting on the ask is not left silent.
        // This is an engine act (a real assistant reply pushed to their channel),
        // not a nudge. Not gated by the start-ack flag: a start-ack is different
        // information; the user needs to hear the work stopped.
        if (blockedWorkIsUserOrigin) {
          try {
            await deliverEngineUserAck(
              `I hit a wall on this: I kept retrying without making progress, so I've stopped rather than keep spinning on it. Tell me to try again, or adjust what you're after, and I'll take another run at it.`,
            );
          } catch { /* best effort, the dashboard/toast still show the block */ }
        }
        try {
          broadcast({
            type: 'chat:error',
            agentId,
            error: `Engine auto-blocked task, ${breakerReason}.`,
            code: 'TASK_THRASH_PAUSED',
            severity: 'warning',
            retryable: true,
          });
        } catch { /* best effort */ }
        setAgentStatus(agentId, 'idle');
        break;
      }

      // Task-thrash detector, steer + per-signature gate (not pause).
      //
      // When the model re-runs the SAME canonical signature 4+ times in 2
      // minutes without calling tracker_update_status, inject a specific
      // steer message that names the exact tool + args + count + window
      // and gate further calls to that one signature. The agent can keep
      // calling the same tool with DIFFERENT args (legitimate iteration
      // over a list of N items stays unblocked). Last resort: if the gate
      // has refused THRASH_GATE_BREAKER_LIMIT+ calls without a
      // tracker_update_status transition, the engine auto-blocks the task
      // so it reaches a clean terminal state instead of looping forever.
      if (!isPMAgent(agentId) && state.loopCount >= 4) {
        const thrash = detectTaskThrashing(agentId);
        if (thrash.thrashing && thrash.signature && !state.thrashGatedSignatures.includes(thrash.signature)) {
          // Pull the recent canonical sig back into a human-readable form
          // for the steer message. The signature itself is `name:{...json}`
          //, we extract the JSON tail to show args verbatim.
          const argsPart = thrash.signature.includes(':')
            ? thrash.signature.slice(thrash.signature.indexOf(':') + 1)
            : '{}';
          // The steer MUST reach the model. assembler.ts strips role='system'
          // messages from history, so writing one as `system` would be
          // invisible to the model (dashboard-only theater). pendingNudge
          // gets injected at the top of the next model call as a synthetic
          // `role: 'user'` message, that's the engine's waking-style
          // delivery channel. We also persist as `role: 'user'` so the
          // dashboard renders it AND any next assemble cycle keeps seeing
          // it (pendingNudge is single-shot).
          const steerMsg =
            `[Engine thrash gate] You've called \`${thrash.toolName}(${argsPart})\` ${thrash.count}× on this turn (and its continuation). ` +
            `You already have the result from the first call; further calls with these exact args are refused.\n\n` +
            `Your next action MUST be one of:\n` +
            `  (a) Call \`${thrash.toolName}\` with DIFFERENT args (e.g., a different id / target) if you genuinely have more to read.\n` +
            `  (b) Reply to the user with the answer you can give using the data you already have.\n` +
            `  (c) Call tracker_update_status(status='complete') with a result + evidence if this is a tracker task.\n` +
            `  (d) Call tracker_update_status(status='blocked') if you genuinely cannot proceed.\n` +
            `  (e) Send the user a specific question if you need clarification.\n\n` +
            `If you keep hitting refused signatures the engine will auto-block this task to stop the loop.`;
          const steerMsgId = uuidv4();
          try {
            // Persist as role='user' so the assembler picks it up next time
            // and the dashboard shows it inline as the engine's voice. Stamp the
            // structured engine origin (mig 075) so it's attributed as an EVENT,
            // not parsed from the [Engine thrash gate] prose.
            // D-A step 4: an engine steer is inter-agent/engine traffic
            // (origin_kind='engine'), so it lands in the physical inter-agent store,
            // not `messages`. conv_key 'engine-steer' (below) keeps it un-selectable
            // as a pending event; the EVENTS lane still surfaces it via origin_kind.
            insertInterAgentEngineRow({
      work: null,
              id: steerMsgId,
              agentId,
              content: steerMsg,
              sourceAgentId: null,
              originIntent: 'thrash_gate',
              convKey: 'engine-steer',
              turnNumber,
            });
            // C6: stamp a non-NULL conv_key sentinel ('engine-steer'). The steer is
            // origin_kind='engine' with conv_key NULL, so getPendingEngineEvent (which
            // selects conv_key-NULL engine rows) would return it → the drain fires an
            // engine turn → which can mint ANOTHER steer → unbounded thrash-steer loop.
            // A non-NULL conv_key makes it un-selectable as a pending event while still
            // reaching the model (the EVENTS/awareness lane filters on origin_kind, not
            // conv_key) and still rendering in the dashboard.
          } catch { /* best effort */ }
          logger.warn('v2: thrash gate activated for signature', {
            toolName: thrash.toolName, signature: thrash.signature,
            count: thrash.count, loopCount: state.loopCount,
          }, agentId);
          state = advance(state, {
            thrashGatedSignatures: [...state.thrashGatedSignatures, thrash.signature],
            thrashGateActivatedAtLoopCount: state.thrashGateActivatedAtLoopCount ?? state.loopCount,
            // Also set pendingNudge so the steer reaches the model on the
            // very NEXT iteration even if the assembler hasn't seen the
            // persisted user message yet.
            pendingNudge: steerMsg,
          });
          try {
            broadcast({
              type: 'chat:error',
              agentId,
              error: `Engine refusing further ${thrash.toolName} calls with these args, try different input, mark complete, or block.`,
              code: 'TASK_THRASH_PAUSED',
              severity: 'warning',
              retryable: true,
            });
          } catch { /* best effort */ }
          // Don't break, let the loop continue. The next model turn will
          // see the system message and pick a wrap-up path. The runOne
          // path enforces the gate on tool execution.
        }
      }

      // ── F10 note: the start-ack floor is the wall-clock timer armed at turn
      // start (search "F10: wall-clock start-ack timer"), NOT a loop-boundary
      // check here. A boundary check could only fire between model rounds, and
      // a single slow first round pushed the ack to seconds before the reply
      // (observed live), while wakeup/drain turns with a user counterparty but
      // no waiting human got a stray "On it." attached to nothing. ──

      // ── Turn time budget, auto-continue, don't halt ──
      // (Matches v1 runtime.ts:884-919.) When a turn runs longer than 15 min,
      // force a compaction and queue a wakeup so the agent picks up where it
      // left off. After MAX_TURN_AUTO_CONTINUATIONS consecutive checkpoints
      // we give up, usually indicates a stuck loop.
      if (Date.now() - state.turnStartMs > TURN_TIME_BUDGET_MS) {
        const elapsedMin = Math.round((Date.now() - state.turnStartMs) / 60000);
        const continuationCount = (turnContinuationCounts.get(agentId) ?? 0) + 1;

        if (continuationCount > MAX_TURN_AUTO_CONTINUATIONS) {
          turnContinuationCounts.delete(agentId);
          logger.error('v2 turn auto-continuation cap reached, stopping', {
            elapsedMin, continuationCount, max: MAX_TURN_AUTO_CONTINUATIONS, agentId,
          }, agentId);
          const totalMin = (MAX_TURN_AUTO_CONTINUATIONS + 1) * (TURN_TIME_BUDGET_MS / 60000);
          const stuckMsg = (
            `[System: This task has been running for about ${totalMin} minutes without finishing. ` +
            `Pausing, this usually means a stuck loop, an over-scoped task, or a slow model. ` +
            `Send a follow-up to resume, or break the work into smaller pieces.]`
          );
          const stuckId = uuidv4();
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
            VALUES (?, ?, 'system', ?, ?, datetime('now'))
          `).run(stuckId, agentId, stuckMsg, turnNumber);
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: stuckId, agentId, role: 'system' as const,
              content: stuckMsg,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
          break;
        }

        turnContinuationCounts.set(agentId, continuationCount);
        logger.warn('v2 turn time budget reached, auto-continuing with forced compaction', {
          elapsedMin, continuationCount, agentId,
        }, agentId);

        // Force compaction so next turn starts with summarized history.
        try {
          const effectiveModel =
            state.modelId === '__auto__' ? configuredModelId : state.modelId;
          await checkAndCompact(agentId, effectiveModel, getContextWindow(effectiveModel), { force: true });
        } catch (compErr) {
          logger.warn('v2 forced compaction at turn-budget checkpoint failed', {
            agentId, error: compErr instanceof Error ? compErr.message : String(compErr),
          }, agentId);
        }

        const sysMsg = (
          `[System: This turn ran for ${elapsedMin} minutes. Pausing here and continuing on a fresh turn ` +
          `(${continuationCount} of ${MAX_TURN_AUTO_CONTINUATIONS}). ` +
          `Your earlier conversation has been summarized, pick up where you left off. ` +
          `Check tracker_list_active for the task you were working on; do not start over.]`
        );
        const sysMsgId = uuidv4();
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
          VALUES (?, ?, 'system', ?, ?, datetime('now'))
        `).run(sysMsgId, agentId, sysMsg, turnNumber);
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: sysMsgId, agentId, role: 'system' as const,
            content: sysMsg,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
        // Queue wakeup so handleMessage's finally fires the loop again
        stashContinuationIfHuman(); // C3: carry the human conversation into the continuation
        pendingWakeups.add(agentId);
        break;
      }

      // ── Pre-call compaction gate (Part V) ──
      // Check assembled context utilization BEFORE the model call. v2's
      // architecture is "compaction is a debug signal, not routine":
      //   <90%   noop (the common case)
      //   90–96% warn (log + chat:warning broadcast, every WARN is a v2 architecture bug)
      //   96–99% emergency compact (force checkAndCompact + queue wakeup)
      //   ≥99%   block (surrender turn, recovery cascade re-runs)
      const assembledEstimate = estimateAssembledTokens(agentId, contextWindow);
      // FA-M1: gate the compressible total against the compressible BUDGET (window
      // minus the non-compressible overhead the assembler produced), not the full
      // window. The numerator stays compressible-only so compaction still never
      // no-op-loops on bloat it cannot shrink.
      const gateResult = compactionGate(assembledEstimate.total, contextWindow, assemblerOverheadTokens);
      // D3: remember this iteration's utilization so the anti-hoarding advisory
      // can nudge on real context pressure instead of raw load-count.
      state = advance(state, { lastContextRatio: gateResult.ratio });
      if (gateResult.decision === 'warn') {
        // The chat:warning toast comes from compaction.ts internal WARN block
        // when checkAndCompact runs, but in WARN-only mode we don't call
        // checkAndCompact. Fire the broadcast directly so dashboard surfaces it.
        logger.warn(gateResult.reason ?? 'context utilization warning', {
          agentId, ratio: gateResult.ratio, assembledTokens: gateResult.assembledTokens,
        }, agentId);
        try {
          // User-facing: plain language. Internal reason goes to logs only.
          const ratioPct = (gateResult.ratio * 100).toFixed(0);
          broadcast({
            type: 'chat:error',
            agentId,
            error: `Agent's memory is getting full (${ratioPct}%). Working normally for now.`,
            code: 'CONTEXT_HIGH',
            severity: 'warning',
            retryable: false,
          });
        } catch { /* best effort */ }
        // Continue the turn, WARN is informational, not a blocker.
      } else if (gateResult.decision === 'compact') {
        logger.error(gateResult.reason ?? 'emergency compaction', {
          agentId, ratio: gateResult.ratio,
        }, agentId);
        try {
          const effectiveModel = isAutoRouted ? configuredModelId : configuredModelId;
          await checkAndCompact(agentId, effectiveModel, contextWindow, { force: true });
        } catch (compErr) {
          logger.warn('v2: emergency compaction failed', {
            agentId, error: compErr instanceof Error ? compErr.message : String(compErr),
          }, agentId);
        }
        // Queue wakeup so the next iteration assembles fresh post-compaction context
        stashContinuationIfHuman(); // C3: carry the human conversation into the continuation
        pendingWakeups.add(agentId);
        break;
      } else if (gateResult.decision === 'block') {
        logger.error(gateResult.reason ?? 'context impossibly full', {
          agentId, ratio: gateResult.ratio,
        }, agentId);
        const blockMsg = (
          `[System: Memory is too full to continue this turn (${(gateResult.ratio * 100).toFixed(0)}%). ` +
          `Pausing, the DOJO will compact memory and resume automatically.]`
        );
        const blockMsgId = uuidv4();
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
          VALUES (?, ?, 'system', ?, ?, datetime('now'))
        `).run(blockMsgId, agentId, blockMsg, turnNumber);
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: blockMsgId, agentId, role: 'system' as const,
            content: blockMsg,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
        // Force compaction then wakeup so we recover next turn
        try {
          await checkAndCompact(agentId, configuredModelId, contextWindow, { force: true });
        } catch { /* best effort */ }
        stashContinuationIfHuman(); // C3: carry the human conversation into the continuation
        pendingWakeups.add(agentId);
        break;
      }

      // ── v2.5.11, Routine gap-based compaction trigger ──
      // The token gate above only fires at high utilization. Long-running
      // agents whose fresh tail stays bounded never trip it, so messages
      // silently fall outside the fresh tail without ever being summarized.
      // This check fires when too many uncompacted messages have accumulated
      // outside the fresh tail, regardless of token level.
      //
      // v2.5.12, Per-call cap: maxChunksPerRun=1 so a backlog drains
      // incrementally instead of all at once. skipContinuityBrief=true so
      // routine drains don't pay brief cost or spam chat with dividers.
      //
      // v2.5.14, CRITICAL: fire-and-forget. Previously the agent's turn
      // awaited checkAndCompact, which awaited a summarizer LLM call, which
      // had only the OpenAI SDK's 10-minute default timeout. A hung
      // summarizer call would block the turn for up to 10 minutes with no
      // error and no logs. Now: kick off the drain in the background with
      // a 60s wall-clock abort, and the agent's turn proceeds immediately.
      // backgroundDrains flag prevents re-entry while a drain is in-flight
      // for this agent (so slow drains can't pile up; one in-flight max).
      if (gateResult.decision === 'noop') {
        const gapCount = getUncompactedGapCount(agentId, contextWindow);
        if (gapCount > UNCOMPACTED_GAP_THRESHOLD && !backgroundDrains.has(agentId)) {
          backgroundDrains.add(agentId);
          // Catch-up: a normal turn leaves only a few messages uncompacted, so 1
          // chunk/turn keeps up. But a freshly imported/migrated agent (or one
          // whose summarizer was broken for a while) can carry a huge backlog, 
          // at 1 chunk/turn that takes dozens of turns to clear, which reads as
          // "compacting constantly". Scale throughput (and the wall-clock budget)
          // to the backlog so a big gap drains in a few turns, then settles back
          // to 1. Still background + abortable, so turns never block on it.
          const big = gapCount > UNCOMPACTED_GAP_THRESHOLD * 4;
          const maxChunksPerRun = big ? Math.min(10, Math.ceil(gapCount / UNCOMPACTED_GAP_THRESHOLD)) : 1;
          const wallClockTimeoutMs = big ? 180_000 : 60_000;
          const drainAbort = new AbortController();
          const drainTimeout = setTimeout(() => {
            logger.warn('v2: background drain wall-clock timeout, aborting', {
              agentId, wallClockTimeoutMs,
            }, agentId);
            drainAbort.abort();
          }, wallClockTimeoutMs);
          logger.info('v2: kicking off background gap-drain (fire-and-forget)', {
            agentId, gapCount, gapThreshold: UNCOMPACTED_GAP_THRESHOLD,
            maxChunksPerRun, wallClockTimeoutMs, catchUp: big,
          }, agentId);
          checkAndCompact(agentId, configuredModelId, contextWindow, {
            maxChunksPerRun,
            skipContinuityBrief: true,
            abortSignal: drainAbort.signal,
          })
            .then((result) => {
              logger.info('v2: background gap-drain complete', {
                agentId,
                leafCreated: result.leafCreated,
                tokensReclaimed: result.tokensReclaimed,
              }, agentId);
            })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              logger.warn('v2: background gap-drain failed or aborted', {
                agentId, error: msg,
              }, agentId);
            })
            .finally(() => {
              clearTimeout(drainTimeout);
              backgroundDrains.delete(agentId);
            });
        }
      }

      // ── Phase: assemble context ──
      state = advance(state, { phase: 'assemble' });
      // Intent companion to attribution: a quick conversational ask ("add a reminder",
      // "move my 10am") must not spin up a tracked, PM-validated task that then churns.
      // Classify the trigger, a 'simple' ask from a user is conversational, a 'complex'
      // one is project work, and pass it so the assembler injects guidance to handle
      // it directly. (Reuses the complexity classifier that was computed but unconsumed.)
      const conversationalTurn = counterparty.kind === 'user'
        && complexityClassifier(lastUserMessageContent ?? '').complexity === 'simple';
      // Content-preservation for an ACTION-REQUIRED engine-origin A2A message
      // (Healer QUESTION, PM escalation, destructive-gate approval, all origin_intent
      // 'a2a_request'). It drives an engine turn, but the EVENTS/awareness lane
      // truncates each notice to a gist, which would clip the very thing the receiver
      // must act on (an approval token, the full escalation). Keep THIS event full in
      // the live tail instead: the assembler leaves the id out of the truncated
      // awareness block so scopeToEngineTurn's copy is what the model reads. Scoped to
      // 'a2a_request' only, so scheduler/reminder engine turns are unchanged.
      let engineEventKeepFullId: string | null = null;
      if (isEngineTurn && pendingEngineEvent?.originIntent === 'a2a_request') {
        try {
          // D-A step 4: an action-required engine-origin A2A ('a2a_request') is
          // delivered by deliverA2AMessage, which now persists into the STORE, so
          // resolve its id from the event's ACTUAL home table. A `messages`-only read
          // would miss the store row, drop engineEventKeepFullId to null, and let the
          // approval token / full escalation get clipped into the truncated gist.
          const kfTable = pendingEngineEvent.src === 'ia' ? 'inter_agent_messages' : 'messages';
          const idRow = db.prepare(`SELECT id FROM ${kfTable} WHERE agent_id = ? AND rowid = ?`)
            .get(agentId, pendingEngineEvent.rowid) as { id: string } | undefined;
          engineEventKeepFullId = idRow?.id ?? null;
        } catch { /* best effort, fall back to the truncated awareness gist */ }
      }
      // C28 Part 1: one shared turn context, threaded into BOTH assembleContext
      // (system) AND the message-injection mctx, so the msg.turn-context entry can
      // read counterparty / othersWaiting / conversationalTurn / isEngineTurn (they
      // are not recomputed).
      const sharedTurnContext = { latestUserSource, ttsEngine: latestTtsEngine, isA2ATurn, isEngineTurn, isNotificationTurn, counterparty, othersWaiting: Math.max(0, waitingConvs.length - 1), conversationalTurn, engineEventKeepFullId, resolvedReplyChannel: ownerAffinityDestination ?? undefined };
      // LIVE = RELOAD, pre-model half (incident 2026-07-06): the persisted-output
      // visibility keys on the six-way interAgentTurn union (computed post-model,
      // below), but the dashboard's live suppression needs the turn kind BEFORE the
      // first chunk/tool frame. Stamp here from the union's PRE-MODEL-knowable
      // terms: the A2A trigger, an agent counterparty, and the background-A2A
      // condition (mostRecentIsA2A with no unanswered user, which also subsumes the
      // exchange term). The spontaneous/pure-background terms depend on what the
      // model does, so the post-model re-stamp below remains as the catch-up for
      // later phases of the same turn.
      // USER TURNS ARE NEVER RECLASSIFIED (owner law 2026-07-09): a turn whose
      // counterparty is a human stays turnKind 'user' for its whole life, no
      // matter what it does along the way. Without this guard, the recency terms
      // below flip a user-facing turn to 'a2a' the moment it delegates via
      // send_to_agent, which hides the working dots + stop button in regular
      // (non-wordy) mode and buries the rest of the turn's output as inter-agent
      // traffic (production transcript 2026-07-09).
      const preModelInterAgent = counterparty.kind !== 'user' && (isA2ATurn || counterparty.kind === 'agent' || (mostRecentIsA2A && !hasUnansweredUser));
      if (preModelInterAgent && currentTurnKind.get(agentId) !== 'a2a') {
        currentTurnKind.set(agentId, 'a2a');
        broadcast({ type: 'agent:status', agentId, status: 'working', turnKind: 'a2a', userFacing: !!chosenConvKey });
      }
      const ctx = await assembleContext(agentId, contextModelId, sharedTurnContext);
      lastAssembledAtIso = new Date().toISOString(); // F9: see claimAssembledSiblings
      let systemPrompt = ctx.systemPrompt;
      const messages = ctx.messages;
      // Settled-context hint (see settledContextWakeTurn above). Injected at the
      // TAIL of the assembled messages on every iteration of a settled-context
      // turn: assembly rebuilds from persisted rows each round, so an unpersisted
      // hint must be re-applied per assembly. Tail position keeps the cacheable
      // prefix untouched. Folded into a trailing user-role message (string or
      // block-array content) to preserve role alternation; appended as its own
      // user message when the tail is an assistant turn. Advice framing on
      // purpose ([Engine hint], never an order): user-authored content wins per
      // the precedence ladder, and result-delivery turns (a peer's answer coming
      // back, a reminder firing) must stay free to message the user.
      if (messages.length > 0 && state.loopCount === 0) {
        // FIRST ITERATION ONLY: the hint orients the turn at its start. Injected
        // mid-turn it lands directly after a tool result, where "respond only to
        // the newest incoming item" reads as verification pressure on a weak
        // model (battery 2026-07-10: a file_read re-verification spiral surfaced
        // with the every-iteration version; the engine STOP guard caught it).
        // Two shapes of the same disease (both reproduced live on dev 2026-07-10):
        // a background wake with nothing waiting re-answers the last visible
        // question, AND a turn legitimately serving conversation X re-answers a
        // settled conversation Y on the side (the owner's 9:39 PM duplicate came
        // from an ordinary inbound serving turn). So the hint is injected on
        // EVERY turn, worded for whichever shape this turn is.
        const SETTLED_HINT = settledContextWakeTurn
          ? '[Engine hint: no one is waiting on a reply right now. Every user conversation ' +
            'visible above has already been answered and is closed. Do not re-answer, re-send, ' +
            'or redo anything from it. Act only on what woke you this turn, and only deliver ' +
            'information that is genuinely new (a result that just arrived, a reminder firing, ' +
            'the event itself).]'
          : '[Engine hint: respond only to the newest incoming item, the one that triggered ' +
            'this turn. Every OTHER user conversation visible above has already been answered ' +
            'and is closed; do not re-answer, re-send, or redo any of it, even if it looks ' +
            'recent or unfinished.]';
        const tail = messages[messages.length - 1];
        if (tail.role === 'user') {
          if (typeof tail.content === 'string') {
            tail.content = `${tail.content}\n\n${SETTLED_HINT}`;
          } else if (Array.isArray(tail.content)) {
            tail.content.push({ type: 'text', text: SETTLED_HINT });
          }
        } else {
          messages.push({ role: 'user', content: SETTLED_HINT }); // registry-exempt(2026-07-16): settled-hint fallback needs the in-flight messages array; migrate with the volatile-injection registry refactor
        }
      }

      // FA-M1: record the non-compressible overhead the assembler just produced
      // (system prompt + the tool-schema/output reserve it also reserves) so the
      // NEXT iteration's pre-call gate measures the compressible total against the
      // real compressible budget instead of the full window.
      assemblerOverheadTokens = estimateTokens(systemPrompt) + TOOL_AND_OUTPUT_RESERVE;

      // FA-M1: surface the assembler's oldest-fresh-tail eviction. budgetFreshTail
      // silently dropped older fresh-tail groups to fit the window (live-view loss
      // where the weakest model needs it most). Emit the existing CONTEXT_HIGH
      // warning once per turn so the dashboard shows it instead of it being
      // log-only. The dropped rows are persisted and later summarized (not lost).
      if (!freshTailDropWarned && (ctx.freshTailDropped ?? 0) > 0) {
        freshTailDropWarned = true;
        const dropped = ctx.freshTailDropped ?? 0;
        logger.warn('assembler evicted oldest fresh-tail messages to fit the window (live-view loss)', {
          agentId, dropped, contextWindow,
        }, agentId);
        try {
          broadcast({
            type: 'chat:error',
            agentId,
            error: `Agent's memory is full, so it set aside its ${dropped} oldest recent message${dropped === 1 ? '' : 's'} to keep working. Older context is still saved.`,
            code: 'CONTEXT_HIGH',
            severity: 'warning',
            retryable: false,
          });
        } catch { /* best effort */ }
      }

      // One message-injection context for this iteration's §3c entries
      // (technique, context-gap, tracker-notif, nudge, tool-note, turn-context). The
      // loop sets mutable fields (pendingNudge, technique payload) at each site and
      // calls injectRegistryMessage, so injection is registry-owned (R8). The
      // registry is the only assembler path (R7), so this is always built.
      const mctx: AssemblyContext = buildAssemblyContext(
        agentId,
        contextModelId,
        sharedTurnContext,
        { loopCount: state.loopCount, turnNumber, lastUserMessageContent: lastUserMessageContent ?? '', pendingNudge: state.pendingNudge },
      );

      // ── Technique matcher (Part VI #5, Phase 5) ──
      // Replaces v1's "MANDATORY: Check Techniques Before Starting Work"
      // prompt instruction with engine-side fuzzy matching: when the user
      // sends a message, the engine matches their intent against published
      // techniques and surfaces relevant ones in the system prompt. The
      // agent doesn't have to remember to check the index.
      //
      // Only fires:
      //   - on the first loop iteration of a turn (not per tool call)
      //   - when there is a last user message (not on auto-continuations,
      //     A2A wakes, or PM pokes, those carry their own context)
      //   - not for the PM agent (situation reports land as role='user',
      //     don't need technique hints injected on every poke tick).
      if (state.loopCount === 1 && lastUserMessageContent && !isPMAgent(agentId)) {
        try {
          const techniques = listTechniques({ state: 'published' }).map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description ?? undefined,
            tags: t.tags,
          }));
          // Match the ask against technique-intent embeddings (remediation
          // Phase 2). Semantic matching went GREEN on the floor model in
          // S5.4/S5.5 (0.56/0.68/0.72 strong matches on zero-overlap
          // phrasings; clean on unrelated pings). The token-overlap matcher
          // survives only as semanticTechniqueMatches' internal fallback for
          // when the embedding service is down (recall weakens, never zeroes).

          // Attachment-aware query (remediation Phase 3, S5.1/S5.2): keep the
          // attachment filename/kind as intent signal, strip pointer
          // boilerplate so a photo-with-little-text message can still match a
          // photo technique.
          const matchQuery = buildTechniqueMatchQuery(lastUserMessageContent);
          const matches = await semanticTechniqueMatches(matchQuery, techniques);
          if (matches.length > 0) {
            // Two modes:
            //   - STRONG MATCH (score >= 0.5): the engine loads TECHNIQUE.md
            //     and WRAPS the user's most recent message with the technique
            //     body, framed as authoritative guidance from the user. The
            //     wrap is in-message (user-role, adjacent to the ask) rather
            //     than appended to the system prompt, frontier models weight
            //     user-role instructions and recent tokens far more than
            //     buried system-prompt rules. v2.2.8 inlined into the system
            //     prompt and the model still ignored it; v2.3.2 puts the
            //     technique where the model actually pays attention.
            //   - WEAK MATCH (score < 0.5): keep the existing hint behavior
            //     in the system prompt; agent decides whether to load.
            //
            // Cap at one auto-injected technique per turn to keep token cost
            // bounded. If the technique is too large to inline (>25K chars ≈
            // 6K tokens), still wrap the user message but with a load-it
            // instruction instead of the full body.
            const STRONG_MATCH_THRESHOLD = SEMANTIC_STRONG_THRESHOLD;
            const MAX_INLINE_CHARS = 25_000;
            const strongMatch = matches[0].score >= STRONG_MATCH_THRESHOLD ? matches[0] : null;
            const weakMatches = strongMatch
              ? matches.slice(1).filter((m) => m.score < STRONG_MATCH_THRESHOLD)
              : matches;

            let injectedTechniqueId: string | null = null;
            let techniqueInjection: string | null = null;
            if (strongMatch) {
              try {
                const { getTechniqueDetail, recordTechniqueUsage } = await import('../../techniques/store.js');
                const detail = getTechniqueDetail(strongMatch.technique.id);
                if (detail?.instructions && detail.instructions.length > 0) {
                  const md = detail.instructions;
                  const tooLarge = md.length > MAX_INLINE_CHARS;
                  // Audit C12: the old implementation PREPENDED this text into
                  // the user's own message, so an engine directive borrowed
                  // tier-1 authority and structurally outranked the user's
                  // actual words. The preserved reason (v2.2.8 → v2.3.2
                  // history): adjacency to the ask is what makes the model
                  // follow the technique; system-prompt placement was ignored.
                  // So: keep adjacency by injecting a SEPARATE engine-marked
                  // message right after the ask, framed at its true tier
                  // (task/technique notes, below the live user message).
                  const header =
                    `[DOJO TECHNIQUE, engine-injected. This is technique guidance (precedence: task/technique notes); the user's live message above outranks it wherever they conflict.]`;
                  if (tooLarge) {
                    techniqueInjection =
                      `${header}\nThis task matches the "${strongMatch.technique.name}" technique. The full instructions are too long to inline (${md.length} chars), load it via use_technique('${strongMatch.technique.id}') before doing the work, then follow its steps unless the user said otherwise.`;
                  } else {
                    techniqueInjection =
                      `${header}\nThis task matches the "${strongMatch.technique.name}" technique. Follow the procedure below unless the user's message says otherwise.\n\n` +
                      `--- TECHNIQUE: ${strongMatch.technique.name} ---\n${md}\n--- END TECHNIQUE ---`;
                  }
                  injectedTechniqueId = strongMatch.technique.id;
                  turnInjectedTechniqueId = strongMatch.technique.id;
                  try { recordTechniqueUsage(strongMatch.technique.id, agentId); } catch { /* best effort */ }
                  logger.info('v2 techniqueMatcher: injecting strong-match technique as engine message', {
                    agentId,
                    techniqueId: strongMatch.technique.id,
                    techniqueName: strongMatch.technique.name,
                    score: strongMatch.score,
                    contentChars: md.length,
                    inlinedFully: !tooLarge,
                  }, agentId);
                }
              } catch (loadErr) {
                logger.warn('v2 techniqueMatcher: strong-match load failed, falling back to hint', {
                  agentId,
                  techniqueId: strongMatch.technique.id,
                  error: loadErr instanceof Error ? loadErr.message : String(loadErr),
                }, agentId);
              }
            }

            // Inject as its own message AFTER the ask (post-assembly, so the
            // role-merge mutation cannot fuse it into the user's message or a
            // tool_result). The DB-stored rows are untouched, only this
            // in-flight model call sees the injection.
            if (techniqueInjection) {
              mctx.techniqueStrong = techniqueInjection;
              injectRegistryMessage('msg.technique-strong', messages, mctx);
            }

            // Weak matches (and the strong match if its load failed) get the
            // legacy "consider these" hint.
            const hintMatches = injectedTechniqueId === null
              ? matches
              : weakMatches;
            if (hintMatches.length > 0) {
              const lines = hintMatches.map((m) => {
                const reason = m.score >= 0.6 ? 'strong match' : 'possible match';
                const desc = m.technique.description ? `, ${m.technique.description}` : '';
                return `- \`${m.technique.name}\` (${reason})${desc}\n  Load with \`use_technique('${m.technique.id}')\` if applicable.`;
              });
              const hintHeader = injectedTechniqueId
                ? `\n\n## Other Techniques That Might Also Apply\n\n`
                : `\n\n## Possibly Relevant Techniques\n\n`;
              const weakHint = hintHeader +
                `Based on the user's message, the DOJO matched these techniques. Load any that fit the task; ignore otherwise.\n\n` +
                lines.join('\n');
              // Inject as a post-tail engine message (NOT appended to the
              // system prompt). The match-strength wording changes per user
              // message, so keeping it out of the system prefix preserves
              // prompt-cache warmth across turns. Mirrors the strong-match
              // injection above (its own message, after the ask).
              mctx.techniqueWeakHint = weakHint;
              injectRegistryMessage('msg.technique-weak', messages, mctx);
            }
            logger.debug('v2 techniqueMatcher: surfaced matches', {
              agentId,
              matchCount: matches.length,
              autoInjected: injectedTechniqueId,
              names: matches.map((m) => m.technique.name),
            }, agentId);
          }
        } catch (err) {
          // "no such table: techniques" fires during integration test runs
          // (mocked in-memory DB without the techniques table) and pre-migration
          // fresh installs. It's not a production failure mode, log at debug,
          // not warn, so it doesn't pollute the WARN-rate acceptance signal.
          const msg = err instanceof Error ? err.message : String(err);
          const isMissingTable = /no such table/i.test(msg);
          if (isMissingTable) {
            logger.debug('v2 techniqueMatcher: techniques table not present (expected in tests/fresh DBs)', { agentId }, agentId);
          } else {
            logger.warn('v2 techniqueMatcher failed (non-fatal)', { agentId, error: msg }, agentId);
          }
        }
      }

      // ── Context-gap detection (2026-06-15, "ask when stuck") ──
      // The engine nudges the agent to ASK the user when it can SEE the agent
      // lacks enough to proceed (v1: an attachment with no instruction),
      // instead of inferring intent or hoping a weak model notices. Advisory
      // [Engine hint] via the one engine-message channel; the agent uses
      // judgment (and ignores it when a task/technique/context covers the gap).
      // Same fire conditions as the technique matcher: first iteration, real
      // user message, not the PM.
      if (state.loopCount === 1 && lastUserMessageContent && !isPMAgent(agentId)) {
        try {
          // Same site, same alternation guard, byte-identical injection. Registry
          // mode renders msg.context-gap (same detectContextGap call) and injects
          // through the registry channel; legacy mode inline. The guard is the
          // loop's (it depends on the live messages tail).
          if (messages.length === 0 || messages[messages.length - 1].role === 'user') {
            injectRegistryMessage('msg.context-gap', messages, mctx);
          }
        } catch { /* advisory only, never block the turn */ }
      }

      // ── Multi-step detection (v2.3.3) ──
      // Engine-side detection of prompts that need a tracker project.
      // When confident (heuristic high, or local-LLM classifier confirms),
      // create the project + initial task directly so the agent can't
      // forget to do it. Same lesson as the technique matcher above:
      // system-prompt instructions don't reliably get followed.
      //
      // Same fire conditions as technique matcher: loopCount === 1 with
      // a real user message (not auto-continuation / A2A / PM poke).
      //
      // v2.7.27: skip for the PM agent. The PM's situation reports land as
      // role='user' messages on its conversation; the classifier was treating
      // them as multistep user intent and auto-creating tracker projects
      // titled "Tracker review -- N active tasks:". Polluted the PM's view
      // every poke tick. PM never wants engine-auto-created projects.
      // D-B v2: also skip the Healer. It has no tracker tools and never touches
      // the tracker (its SOUL forbids it), so an engine-opened task it cannot
      // tend would go stale and trip the PM poke ladder against it, which is
      // exactly the state a held destructive consent must not leave behind.
      // P2b: also skip the Dreamer. Its cycle message (wakeupDreamer) is an
      // engine-synthetic role='user' row, not a user ask; its work is engine-
      // orchestrated memory maintenance. Auto-scaffolding it manufactured a
      // tracker project + task on the Dreamer every batch, which then same-turn-
      // closed and fired a notifyPrimaryAgent completion pair onto the primary's
      // chat (production transcript 2026-07-17). The tracker is the wrong
      // instrument for engine-lane maintenance, so the trigger simply skips it.
      if (state.loopCount === 1 && lastUserMessageContent && !isPMAgent(agentId) && !isHealerAgent(agentId) && !isDreamerAgent(agentId)) {
        try {
          const { detectMultistep, getMultistepConfig } = await import('./classifiers/multistep.js');
          const cfg = getMultistepConfig();
          if (cfg.enabled) {
            // Skip if there's a RECENTLY-TENDED active tracker task assigned
            // to this agent, assume it's still being worked. This avoids
            // creating a sibling project on a quick follow-up message.
            //
            // v3.1.11 (FN-9): narrowed from "any open task" to "an open task
            // touched within STALE_TASK_WINDOW_MINUTES". The guard exists to
            // dodge sibling projects on quick follow-ups, and a quick follow-up
            // lands minutes after the agent last touched the task it is
            // continuing, so the window keeps that protection intact. But a
            // STALE open task (abandoned long ago) must NOT suppress, or new
            // untracked multi-step work rides in under the old task forever
            // (one of the two disarm holes this fix closes).
            const db = getDb();
            const existingTask = db.prepare(`
              SELECT id FROM tasks
              WHERE assigned_to = ? AND status IN ('on_deck', 'in_progress', 'paused')
                AND datetime(updated_at) >= datetime('now', ?)
              LIMIT 1
            `).get(agentId, `-${STALE_TASK_WINDOW_MINUTES} minutes`) as { id: string } | undefined;

            // F12 (harness finding, wave 2): agent CREATION stores the new agent's
            // system prompt as both a role='system' row AND a role='user' bootstrap
            // message (gateway/routes/agents.ts), so this classifier treated every
            // creation prompt as a user ask and auto-created a junk project, which
            // the PM then burned turns renaming, and which suppressed legitimate
            // auto-scaffolding later (existingTask). A bootstrap prompt is exactly
            // identifiable: the "user" text is byte-identical to a system row.
            const bootstrapTwin = db.prepare(
              `SELECT 1 FROM messages WHERE agent_id = ? AND role = 'system' AND content = ? LIMIT 1`,
            ).get(agentId, lastUserMessageContent);
            if (!existingTask && !bootstrapTwin) {
              const decision = await detectMultistep(lastUserMessageContent, agentId, cfg);
              logger.info('v2 multistep classifier ran', {
                agentId,
                source: decision.source,
                multistep: decision.multistep,
                name: decision.name,
                signals: decision.heuristic.signals,
              }, agentId);

              if (decision.multistep) {
                const { createProject } = await import('../../tracker/schema.js');
                const { ENGINE_AUTO_MARKER } = await import('./classifiers/multistep.js');

                // Engine names projects/tasks from a cleaned slice of the user's
                // prompt (F12.5: strip politeness/filler, truncate at a word
                // boundary, capitalize, so the interim kanban name is readable
                // instead of a mangled raw slice). The PM agent gets dispatched
                // immediately after creation to rename both via its local model
                // (see the rename handoff below). Async naming keeps latency clean.
                const fallbackName = deriveScaffoldTitle(lastUserMessageContent);
                const projectTitle = decision.name ?? (fallbackName || 'Multi-step task');
                const taskTitle = decision.name ?? (fallbackName || 'Initial task');

                try {
                  // createdBy == agentId so createProject's auto-start
                  // condition fires (assignee === createdBy on the first
                  // step → status='in_progress'). Otherwise the task lands
                  // in on_deck and waits for someone to pull it forward.
                  // Matches the pattern when an agent calls
                  // tracker_create_project on itself.
                  //
                  // Description carries the ENGINE_AUTO_MARKER prefix so
                  // tracker_create_project's dup guard can detect this
                  // project as engine-auto-created and steer the agent
                  // toward tracker_edit_task instead of refusing them into
                  // a parallel project.
                  const created = createProject({
                    origin: { kind: 'engine_scaffold', sourceMessageId: state.lastUserMessageId, turn: turnNumber, convKey: chosenConvKey },
                    title: projectTitle,
                    description: ENGINE_AUTO_MARKER + lastUserMessageContent.slice(0, 2000),
                    level: 1,
                    createdBy: agentId,
                    tasks: [{
                      title: taskTitle,
                      description: lastUserMessageContent.slice(0, 2000),
                      assignedTo: agentId,
                      priority: 'normal',
                    }],
                  });
                  logger.info('v2 multistep: auto-created tracker project', {
                    agentId,
                    projectId: created.projectId,
                    taskIds: created.taskIds,
                    title: projectTitle,
                    source: decision.source,
                  }, agentId);

                  // F2.1 coverage: the engine owns the lifecycle of every task it
                  // opens. This turn-start classifier scaffold feeds the SAME
                  // same-turn close and PM poke-chain sweep as the mid-turn 6-call
                  // scaffold site (~:6030), so a read-only turn's classifier-created
                  // task cannot dangle in_progress after its brief is delivered
                  // (previously it waited on the 30-minute PM sweep backstop).
                  state = advance(state, { autoScaffoldedTaskIdThisTurn: created.taskIds[0] });

                  // Inject the standard task-assignment notification, 
                  // same payload tracker_create_task uses, including the
                  // explicit "When finished, call tracker_update_status"
                  // instruction. Persists to DB (survives compaction)
                  // and broadcasts WS for the dashboard. skipWake=true
                  // because we ARE the running turn, handleMessage
                  // would just queue a redundant follow-up.
                  const { injectTaskAssignmentNotification } = await import('../../tracker/notify.js');
                  const taskId = created.taskIds[0];
                  const notif = injectTaskAssignmentNotification({
                    assignedAgentId: agentId,
                    creatorAgentId: 'dojo-system',
                    taskId,
                    title: taskTitle,
                    description: lastUserMessageContent.slice(0, 2000),
                    projectId: created.projectId,
                    priority: 'normal',
                    skipWake: true,
                  });

                  // Push the same content into the in-flight messages
                  // array so the agent sees it THIS turn (not just on
                  // the next assemble). Goes after the user's prompt
                  // chronologically, agent reads "user said X" then
                  // "the engine assigned you a task for it."
                  if (notif.ok && notif.content) {
                    mctx.trackerNotif = notif.content;
                    injectRegistryMessage('msg.tracker-notif', messages, mctx);
                  }

                  // START ACK (NEXT-WAVE item 1): the engine just decided this
                  // user request is project-worthy, so the person who asked hears
                  // "on it" right now, before the model does anything. Guaranteed
                  // here (not left to the model) so it survives the exact
                  // production failure where the floor model ended the turn on an
                  // A2A send and the owner heard nothing. One per turn.
                  // RC-4.2: never start-ack an agent-flagged counterparty (ack ping-pong).
                  if (counterparty.kind === 'user' && !counterpartyIsAgentSender && !engineStartAckDeliveredThisTurn) {
                    // Flag set synchronously at the fire decision so a second
                    // site can never double-ack. Wording is composed fire-and-
                    // forget (best-effort model, guaranteed pool fallback) so it
                    // never delays the model loop; an ack always lands.
                    engineStartAckDeliveredThisTurn = true;
                    // Do NOT splice the project title into the sentence: it is derived
                    // from the raw, truncated user request and reads as broken grammar.
                    // The composer sees the user's message for context but keeps the
                    // line title-free; the person just sent the request so they know
                    // what it refers to.
                    void (async () => {
                      const ackText = await composeStartAck({ userMessage: lastUserMessageContent ?? '', agentId });
                      await deliverEngineUserAck(ackText, 'engine_start_ack');
                    })();
                  }

                  // ── PM rename handoff (async, fire-and-forget) ──
                  // The project + first task carry cleaned-but-interim names; hand
                  // both to the PM agent to rewrite into a proper umbrella + first-
                  // step name via its local model. The user-facing agent does not
                  // wait; a failed PM call just leaves the interim names in place.
                  // Factored into dispatchPMRenameHandoff so the mid-turn scaffold
                  // site (below) uses the identical dispatch (F12.5).
                  void dispatchPMRenameHandoff({
                    callingAgentId: agentId,
                    projectId: created.projectId,
                    taskId,
                    projectTitle,
                    taskTitle,
                    originalPrompt: lastUserMessageContent,
                  });
                } catch (createErr) {
                  logger.warn('v2 multistep: createProject failed (non-fatal)', {
                    agentId,
                    error: createErr instanceof Error ? createErr.message : String(createErr),
                  }, agentId);
                }
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isMissingTable = /no such table/i.test(msg);
          if (isMissingTable) {
            logger.debug('v2 multistep: tracker tables not present (expected in tests/fresh DBs)', { agentId }, agentId);
          } else {
            logger.warn('v2 multistep classifier failed (non-fatal)', { agentId, error: msg }, agentId);
          }
        }
      }

      // ── F9: explicit-delegation routing hint ───────────────────────────────
      // The user EXPLICITLY routed work to the agent's own agents ("have one of
      // your agents research it and report back to me") and the floor model was
      // observed silently doing the work itself, never mentioning the choice.
      // Owner stance (middle): keep the agent's judgment, but the routing
      // instruction must be SURFACED (delegate, or say why not); a silent
      // override must be impossible in practice. Same guard family as the
      // multistep classifier: first tool round with a real user message, this
      // turn is FOR a user (not A2A), not the PM, not the Healer. Skips
      // engine-shaped messages (an engine notice is not the user delegating).
      // Advice voice (tier-7), never an order; the agent still decides.
      if (
        state.loopCount === 1 &&
        lastUserMessageContent &&
        counterparty.kind === 'user' &&
        !isPMAgent(agentId) &&
        !isHealerAgent(agentId) &&
        detectExplicitDelegation(lastUserMessageContent)
      ) {
        try {
          const { looksLikeEngineMessage } = await import('./classifiers/multistep.js');
          if (!looksLikeEngineMessage(lastUserMessageContent)) {
            // Model-visible THIS turn: inject the hint right after the user's ask
            // via the registry channel (same path as msg.tracker-notif). The
            // colon-bracket "[Engine hint: ...]" form is the live advice voice.
            mctx.delegationHint = `[Engine hint: ${DELEGATION_HINT_BODY}]`;
            injectRegistryMessage('msg.delegation-hint', messages, mctx);

            // Persist for later turns: an origin_kind='engine' inter-agent row the
            // EVENTS lane surfaces next turn. conv_key sentinel 'engine-steer'
            // keeps it un-selectable as a pending engine event. Label form
            // ("[Engine hint] body", space not colon) so the events-lane
            // leading-bracket strip drops only the label and keeps the body; a
            // single wrapping "[Engine hint: ...]" bracket would be stripped whole.
            insertInterAgentEngineRow({
      work: null,
              id: uuidv4(),
              agentId,
              content: `[Engine hint] ${DELEGATION_HINT_BODY}`,
              sourceAgentId: null,
              originIntent: 'delegation_hint',
              convKey: 'engine-steer',
              turnNumber,
            });

            logger.info('v2 F9: explicit-delegation hint fired (user routed the work to the agent\'s agents; injected the delegate-or-say-why steer)', {
              agentId, turnNumber, loopCount: state.loopCount,
            }, agentId);
          }
        } catch (err) {
          logger.warn('v2 F9 delegation-hint failed (non-fatal)', {
            agentId, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
      }

      // Inject user-uploaded attachments (images, PDFs) as content blocks.
      // Without this, the agent never sees images/PDFs the user attached, 
      // it only sees the text content of those messages and hallucinates.
      // Same path v1 uses (runtime.ts:1929 in v1).
      //
      // v2.3.18: oversized images get downscaled to fit the 5MB model cap
      // here. Persist a one-shot system note for any FRESH resize so the
      // user knows what happened (later turns hit the on-disk cache and
      // stay silent).
      const { injectAttachmentBlocks } = await import('../runtime.js');
      // Defensive default, older mocks may return undefined.
      const freshResizes = injectAttachmentBlocks(messages, agentId) ?? [];
      if (freshResizes.length > 0) {
        try {
          // v2.3.19, rectifier supplies the agent-facing note directly.
          // Fall back to the legacy size-based formatter for back-compat
          // when only originalSize/finalSize are present.
          const { formatBytes } = await import('../image-prep.js');
          const lines = freshResizes.map((r) => {
            if (r.note) return r.note;
            const orig = r.originalSize ?? 0;
            const fin = r.finalSize ?? 0;
            return `Image \`${r.filename}\` was downscaled from ${formatBytes(orig)} to ${formatBytes(fin)} to fit the model's 5 MB per-image limit.`;
          });
          const noteContent = `[Engine: input preparation]\n${lines.join('\n')}`;
          const noteId = uuidv4();
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
            VALUES (?, ?, 'system', ?, ?, datetime('now'))
          `).run(noteId, agentId, noteContent, turnNumber);
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: noteId, agentId, role: 'system' as const,
              content: noteContent,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
        } catch (err) {
          logger.warn('v2: failed to persist image-resize system note (non-fatal)', {
            agentId, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
      }

      // Inject pendingNudge if present (synthetic user message, not persisted).
      // Per v1 runtime.ts:940-947, only inject if last message is assistant
      // (so alternation stays valid). Then clear the nudge.
      if (state.pendingNudge && (messages.length === 0 || messages[messages.length - 1].role === 'assistant')) {
        mctx.pendingNudge = state.pendingNudge;
        injectRegistryMessage('msg.pending-nudge', messages, mctx);
        state = advance(state, { pendingNudge: null });
      }

      // Empty-messages guard (preserve v1 behavior at runtime.ts:1014-1020)
      if (messages.length === 0) {
        logger.info('v2: assembled context has zero messages, clean exit', {
          agentId,
          loopCount: state.loopCount,
        }, agentId);
        setAgentStatus(agentId, 'idle');
        break;
      }

      // ── Phase: model call ──
      // (Auto-routing + capability gate + retry-fallback + TRUE streaming.)
      state = advance(state, { phase: 'callLLM' });
      const messageId = uuidv4();
      state = advance(state, { currentMessageId: messageId });

      // ── Auto-routing model selection (matches v1 runtime.ts:954-988) ──
      // For auto-routed agents, pick the right model for THIS query. Lock
      // the model across tool loops so we don't switch mid-task.
      let modelId: string;
      let routerTier: string | null = null;
      // Captured for the (gated, off-by-default) low-confidence shadow probe
      // that harvests over-routing labels. Only the fresh-decision path probes,
      // never the mid-task locked-model reuse.
      let routerConfidence = 0;
      let routerFreshDecision = false;
      const excludedModels: string[] = [];

      if (isAutoRouted) {
        if (state.lockedModelId && state.loopCount > 1) {
          modelId = state.lockedModelId;
          routerTier = state.lockedTier;
          logger.info('v2 auto-router: using locked model (mid-task)', {
            modelId, tier: routerTier,
          }, agentId);
        } else {
          const { decideTier } = await import('../../router/decide.js');
          const { selectModel, logRouterDecision } = await import('../../router/selector.js');
          // Layered decision: structural rules -> semantic classifier ->
          // keyword heuristic fallback. See router/decide.ts.
          const decision = await decideTier(
            systemPrompt,
            messages as Array<{ role: string; content: string | object[] }>,
            agentId,
            // Authoritative user query, clean of engine injections (technique
            // hints etc.) that ride in the messages array as user-role entries.
            lastUserMessageContent,
          );
          routerTier = decision.tier;
          routerConfidence = decision.confidence;
          routerFreshDecision = true;
          const selected = selectModel(decision.tier, agentId, undefined, ['tools']);
          if (!selected) {
            revertTriggerStampOnAbort(); // N-1: no answer produced, re-arm the ask
            throw new AgentError('Auto-router: no models available in any tier', agentId, { code: 'NO_MODEL' });
          }
          modelId = selected.modelId;
          logger.info(`v2 auto-router: tier=${decision.tier} (${decision.method}) → ${modelId}`, {
            tier: decision.tier,
            method: decision.method,
            confidence: Number(decision.confidence.toFixed(3)),
            modelId,
            fallbackUsed: selected.fallbackUsed,
          }, agentId);
          // Record the decision so the Router tab can chart tier usage over time.
          // Only the scored path is logged (one decision per task), the mid-task
          // locked-model branch above reuses this same decision, so logging it
          // too would double-count.
          logRouterDecision(
            agentId,
            decision.scores,
            decision.rawScore,
            decision.tier,
            modelId,
            selected.fallbackUsed,
            decision.latencyMs,
            decision.method,
            decision.confidence,
            decision.headVersion,
            decision.queryPreview,
          );
        }
      } else {
        modelId = configuredModelId;
      }
      state = advance(state, { modelId, routerTier });

      // ── Pre-flight capability enforcement (matches v1 runtime.ts:995) ──
      // Routes images through the fallback vision model when configured
      // (replacing each image block with a text description), or strips
      // them if no fallback is set. Returns useTools=false if model
      // lacks tool support (with banner). Now async because the
      // fallback caption call is a network round-trip.
      const { enforceModelCapabilities } = await import('../runtime.js');
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
        try {
          // RECENT OUTBOUND (RC-12 item 7): the last N sends in 24h, engine-verified.
          // Survives scoping (receipts are not conversation rows), so a denial or a
          // "did you send it" is answerable from fact, not scoped-away memory.
          const recentOut = getRecentOutbound(agentId, 24, 5);
          if (recentOut.length > 0) {
            const outLines = recentOut.map(
              (d) => `${relativeTimeAgo(d.createdAt)} ${channelLabel(d.channel)} -> ${d.recipient ?? 'unknown'}`,
            );
            pushEngineMessage(messages, `RECENT OUTBOUND (engine-verified):\n${outLines.join('\n')}`); // registry-exempt(2026-07-16): RC-12 receipts block reads per-iteration ledger state; migrate with the volatile-injection registry refactor
          }

          // Pending-question header (RC-1 item 2): quote the agent's own most-recent
          // message TO THIS counterparty (never another conversation's content) so a
          // bare answer ("5550001234") is bindable even by the weakest model. Dedup:
          // a CROSS-recipient send (receipt convKey != this turn's key) already put an
          // echo row into this counterparty's fresh tail carrying the same text, so the
          // header would duplicate it, skip it while that echo is recent (still in the
          // live tail); inject it for a same-conversation send (never echoed) or an old
          // cross-recipient send whose echo has aged out of the tail window.
          // P6b-2: ID-keyed selection first. The turn root carries THIS
          // conversation's identity; the most recent delivery INTO it comes
          // from the deliveries rows, no recipient fuzz. The alias-hint path
          // survives as the legacy prong while pre-121 history ages out.
          const pendConvId = currentTurnRoot.get(agentId)?.conversationId ?? null;
          let pend: ReturnType<typeof mostRecentDeliveryTo> = pendConvId
            ? mostRecentDeliveryToConversation(agentId, pendConvId, 48)
            : null;
          if (!pend) {
            const pendHints = [counterparty.senderId, counterparty.name].filter(
              (h): h is string => !!h && h.trim().length > 0,
            );
            for (const h of pendHints) { pend = mostRecentDeliveryTo(agentId, h, 48); if (pend) break; }
          }
          if (pend && pend.sentText && pend.sentText.trim()) {
            // P6b-2: the 2h "echo probably still in the tail" clock is dead.
            // We HOLD the assembled context right here, so whether the echo
            // row duplicates this header is a direct presence check on it.
            const quotedProbe = pend.sentText.trim().slice(0, 120);
            const echoInAssembledTail = quotedProbe.length > 0 && messages.some(
              (mRow) => mRow.role === 'assistant' && typeof mRow.content === 'string' &&
                mRow.content.includes('[Sent via') && mRow.content.includes(quotedProbe),
            );
            if (!echoInAssembledTail) {
              const quoted = pend.sentText.trim().slice(0, 300);
              pushEngineMessage( // registry-exempt(2026-07-16): RC-1 pending-question header reads per-iteration receipt state; migrate with the volatile-injection registry refactor
                messages,
                `[Your most recent message to ${counterparty.name}, sent ${relativeTimeAgo(pend.createdAt)}: "${quoted}"]`,
              );
            }
          }

          // OPEN LOOPS (RC-2): the CURRENT conversation's still-open loops (plus up
          // to 3 cross-conversation loops labeled by party), as a compact numbered
          // block. Structured, retirable rows replace the old immortal open-loop
          // prose in summaries; only status='open' rows are injected (stale loops go
          // to the daily brief, never per-turn). Same volatile lane as the outbound
          // facts above, so it never breaks the prompt-cache prefix.
          const loopsBlock = buildOpenLoopsInjection(agentId, chosenConvKey);
          if (loopsBlock) pushEngineMessage(messages, loopsBlock); // registry-exempt(2026-07-16): RC-2 open-loops block reads conv-scoped rows mid-iteration; migrate with the volatile-injection registry refactor
        } catch (err) {
          logger.debug('RC-12/RC-1 volatile outbound injection failed (non-fatal)', {
            agentId, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
      }

      injectRegistryMessage('msg.current-time', messages, mctx);

      // ── Context receipt (debug-gated, fire-and-forget) ──
      // Last touch point before the provider call: every injector and
      // post-assembly mutation has run, so this records exactly what the
      // model receives this iteration.
      writeContextReceipt({
        agentId,
        modelId,
        turnNumber,
        loopCount: state.loopCount,
        systemPrompt,
        messages,
        useTools,
        // Registry path only (undefined on legacy): which registered entry
        // produced each system part / message. Receipt drops them if a later
        // loop-side mutation makes the counts disagree.
        systemEntryIds: ctx.systemEntryIds,
        messageEntryIds: ctx.messageEntryIds,
      });

      // ── Call model with retry-and-fallback (matches v1 runtime.ts:1028-1116) ──
      // For auto-routed agents, try up to 3 different models in the tier.
      // For fixed-model agents, throw on first failure.
      // Fixed-model agents get ONE attempt normally, PLUS one same-model retry
      // when the stream idle watchdog aborted a hung provider call (model.ts,
      // 2026-07-10): the request died on the wire, not in the model, and a
      // fresh attempt typically succeeds in seconds (the 602s production hang's
      // silent retry completed in 3s).
      const maxAttempts = isAutoRouted ? 3 : 2;
      let result: Awaited<ReturnType<typeof callModel>> | undefined;
      let callSucceeded = false;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const abortController = new AbortController();
        activeAbortControllers.set(agentId, abortController);

        try {
          // RC-4.4: mark the model call in flight so the start-ack streaming-race grace
          // can defer firing while the reply is still streaming. Cleared in the finally.
          modelCallInFlight = true;
          result = await callModel({
            agentId,
            modelId,
            messages,
            systemPrompt,
            // C28 P-2: system-side volatile lane (empty after P-1). Trails the
            // cached stable system block so it can't invalidate the cached prefix.
            systemVolatile: ctx.systemVolatile,
            tools: useTools,
            routerTier: routerTier ?? undefined,
            // Real abort signal, when stopAgent fires controller.abort(), the
            // underlying SDK call (Anthropic/OpenAI/Ollama) actually cancels
            // the in-flight fetch and throws here. Without this signal, stop
            // would only halt the runtime loop AFTER the model call finished.
            abortSignal: abortController.signal,
            // TRUE streaming, broadcast each chunk as it arrives.
            onChunk: (chunk) => {
              if (abortController.signal.aborted) return;
              // Inter-agent turns must NOT stream to the user's chat. The turn's
              // persisted message is hidden from the dashboard (source='a2a', via
              // the origin classifier), but the live chat:chunk path bypasses that
              // filter, streaming the agent-to-agent prose live produced a "reply
              // to no one" bubble that then vanished on refresh (the refetch
              // correctly hides the A2A row). Suppress the live stream at the
              // source so inter-agent coordination never reaches the user's chat,
              // live OR on reload. The phone/TTS accumulation below is unaffected:
              // an inter-agent turn never has phoneStreamCallSid set.
              if (!isA2ATurn && counterparty.kind !== 'agent') {
                broadcast({
                  type: 'chat:chunk',
                  agentId,
                  messageId,
                  content: chunk,
                  done: false,
                });
              }
              // v2.9.23, phone-call streaming TTS. Accumulate chunks
              // into a buffer and flush each completed sentence to
              // CallSession.queueAgentSay as it appears. Effect: audio
              // starts playing on the first sentence, instead of
              // waiting for the full model response. Same idea as
              // voice mode's clause splitter but landing on the
              // Twilio CallSession's TTS queue instead of the voice
              // WS stream.
              if (phoneStreamCallSid) {
                phoneStreamBuffer += chunk;
                // Boundary: sentence-end punctuation followed by
                // whitespace. Sentence-level keeps the synth boundary
                // clean for both Kokoro and Hume.
                const flushParts: string[] = [];
                let last = 0;
                const re = /[.!?\n]+\s+/g;
                let m: RegExpExecArray | null;
                while ((m = re.exec(phoneStreamBuffer)) !== null) {
                  const end = m.index + m[0].length;
                  const part = phoneStreamBuffer.slice(last, end).trim();
                  if (part) flushParts.push(part);
                  last = end;
                }
                if (last > 0) phoneStreamBuffer = phoneStreamBuffer.slice(last);
                if (flushParts.length > 0) {
                  // B-2 (comms-audit): set the streamed flag SYNCHRONOUSLY the moment
                  // we decide to flush, BEFORE the detached async IIFE. The old code
                  // set it inside the IIFE after an awaited import, so the turn-end
                  // check could read it as false (microtask not yet run) and fall to
                  // the one-shot full-reply fallback → the caller heard the reply
                  // TWICE. Setting it here is safe even though the enqueue is deferred:
                  // queueAgentSay only no-ops when the session is gone or ENDED, and
                  // `ended` is a one-way latch, so if the session is still live at
                  // turn-end (the only path that reads this flag, after re-checking
                  // !session / isEnded()), it was live at IIFE time too and the parts
                  // WERE enqueued. There is no live-call-hears-silence window here.
                  phoneStreamFlushedAny = true;
                  // v2.10.1, queueAgentSay is now just an enqueue
                  // (the CallSession runs a single-flight drain
                  // worker), so synchronous push is fine and order
                  // is preserved by the worker. No IIFE / no
                  // parallel synths.
                  void (async () => {
                    try {
                      const { getCallSession } = await import('../../twilio/call-session.js');
                      const session = getCallSession(phoneStreamCallSid as string);
                      if (!session || session.isEnded()) return;
                      for (const part of flushParts) {
                        if (abortController.signal.aborted) return;
                        // Fire-and-forget: queueAgentSay enqueues
                        // and returns; the drain worker handles
                        // serial synthesis.
                        void session.queueAgentSay(part);
                      }
                    } catch { /* best effort; one-shot fallback runs at turn end */ }
                  })();
                }
              }
            },
            // Reasoning / thinking chunks (DeepSeek native, OpenRouter
            // unified). The dashboard renders these in a collapsible
            // "Thinking…" panel above the assistant bubble, separate
            // from the final-answer text stream.
            onReasoningChunk: (chunk) => {
              if (abortController.signal.aborted) return;
              broadcast({
                type: 'chat:reasoning_chunk',
                agentId,
                messageId,
                content: chunk,
                done: false,
              });
            },
          });
          activeAbortControllers.delete(agentId);
          callSucceeded = true;
          break;
        } catch (err) {
          activeAbortControllers.delete(agentId);

          if (stoppedAgents.has(agentId)) {
            stoppedAgents.delete(agentId);
            setAgentStatus(agentId, 'idle');
            return;
          }
          if (preemptedAgents.has(agentId)) {
            preemptedAgents.delete(agentId);
            logger.info('v2 run preempted, queued wakeup will fire', {}, agentId);
            setAgentStatus(agentId, 'idle');
            return;
          }

          // Fixed-model path: the ONLY error that earns the second attempt is
          // the stream-idle watchdog abort (same model, fresh connection).
          // Everything else rethrows immediately, exactly as before.
          if (!isAutoRouted) {
            const msg = err instanceof Error ? err.message : String(err);
            if (attempt < maxAttempts - 1 && msg.includes(STREAM_IDLE_TIMEOUT_ERROR)) {
              logger.warn('v2: model stream idle timeout; retrying the same model once on a fresh connection', {
                attempt, modelId,
              }, agentId);
              continue;
            }
            revertTriggerStampOnAbort(); // N-1: model call failed with no answer, re-arm the ask
            throw err;
          }
          // Auto-routed and exhausted attempts, rethrow.
          // (v1's catch path in handleMessage handles further recovery, 
          // Dreamer overflow, provider 4xx, healer notification, etc. Phase 6
          // moves all of that into agent/v2/recovery.ts.)
          if (attempt >= maxAttempts - 1) {
            revertTriggerStampOnAbort(); // N-1: model call failed with no answer, re-arm the ask
            throw err;
          }

          // Auto-routed: try the next model in the fallback chain.
          excludedModels.push(modelId);
          // Clear model lock so fallback can pick a different model.
          state = advance(state, { lockedModelId: null, lockedTier: null });
          const { selectModel } = await import('../../router/selector.js');
          const fallbackTier = routerTier ?? state.lockedTier ?? 'standard';
          const fallback = selectModel(fallbackTier, agentId, excludedModels, ['tools']);
          if (!fallback) {
            logger.error('v2 auto-router: no fallback models available', {
              failedModel: modelId, tier: fallbackTier, excludedModels, attempt,
            }, agentId);
            revertTriggerStampOnAbort(); // N-1: all fallbacks exhausted, no answer, re-arm the ask
            throw err;
          }
          logger.warn(`v2 auto-router: ${modelId} failed → falling back to ${fallback.modelId}`, {
            failedModel: modelId,
            fallbackModel: fallback.modelId,
            tier: routerTier,
            error: err instanceof Error ? err.message.slice(0, 100) : String(err),
          }, agentId);
          // Phone streaming: this failed model's stream is discarded, so
          // drop its un-flushed tail and clear the "already streamed"
          // latch before the fallback attempt runs. The buffer only ever
          // holds the CURRENT stream's unsent tail (the sent prefix is
          // stripped in onChunk), and that stream is gone. The latch
          // means "this turn's answer already streamed"; the fallback
          // attempt re-latches it if IT streams. Resetting the latch here
          // prefers a rare duplication (a partial already spoken plus the
          // full answer spoken one-shot when the fallback does NOT stream)
          // over ever leaving the caller without the final answer. Audio
          // already handed to queueAgentSay stays committed by design;
          // there is no dequeue and none should be added.
          if (phoneStreamCallSid) { phoneStreamBuffer = ''; phoneStreamFlushedAny = false; }
          modelId = fallback.modelId;
          state = advance(state, { modelId });
        } finally {
          // RC-4.4: the model call for this attempt has settled (success break, retry
          // continue, or throw); it is no longer in flight. A retry sets it true again.
          modelCallInFlight = false;
        }
      }

      if (!callSucceeded || !result) {
        // Defensive guard only, in practice unreachable: the retry loop above exits
        // either by `break` (callSucceeded=true) or by throwing on the final failed
        // attempt (the catch's give-up paths). The N-1 stamp-revert therefore lives at
        // those actual throw sites (revertTriggerStampOnAbort), NOT here, so a model-call
        // failure re-arms the human's ask on the path that genuinely runs.
        revertTriggerStampOnAbort();
        throw new AgentError('Model call failed after all attempts', agentId, { code: 'MODEL_CALL_FAILED' });
      }

      // ── Low-confidence shadow probe (gated, off by default) ──
      // After the real answer is in hand, optionally re-run this turn at the
      // next-lower tier in the background to learn whether we over-routed. Fully
      // best-effort and budget-capped; never delays or affects this response.
      // Only on the fresh-decision path, and only for text-only turns (skip when
      // the model kicked off tool calls, a no-tools shadow can't be compared).
      if (
        isAutoRouted && routerFreshDecision && routerTier &&
        result.toolCalls.length === 0 && result.content
      ) {
        const probeTier = routerTier;
        const probeConfidence = routerConfidence;
        const probeContent = result.content;
        // The authoritative user query, clean of engine injections.
        const probeMsgs = messages as Array<{ role: string; content: string | object[] }>;
        const probeQuery = lastUserMessageContent ?? '';
        void (async () => {
          try {
            const { maybeProbe } = await import('../../router/probe.js');
            maybeProbe({
              agentId,
              systemPrompt,
              messages: probeMsgs as Array<{ role: 'user' | 'assistant'; content: string | object[] }>,
              tier: probeTier as 'light' | 'standard' | 'heavy',
              confidence: probeConfidence,
              query: probeQuery,
              realAnswer: probeContent,
            });
          } catch { /* best effort */ }
        })();
      }

      // ── Lock model for tool loops ──
      // For auto-routed agents that just kicked off tool calls, pin the
      // chosen model for the remainder of this turn so tools+follow-up calls
      // use the same model.
      if (isAutoRouted && !state.lockedModelId && result.toolCalls.length > 0) {
        state = advance(state, { lockedModelId: modelId, lockedTier: routerTier });
        logger.info('v2 auto-router: locking model for tool loop', { modelId, tier: routerTier }, agentId);
      }

      // Cost recording happens inside callModel (model.ts records once per
      // provider path). The v2 loop must NOT call recordCost again, doing so
      // double-bills the cost tracker. Verified against logs 2026-05-04.
      //
      // Embedding queueing: callModel does NOT queue embeddings, that's the
      // runtime's job. v1 calls queueEmbedding for assistant text responses
      // (runtime.ts), so v2 does the same.
      // Skip embedding the no-reply sentinel, it's not real content and the
      // matching assistant message row never gets persisted.
      const isNoReplySentinel =
        !!result.content &&
        result.toolCalls.length === 0 &&
        /^\s*\[no-reply\]\s*$/i.test(result.content);
      if (result.content && result.content.trim().length > 0 && !isNoReplySentinel) {
        try {
          queueEmbedding('message', messageId, agentId, result.content);
        } catch { /* best effort */ }
      }

      // C27 hook 1: canonicalize aliased (renamed) tool-call names + args BEFORE
      // any gate/classifier reads them (they match on canonical names). Tombstoned
      // tools are left as-is; executeTool returns their pointer error at dispatch.
      for (const tc of result.toolCalls) {
        const aliasResolved = resolveToolAlias(tc.name, tc.arguments ?? {});
        if (!aliasResolved.tombstone && aliasResolved.name !== tc.name) {
          tc.name = aliasResolved.name;
          tc.arguments = aliasResolved.args;
        }
      }

      state = advance(state, { lastResponse: result, toolCalls: result.toolCalls });

      // Spin-brake grace (owner ruling 2026-07-19): once the tool phase has
      // been ended by the terminal brake, every further tool call returns an
      // instant note without executing; allow a small grace of model
      // iterations to converge to text, then conclude the turn. The model's
      // text is never suppressed, whatever it has said stands.
      if (toolPhaseEndedBySpinBrake && result.toolCalls.length > 0) {
        spinBrakeGraceCalls -= 1;
        if (spinBrakeGraceCalls < 0) {
          logger.warn('v2: spin brake grace exhausted, concluding the turn', { agentId, turnNumber }, agentId);
          state = advance(state, { phase: 'done' });
        }
      }

      // ── Phase: post-call classification ──
      state = advance(state, { phase: 'postCallClassify' });

      // Empty response handling, v1 has 3-phase retry. Phase 2 baseline:
      // single output-truncation check; if not truncated and no text/tools,
      // surface as toast and break.
      if (result.toolCalls.length === 0 && (!result.content || result.content.trim().length === 0)) {
        const trunc = outputTruncationClassifier({
          stopReason: result.stopReason,
          contentLength: 0,
          currentBudget: state.outputTokensEscalated,
        });
        if (trunc.truncated && trunc.escalateTo !== null) {
          // Output was truncated, escalate budget and retry.
          state = advance(state, { outputTokensEscalated: trunc.escalateTo });
          continue;
        }
        // Clean end-of-turn after tools, legitimate exit, no error.
        if (state.toolCallsExecutedThisTurn > 0) {
          // v1 line 1167-1171: agent did work and has nothing more to say.
          break;
        }
        // No tools called and no text, empty response. v1 runtime.ts:1166-1199
        // does a 3-phase fallback before giving up. Many empties are transient
        // (streaming hiccup, model hesitation) and resolve on a silent retry.
        // Phase 1: silent retry (no nudge, just re-run the model).
        if (!state.retriedEmptyResponse) {
          logger.warn('v2: model returned empty response, retrying silently', {
            loopCount: state.loopCount, stopReason: result.stopReason,
          }, agentId);
          state = advance(state, { retriedEmptyResponse: true });
          continue;
        }
        // Phase 2: explicit nudge, inject a [System: ...] note via pendingNudge
        // so the assemble phase wraps it as a synthetic user message next turn.
        if (!state.nudgedForEmptyResponse) {
          logger.warn('v2: model returned empty after silent retry, nudging', {
            loopCount: state.loopCount, stopReason: result.stopReason,
          }, agentId);
          state = advance(state, {
            nudgedForEmptyResponse: true,
            pendingNudge:
              "[System: You returned an empty response. Please respond to the user's last message or call a tool to continue your task. If you are finished, say so clearly.]",
          });
          continue;
        }
        // Phase 3: give up, toast the user, no DB changes.
        logger.warn('v2: model returned empty after nudge, breaking', {
          loopCount: state.loopCount, stopReason: result.stopReason,
        }, agentId);
        state = advance(state, { pendingNudge: null });
        broadcast({
          type: 'chat:error',
          agentId,
          error: 'Agent gave an empty reply. Send your message again to retry.',
          code: 'MODEL_FAILED',
          severity: 'warning',
          retryable: true,
        });
        // C4: this give-up break is the clean-retry case, reached only when NO tools
        // executed this turn (the empty-after-tools break above catches the tools case)
        // and the model produced empty text 3x. Re-arm the human ask so the drain re-serves
        // it (the toast still tells the user they can also resend). Guarded so it never
        // re-arms a turn that produced any answer/side effect.
        reArmIfStrandedNoAnswer();
        break;
      }

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
          break;
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
      if (interAgentTurn && currentTurnKind.get(agentId) !== 'a2a') {
        currentTurnKind.set(agentId, 'a2a');
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
      const persistenceDecision = outputPersistenceClassifier({
        responseText: result.content ?? null,
        toolCallsThisTurn: result.toolCalls,
        isInterAgentTrigger: interAgentTurn,
        sentToAgentThisTurn: state.sentToAgentThisTurn,
      });

      let persistedContent: string | null = result.content;
      // v2.5.7, strip system routing tags the LLM may have copied from
      // prior conversation history (e.g. "[SENT VIA IMESSAGE to the owner]")
      // before persisting OR routing to iMessage. This cleans both the
      // dashboard render path and the iMessage outbound path at the source,
      // and keeps the next turn's LLM context free of the hallucinated tags
      // (so we don't reinforce the pattern).
      if (persistedContent) {
        const { stripSystemTags } = await import('../../services/imessage-bridge.js');
        const cleaned = stripSystemTags(persistedContent);
        persistedContent = cleaned || null;
      }
      // Same class of copied-markup strip for the per-message time stamps
      // (2026-07-16): the floor model prefixes its own replies with the
      // bracket-time it sees on every historical message. Strip at the source
      // so persist, demotion capture, deferred delivery, and channel routing
      // all see clean text (see stripLeadingTimeStamp for the observed case).
      if (persistedContent) {
        const destamped = stripLeadingTimeStamp(persistedContent).trim();
        persistedContent = destamped.length > 0 ? destamped : null;
      }
      // On an inter-agent turn, suppress the text even when it accompanies tool
      // calls (intermediate planning text leaks otherwise). On normal turns keep
      // the long-standing "only suppress standalone trailing text" behavior.
      if (persistenceDecision.decision === 'suppress' && (result.toolCalls.length === 0 || interAgentTurn)) {
        logger.debug('v2: suppressed trailing text', {
          agentId,
          reason: persistenceDecision.reason,
          interAgentTurn,
        }, agentId);
        persistedContent = null;
      }
      // Channel-awareness (attribution redesign §5): assistant text that rides in
      // the SAME model response as one or more tool calls is the agent thinking-
      // before-acting, Lane-2 process narration ("Let me check the calendar",
      // "Close-out gate is released now, let me handle the other task", "Now I have a
      // clear picture, let me reply to the PM agent"), never a message to the user. The user
      // reply is ALWAYS the terminal message: a separate, tool-less response emitted
      // after the work completes (verified empirically, every legitimate reply is
      // tool-less; every preamble / machinery-narration / A2A-coordination leak rides
      // with a tool call). outputPersistenceClassifier already applies exactly this on
      // inter-agent turns; generalize it to ALL turns so preambles stop leaking into
      // the conversation on normal user turns too. Subsumes the prior
      // send_to_agent/broadcast-only suppression. Deterministic engine enforcement,
      // not prompt-hope (the weak-model correctness floor).
      if (persistedContent && result.toolCalls.length > 0) {
        // GOVERNING RULE (comms-audit G-SUP-2): on a turn a HUMAN is waiting on,
        // this text MIGHT be the genuine answer the weak model paired with a
        // closing tool (tracker_update_status, etc.), the v2.7.24 capture below
        // exists for exactly that, but this blanket null defeated it (two patches
        // in conflict). Don't show it as a mid-turn bubble (avoid preamble leak),
        // but REMEMBER it: if the turn ends with no proper tool-less reply, the
        // finalize block recovers it so the ask is never silently dropped. On an
        // inter-agent / background turn it is coordination narration, hard-
        // suppress with no recovery (keeps A2A chatter off human channels).
        if (hasUnansweredUser && !interAgentTurn) {
          deferredUserReplyWithTools = persistedContent;
        }
        // Demote, don't discard (owner request 2026-07-10). This narration
        // already STREAMED into the user's chat live; classifying it out of the
        // conversation made the bubble visibly vanish, which reads as the engine
        // killing the agent mid-thought. Persist it as a [working-note] system
        // row (role='system' never enters model context, so this cannot feed the
        // re-answer class) and tell the dashboard to convert the streamed bubble
        // in place into a dimmed note. Live view and reload agree. Inter-agent
        // turns keep the hard suppression: their narration never streamed to the
        // user (chat:chunk is suppressed on those turns), so there is nothing on
        // screen to demote.
        if (!interAgentTurn) {
          try {
            const noteId = uuidv4();
            // RC-9: channel-aware demotion. On a ROUTED-channel human turn (iMessage /
            // SMS / Teams / email) exactly ONE routing pass delivers exactly ONE string
            // to the channel, while the dashboard live-mirrors EVERY iteration. A demoted
            // narration line here was NOT delivered to that channel, so a visible working
            // note reads as a second, contradictory reply (F-22: the dashboard showing
            // "Not yet, sending now" that never reached iMessage). Mark such notes
            // INTERNAL: prefix them [working-note:internal] and flag the broadcast so the
            // dashboard hides them by default (shown only in wordy/verbose mode). Owner
            // dashboard/voice turns are unchanged (there is one lane, nothing to confuse).
            const routedHumanChannel =
              counterparty.kind === 'user' &&
              (counterparty.relation === 'owner' || counterparty.relation === 'known_contact') &&
              (counterparty.channel === 'imessage' || counterparty.channel === 'sms' ||
               counterparty.channel === 'teams' || counterparty.channel === 'email');
            const notePrefix = routedHumanChannel ? '[working-note:internal] ' : '[working-note] ';
            // Chat-native system note: prefix-marked, NO origin stamp, same
            // convention as routing markers and dividers. An origin_kind of
            // 'engine' here would make the row inter-agent-shaped, and those
            // belong in the store, not messages (the NO_INTERAGENT_LEAK
            // invariant caught exactly that on the first draft of this).
            db.prepare(`
              INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
              VALUES (?, ?, 'system', ?, ?, datetime('now'))
            `).run(noteId, agentId, `${notePrefix}${persistedContent}`, turnNumber);
            broadcast({
              type: 'chat:workingnote',
              agentId,
              messageId,
              noteId,
              content: persistedContent,
              ...(routedHumanChannel ? { internal: true } : {}),
            });
          } catch { /* cosmetic; never block the turn */ }
        }
        persistedContent = null;
      }

      // ── Grounding guard (OPEN-14) ── Catch a fabricated completion BEFORE it
      // is persisted: a terminal, user-facing reply that claims it already
      // delivered something to a NAMED THIRD PARTY ("Already done. Sent it to
      // <them>…") when NO send/message tool fired this turn. The third party never
      // got it; the user is being told something false. This is not suppression, we inject a
      // one-shot correction and re-enter so the agent ACTUALLY sends (or, if it
      // genuinely sent in an earlier turn, confirms and continues). One-shot, and
      // only on user-facing (non-inter-agent) terminal replies.
      if (
        persistedContent &&
        result.toolCalls.length === 0 &&
        !interAgentTurn &&
        !state.nudgedForUngroundedClaimThisTurn
      ) {
        const grounding = detectUngroundedDeliveryClaim({
          responseText: persistedContent,
          // C5: pass the CUMULATIVE tool activity across all iterations, not
          // state.toolCalls (which is overwritten each iteration with the current
          // response's calls → always [] on this tool-less terminal iteration, so a
          // real send made in an earlier iteration was invisible and the guard
          // false-fired into a DUPLICATE send). state.toolResults is the accumulated
          // record; only successful deliveries ground the claim (an errored send is
          // not a real delivery, so it should still be able to fire the correction).
          toolCallsThisTurn: state.toolResults
            .filter((r) => !r.isError)
            .map((r) => ({ name: r.name })),
          counterpartyName: counterparty.name,
        });
        // RC-12: consult the durable receipt ledger BEFORE firing. A real prior send
        // to the claimed recipient (this turn OR an earlier one, within 24h) GROUNDS
        // the claim, so the guard must not fire into a duplicate send. The within-turn
        // tool check above only sees THIS turn; the ledger closes the cross-turn hole
        // (the admitted false positive: it really sent in an earlier turn and is just
        // referencing it). Engine fact, survives conversation scoping.
        // P6b-2: keyed consult first (deliveries rows, canonical identity),
        // receipts-alias substring as the legacy prong while pre-121 history
        // ages out.
        const groundedByLedger =
          grounding.ungrounded &&
          (findRecentDeliveriesKeyed(agentId, grounding.recipient, 24).length > 0 ||
           findRecentDeliveries(agentId, grounding.recipient, 24).length > 0);
        if (grounding.ungrounded && groundedByLedger) {
          logger.info('v2 grounding guard suppressed by receipt ledger (real prior send)', {
            agentId, recipient: grounding.recipient,
          }, agentId);
        }
        if (grounding.ungrounded && !groundedByLedger) {
          const nudgeText =
            `[System: your reply says you already delivered something to ${grounding.recipient} ("${grounding.verbHint}…"), ` +
            `but no send/message tool was called this turn, so that delivery did NOT happen here. ` +
            `If you ALREADY sent it to ${grounding.recipient} in an earlier turn, just confirm and continue. ` +
            `If you have NOT actually sent it, do it NOW with the correct tool (send_to_agent for another agent, ` +
            `imessage_send / the email-send tool for a person) BEFORE telling the user it is done. ` +
            `Never tell the user something is sent or handled that you have not actually done.]`;
          // RC-19: deliver the correction via persistEngineSteer so it reaches the
          // model (pendingNudge) AND keeps the dashboard row. A bare role='system'
          // row is stripped by the assembler, so pre-fix the agent re-entered without
          // ever seeing the correction and re-posted the same false claim.
          state = persistEngineSteer(
            state,
            { agentId, content: nudgeText, turnNumber, extra: { nudgedForUngroundedClaimThisTurn: true } },
            { db, broadcast },
          );
          logger.info('v2 grounding guard fired, ungrounded delivery claim, re-entering', {
            agentId, recipient: grounding.recipient,
          }, agentId);
          continue; // re-enter so the agent actually sends or corrects the claim
        }
      }

      // ── RC-12 DENIAL direction ── The inverse of the positive guard: the terminal
      // reply DENIES a delivery ("Not yet", "sending now", "haven't sent it") that the
      // engine receipt ledger proves already happened (F-5, F-22). The denial text
      // detection is deliberately generous; the durable receipt is the true gate, so a
      // steer only fires when a real send is on record. Steer with the receipt fact and
      // re-enter once so the agent answers truthfully AND does not re-send.
      if (
        persistedContent &&
        result.toolCalls.length === 0 &&
        !interAgentTurn &&
        !state.nudgedForDeliveryDenialThisTurn
      ) {
        const denial = detectDeliveryDenial({ responseText: persistedContent });
        if (denial.denied) {
          // Named recipient → 24h window (a specific past send); bare "not yet" → a
          // short 1h window so an unrelated older send cannot spuriously ground it.
          // P6b-2: keyed consult first, legacy alias prong second.
          const keyedMatches = denial.recipient
            ? findRecentDeliveriesKeyed(agentId, denial.recipient, 24)
            : findRecentDeliveriesKeyed(agentId, null, 1);
          const matches = keyedMatches.length > 0
            ? keyedMatches
            : denial.recipient
              ? findRecentDeliveries(agentId, denial.recipient, 24)
              : findRecentDeliveries(agentId, null, 1);
          const receipt = matches[0];
          if (receipt) {
            const who = receipt.recipient ?? denial.recipient ?? 'them';
            const nudgeText =
              `[Engine receipt: you DID send ${channelLabel(receipt.channel)} to ${who} ${relativeTimeAgo(receipt.createdAt)}. ` +
              `Answer truthfully; do not re-send.]`;
            state = persistEngineSteer(
              state,
              { agentId, content: nudgeText, turnNumber, extra: { nudgedForDeliveryDenialThisTurn: true } },
              { db, broadcast },
            );
            logger.info('v2 delivery-denial guard fired, receipt contradicts denial, re-entering', {
              agentId, recipient: who, channel: receipt.channel,
            }, agentId);
            continue; // re-enter so the agent corrects the denial instead of re-sending
          }
        }
      }

      // ── RC-13.2 failed-save-claim floor ── The reply claims something was saved /
      // stored / remembered, but every vault_remember THIS turn was REJECTED (isError,
      // the RC-13 bounce fix) and nothing was stored. On the floor model, F-6's false
      // "Saved." was the INSTRUCTED behavior (the bookkeeping nudge stapled "reply
      // 'Saved.'" onto a rejection). Steer truthfully once so a rejected save can never
      // masquerade as done.
      if (
        persistedContent &&
        result.toolCalls.length === 0 &&
        !interAgentTurn &&
        !state.nudgedForFailedSaveClaimThisTurn &&
        /\b(saved|stored|remembered|noted it|added (it|that) to (memory|the vault)|put it in (memory|the vault))\b/i.test(persistedContent)
      ) {
        const vaultRemembers = state.toolResults.filter((r) => r.name === 'vault_remember');
        const rejected = vaultRemembers.filter((r) => r.isError).length;
        const succeeded = vaultRemembers.filter((r) => !r.isError).length;
        if (succeeded === 0 && rejected >= 1) {
          const nudgeText =
            `You told the user you saved that, but all ${rejected} vault_remember call${rejected === 1 ? '' : 's'} this turn ` +
            `${rejected === 1 ? 'was' : 'were'} REJECTED and nothing was stored. Either retry with the correction the tool ` +
            `gave you, or tell the counterpart truthfully that it is not saved yet. Do not claim it was saved.`;
          state = persistEngineSteer(
            state,
            { agentId, content: nudgeText, turnNumber, extra: { nudgedForFailedSaveClaimThisTurn: true } },
            { db, broadcast },
          );
          logger.info('v2 RC-13.2 save-claim floor fired, all vault saves rejected this turn, re-entering', {
            agentId, rejected,
          }, agentId);
          continue; // re-enter so the agent retries the save or tells the truth
        }
      }

      // ── Deliverable-claim floor: REMOVED same day it landed (2026-07-19) ──
      // The first full battery with it live proved the design law it violated:
      // prose classification must never gain authority. The floor steered a
      // TRUTHFUL completion (a checklist task whose work WAS its technique_read
      // calls, reads are not in any artifact-receipt list) and the floor model
      // answered the steer by spiraling re-reads until turns blew their windows
      // (run bmrrg3lk3db: use-technique loop, simple-reply timeout). Claims
      // honesty is enforced where it can be DETERMINISTIC instead: delivery
      // outcomes are handed to the model at the source (image completion, fan-
      // out steer payloads, attachment give-up notes), and the behavioral
      // harness keeps the SURFACE-ONLY claims:completion_without_receipts
      // invariant, which observes and reports but never acts on prose.

      // Cross-turn respond-once (attribution redesign §4.5). The within-turn dedup
      // above only compares against the single most-recent assistant message and is
      // exempt on tool-bearing turns, so it misses the real leak: the agent
      // RE-ENGAGES the same conversation a few turns later and re-posts a
      // near-identical reply ("Dry cleaning set for 6pm, dentist not found" twice).
      // Close the loop by comparing against the last few persisted assistant replies
      // (suppressed turns were never persisted, so the DB holds only shown text).
      //
      // GOVERNING RULE (comms-audit G-SUP-1): suppression NEVER applies on a turn a
      // human is waiting on. If a user asked (hasUnansweredUser), including asking
      // the SAME thing again, where the correct answer is necessarily near-identical
      // ("what's on my calendar?" twice), the reply is a genuine answer and must be
      // delivered, never eaten as a "duplicate." Cross-turn dedup is ONLY for the
      // agent spontaneously RE-POSTING with no new user ask driving the turn.
      // 2026-07-03: a DELIBERATE ENGINE SURFACE (scheduler/reminder/completion
      // report) is likewise a new external event driving the turn, and its text is
      // repeated near-identical BY DESIGN, so it is exempt too (run bmr5637ptnc:
      // this guard ate a reminder delivery twice and the turn ended silent).
      if (persistedContent && persistedContent.trim().length > 0 && !triggerRow && !deliberateSurfaceTurn) {
        try {
          const recentReplies = db
            .prepare(
              "SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' AND content NOT LIKE '[{%' ORDER BY rowid DESC LIMIT 5",
            )
            .all(agentId) as Array<{ content: string }>;
          if (recentReplies.some(r => isNearDuplicateText(r.content, persistedContent!))) {
            logger.info('v2: suppressed cross-turn near-duplicate reply (respond-once)', {
              turnNumber,
            }, agentId);
            persistedContent = null;
          }
        } catch {
          // best-effort; never block a reply on a dedup read failure
        }
      }

      // ── Duplicate-final-answer prevention (v2.7.2, scoped down v2.7.3) ──
      //
      // The v2.7.2 fix exited the loop whenever the agent paired wrap-up
      // text with ANY task-closing tool call (tracker_close_project,
      // tracker_complete_step, tracker_update_status with terminal
      // status, complete_task). The intent was good (skip the duplicate
      // "All set." follow-up turn) but the trigger was way too broad:
      //
      //   • Multi-step user asks where step 1 is a close-out got cut
      //     off after step 1 and never reached step 2.
      //   • Agents naturally mark intermediate task transitions with
      //     "Step done, moving on to X", that paired text+close-out
      //     killed the loop mid-flow.
      //   • The v2.7.3 DB-based "any remaining queued work?" check
      //     helped for tracker-tracked workflows but still cut off
      //     conversational multi-step asks where the next step lives
      //     only in the user's prompt, not in the tracker.
      //
      // Narrowed in v2.7.3 to fire ONLY for `complete_task`, the
      // sub-agent self-termination tool. Its semantics are unambiguous:
      // "I am a sub-agent, my work is over, terminate me and report
      // back to parent." Letting the loop run one more iteration after
      // complete_task would only produce a wasted "all done" follow-up
      // before the agent gets terminated anyway.
      //
      // Every tracker close-out path is now allowed to flow into the
      // next loop iteration. The worst case is one extra model call
      // that emits a brief duplicate "all set" line, minor polish
      // issue. The previous trigger broke real multi-step work, which
      // is a far worse failure mode.
      const isSubAgentExit = (tc: { name: string }): boolean => tc.name === 'complete_task';
      const hasSubAgentExit = result.toolCalls.some(isSubAgentExit);
      const hasWrapUpText = !!(result.content && result.content.trim().length >= 10);

      if (
        !state.taskClosedWithTextThisTurn &&
        hasSubAgentExit &&
        hasWrapUpText
      ) {
        state = advance(state, {
          taskClosedWithTextThisTurn: true,
          // Force loop exit AFTER this iteration's tool execution. The
          // complete_task tool still runs (it's already in result.toolCalls
          // and processed below this block). The next while-loop check
          // sees phase==='done' and exits without calling the model again.
          phase: 'done',
        });
        logger.info('v2: sub-agent complete_task + wrap-up text, phase set to done, no second model call', {
          agentId,
        }, agentId);
      }

      // No-reply sentinel: the agent emits `[no-reply]` (case-insensitive,
      // possibly with surrounding whitespace) when the incoming message
      // closes the conversation (goodnight, that's all, etc.) and there's
      // nothing actionable to respond to. We swallow the literal sentinel
      // (so it doesn't get echoed via iMessage or rendered in chat) and
      // persist a system marker instead, so the agent's next turn sees
      // that the prior turn ended silently. Skipping persistedContent here
      // means lastAssistantTextForIM stays unset, which suppresses the
      // iMessage routing at end-of-turn. Critical for preventing endless
      // back-and-forth chatter on iMessage.
      //
      // Two forms: (a) the entire message IS the sentinel, swallow the
      // bubble entirely, persist a [conversation closed] system marker.
      // (b) the message ENDS with the sentinel (optionally wrapped in
      // backticks/asterisks), strip just the sentinel so the user sees
      // the actual reply text. This handles the common model mistake of
      // appending the sentinel after a real reply (2026-06-02 bug fix:
      // the primary agent was tail-appending `[no-reply]` to user-facing
      // messages and the literal text was rendering in chat).
      const NO_REPLY_TAIL_RE = /\s*[`*_]*\s*\[no-reply\]\s*[`*_]*\s*$/i;
      if (
        persistedContent &&
        result.toolCalls.length === 0 &&
        NO_REPLY_TAIL_RE.test(persistedContent) &&
        !/^\s*[`*_]*\s*\[no-reply\]\s*[`*_]*\s*$/i.test(persistedContent)
      ) {
        const cleaned = persistedContent.replace(NO_REPLY_TAIL_RE, '').trimEnd();
        if (cleaned.length > 0) {
          logger.info('v2: stripped trailing [no-reply] sentinel from user-facing message', {
            agentId, originalLength: persistedContent.length, cleanedLength: cleaned.length,
          }, agentId);
          persistedContent = cleaned;
        }
      }
      const isBareNoReply =
        persistedContent !== null &&
        result.toolCalls.length === 0 &&
        /^\s*[`*_]*\s*\[no-reply\]\s*[`*_]*\s*$/i.test(persistedContent);

      // Decline-as-prose: the weak model sometimes states "I'm not going to reply to
      // this" in prose ("No reply needed here, I can't address X…") instead of the
      // [no-reply] sentinel. Treated as a normal reply, that deliberation gets ROUTED
      // to the counterparty, it was literally sent to Ben as the Globex renewal email
      // reply (thread "Renewal") AND shown in the owner's chat. Honor the agent's
      // stated intent: a message that OPENS with an unambiguous self-decline is a
      // no-reply, not a message to anyone, suppress + don't route, same as the
      // sentinel. Conservative: leading phrase only, no tool calls, so it never
      // swallows a substantive reply that merely mentions "no reply" mid-sentence.
      const DECLINE_OPENER_RE = /^\s*[`*_>]*\s*(?:no\s+(?:reply|response)\s+(?:needed|necessary|required|warranted)\b|no\s+need\s+to\s+(?:reply|respond)\b|nothing\s+(?:to\s+)?(?:reply|respond|to\s+say)\b|i(?:'|’)?ll\s+hold\s+off\s+(?:on\s+)?repl|i\s+(?:won(?:'|’)?t|will\s+not|am\s+not\s+going\s+to)\s+(?:reply|respond)\b)/i;
      const isDeclineNonReply =
        persistedContent !== null &&
        result.toolCalls.length === 0 &&
        !isBareNoReply &&
        // N-2 (comms-audit): NEVER treat a prose "decline" as no-reply on a turn a
        // human is WAITING on. The DECLINE_OPENER_RE false-positives on a genuine
        // answer that merely opens with such a phrase ("No response needed on the
        // receipt, your June total is $432."), which was nulled and dropped on every
        // channel. The governing rule: suppression never fires when serving a waiting
        // ask. A bare [no-reply] (the agent's explicit, whole-message choice) is still
        // honored for chatter-prevention; only the FUZZY prose-decline is guarded.
        !triggerRow &&
        DECLINE_OPENER_RE.test(persistedContent);

      // REG-3 refinement (2026-07-16, the trivial-save sequence): intentional
      // silence stands on turns nobody is waiting on (the narration-resurrection
      // case REG-3 protects). But a bare [no-reply] on a turn SERVING A HUMAN
      // TRIGGER, with NO surfaced reply and a captured text-with-tools answer,
      // means "I already answered" while the answer only exists as a demoted
      // note. Contract #1 (every authorized human message gets exactly one
      // substantive answer) outranks the sentinel: promote the model's own
      // captured words as the terminal reply. isDeclineNonReply already
      // requires !triggerRow (N-2), so only the bare sentinel can reach here.
      let noReplyOverridden = false;
      if (
        isBareNoReply &&
        triggerRow &&
        !state.surfacedReplyThisTurn &&
        !deferredDeliveredByAck &&
        deferredUserReplyWithTools &&
        deferredUserReplyWithTools.trim().length > 0
      ) {
        persistedContent = deferredUserReplyWithTools.trim();
        deferredUserReplyWithTools = null;
        noReplyOverridden = true;
        logger.info('v2: [no-reply] on a served human turn with an undelivered captured answer; promoting it as the reply', {
          agentId, turnNumber, preview: persistedContent.slice(0, 60),
        }, agentId);
      }
      if (!noReplyOverridden && (isBareNoReply || isDeclineNonReply) && (latestUserSource === 'voice' || state.inboundChannel === 'phone')) {
        // Voice AND phone are LIVE conversations, so going silent reads as a dropped
        // call. (comms-audit B-1/phone: phone utterances persist with NO `source`, so
        // they read as 'text' and were EXCLUDED from this guard, a bare [no-reply] on
        // a live call left the caller in dead air. Phone is distinguished by
        // inboundChannel==='phone'.) The voice-conduct prompt block tells the agent not
        // to use [no-reply] here, but the weakest model (the correctness floor) still
        // emits it sometimes, so the engine enforces the floor: swap the bare sentinel
        // for a short spoken acknowledgment and let it flow through the normal persist +
        // TTS path instead of swallowing into dead air.
        const voiceAcks = [
          'Okay, just say the word.',
          "Sounds good, I'm here when you need me.",
          "Got it. Holler when you're ready.",
        ];
        persistedContent = voiceAcks[Math.floor(Math.random() * voiceAcks.length)];
        logger.info('v2: [no-reply] on a voice turn, substituted a brief spoken acknowledgment to avoid dead air', {
          agentId, loopCount: state.loopCount,
        }, agentId);
      } else if (!noReplyOverridden && (isBareNoReply || isDeclineNonReply)) {
        if (isDeclineNonReply) {
          logger.info('v2: agent declined in prose ("no reply needed…"), honoring intent as no-reply (not routing it)', {
            agentId, turnNumber, preview: (persistedContent ?? '').slice(0, 60),
          }, agentId);
        }
        persistedContent = null;
        // REG-3 (comms-audit): the agent INTENTIONALLY went silent ([no-reply] /
        // prose decline). Discard any deferred text-with-tools narration so the
        // G-SUP-2 finalize recovery can't resurrect it and override the decision.
        deferredUserReplyWithTools = null;

        // Silent turn that still opened a canvas (or queued attachments via
        // show_to_user): surface the pending "Open in canvas" chip / thumbnails
        // onto this otherwise-empty assistant bubble instead of dropping it. The
        // user asked the agent to open a canvas; even on [no-reply] they need the
        // affordance back to it (an explicit canvas_render + [no-reply] otherwise
        // left NO chip). Draining here also pre-empts the end-of-turn safety net,
        // so the chip is surfaced exactly once.
        let surfacedNoReplyAttachments = false;
        try {
          const { drainPendingAttachments } = await import('../pending-attachments.js');
          const noReplyAttachments = drainPendingAttachments(agentId);
          if (noReplyAttachments.length > 0) {
            // A short factual line so the bubble renders cleanly (and tells the
            // user WHAT opened); the "Open in canvas" chip rides on it.
            const canvasDoc = noReplyAttachments.find((a) => a.openInCanvas);
            const noReplyCaption = canvasDoc
              ? `Opened ${canvasDoc.filename ? `"${canvasDoc.filename.replace(/\.[a-z0-9]+$/i, '')}"` : 'a document'} in the canvas.`
              : 'Here you go.';
            db.prepare(`
              INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, turn_number, created_at)
              VALUES (?, ?, 'assistant', ?, ?, ?, datetime('now'))
            `).run(messageId, agentId, noReplyCaption, JSON.stringify(noReplyAttachments), turnNumber);
            broadcast({ type: 'chat:chunk', agentId, messageId, content: '', done: true });
            broadcast({
              type: 'chat:message',
              agentId,
              message: {
                id: messageId, agentId, role: 'assistant' as const,
                content: noReplyCaption,
                tokenCount: null, modelId: null, cost: null, latencyMs: null,
                createdAt: new Date().toISOString(),
                attachments: noReplyAttachments,
              },
            });
            surfacedNoReplyAttachments = true;

            // N-3 (comms-audit): same gap as A-1, on the [no-reply] path. The drain
            // above surfaces the files onto the DASHBOARD bubble only. If the requester
            // is on iMessage, the deliverable they asked for never reaches their channel
            // (the end-of-turn channel router is skipped on a no-reply turn, and the
            // stranded safety net can't re-find these, they're already drained). Deliver
            // to the iMessage counterparty here. iMessage user only (a dashboard turn
            // already rendered them in the bubble).
            if (counterparty.kind === 'user' && counterparty.channel === 'imessage' && counterparty.senderId) {
              try {
                const { sendIMessageWithAttachment } = await import('../../services/imessage-bridge.js');
                for (const att of noReplyAttachments as Array<{ path?: string }>) {
                  if (att.path) sendIMessageWithAttachment(counterparty.senderId, att.path, '');
                }
              } catch (err) {
                logger.warn('N-3: no-reply attachment iMessage delivery failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
              }
            }
          }
        } catch (err) {
          logger.warn('v2: failed to surface no-reply canvas chip', {
            agentId, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }

        if (!surfacedNoReplyAttachments) {
          // Clear the streaming bubble in the dashboard. We need BOTH events:
          //  - chat:chunk done:true ends the bubble's streaming state (without
          //    this the thinking dots stay forever, since the normal done:true
          //    at line ~923 only fires when persistedContent or tools exist).
          //  - chat:message with empty content tells the dashboard to drop the
          //    bubble entirely so the chat doesn't show an empty assistant row.
          broadcast({
            type: 'chat:chunk',
            agentId,
            messageId,
            content: '',
            done: true,
          });
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: messageId, agentId, role: 'assistant' as const,
              content: '',
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
          const sysId = uuidv4();
          const sysContent = '[Agent ended turn without replying, conversation closed]';
          try {
            db.prepare(`
              INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
              VALUES (?, ?, 'system', ?, ?, datetime('now'))
            `).run(sysId, agentId, sysContent, turnNumber);
            broadcast({
              type: 'chat:message',
              agentId,
              message: {
                id: sysId, agentId, role: 'system' as const,
                content: sysContent,
                tokenCount: null, modelId: null, cost: null, latencyMs: null,
                createdAt: new Date().toISOString(),
              },
            });
          } catch (err) {
            logger.warn('v2: failed to persist no-reply marker', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        }
        // Turn continuity: declining ([no-reply]) IS addressing the counterparty.
        // Tag this turn's own messages with the conversation, that conv_key is
        // the durable "served" signal (the conversation won't be re-picked) AND
        // the content-isolation tag (its work won't bleed into another turn).
        if (chosenConvKey) {
          try { db.prepare(`UPDATE messages SET conv_key = ? WHERE agent_id = ? AND turn_number = ? AND role IN ('assistant','tool') AND conv_key IS NULL`).run(chosenConvKey, agentId, turnNumber); } catch { /* best effort */ }
        }
        logger.info('v2: agent ended turn silently via [no-reply] sentinel', {
          agentId, loopCount: state.loopCount,
        }, agentId);
      }

      // ── Redundant-closeout floor (engine-enforced "respond once") ──
      // If a user-facing reply already surfaced earlier THIS turn and this
      // continuation iteration is nothing but a generic closeout ("Done.",
      // "All set.", "Got it.") with no tool calls, swallow it the same way a
      // bare [no-reply] is swallowed, clear the already-streamed bubble so it
      // doesn't linger. This is the deterministic backstop for the model
      // forgetting to [no-reply] a redundant closeout. It can ONLY ever drop a
      // duplicate: the first reply is never touched (surfacedReplyThisTurn is
      // false until one lands), and substantive text never matches
      // isGenericCloseout. No system marker, the agent already replied.
      if (
        persistedContent &&
        result.toolCalls.length === 0 &&
        (state.surfacedReplyThisTurn || deferredDeliveredByAck) &&
        isGenericCloseout(persistedContent)
      ) {
        persistedContent = null;
        broadcast({ type: 'chat:chunk', agentId, messageId, content: '', done: true });
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: messageId, agentId, role: 'assistant' as const,
            content: '',
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
        logger.info('v2: suppressed redundant closeout (a reply already surfaced this turn)', {
          agentId, loopCount: state.loopCount,
        }, agentId);
      }

      // P4b (owner status-truth family): the owed-interrupt near-duplicate
      // swallow that lived here was DELETED. It nulled the granted round's
      // reply on a wording-similarity verdict, prose-as-authority in the
      // suppression direction, and its known worst case silently ate a
      // genuinely different short answer. The round's contract is now audited
      // by identity instead: the owed rows carry served_by_turn +
      // answer_message_id stamps (migration 113), and the worst case of the
      // swallow's absence is a visible duplicate paragraph, never a silent
      // drop. The re-prompt itself (below) is unchanged.

      // ── RC-5.3: proactive-send budget (backoff on unanswered background chatter) ──
      // A settled-context wake (no human waiting, not a deliberate surface) that produces
      // a terminal user-facing reply is an UNPROMPTED ping. Production fired ~10 of these
      // at a silent owner in 24h with no backoff (F-10). Track consecutive such pings in a
      // persistent per-agent streak (reset on any authorized owner inbound); once the
      // agent has already sent PROACTIVE_SEND_DEMOTE_THRESHOLD in a row, DEMOTE the next
      // one to a quiet dashboard working-note row instead of sending, still visible, no
      // ping. Deliberate surfaces (scheduler digests, reminders, completion reports) are
      // exempt (deliberateSurfaceTurn) and never counted. This is lane-attribution, not
      // suppression: the commentary lands in the notices lane, just not as a ping.
      if (
        settledContextWakeTurn &&
        !deliberateSurfaceTurn &&
        !interAgentTurn &&
        result.toolCalls.length === 0 &&
        persistedContent && persistedContent.trim().length > 0
      ) {
        const streak = getProactiveSendStreak(agentId);
        if (streak >= PROACTIVE_SEND_DEMOTE_THRESHOLD) {
          logger.info('v2 RC-5.3: proactive-send budget reached; demoting unsolicited settled-wake outbound to a quiet notices-lane row instead of sending', {
            agentId, turnNumber, streak, threshold: PROACTIVE_SEND_DEMOTE_THRESHOLD,
            preview: persistedContent.slice(0, 80),
          }, agentId);
          try {
            const noteId = uuidv4();
            db.prepare(`
              INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
              VALUES (?, ?, 'system', ?, ?, datetime('now'))
            `).run(noteId, agentId, `[working-note] ${persistedContent}`, turnNumber);
            // Convert the already-streamed dashboard bubble in place into the dimmed note
            // (same demote mechanism as the RC-9 text-with-tools path).
            broadcast({ type: 'chat:workingnote', agentId, messageId, noteId, content: persistedContent });
          } catch { /* cosmetic; never block the turn */ }
          persistedContent = null;
        } else {
          // Allowed proactive delivery: count it toward the streak. It flows through to
          // the persist + routing below and pings as normal.
          bumpProactiveSendStreak(agentId);
        }
      }

      // Arm the floor: once any user-facing reply surfaces this turn, later
      // generic closeouts get suppressed (above). Set AFTER the suppression
      // checks so a just-swallowed closeout (now null) doesn't arm it.
      if (persistedContent && persistedContent.trim().length > 0 && !state.surfacedReplyThisTurn) {
        state = advance(state, { surfacedReplyThisTurn: true });
      }


      // ── XML-fallback detection (matches v1 runtime.ts:1240) ──
      // Weak/local models that don't support structured tool calling emit
      // tool calls via the XML text-fallback parser. Their tool IDs are
      // synthetic (`text_tool_*`). Persisting them as structured tool_use
      // blocks would corrupt the next turn, the provider can't reference
      // IDs it didn't generate. Instead we persist text-only, then broadcast
      // a collapsed view with calls + results inline so the user sees them.
      const hasXmlFallbackTools = result.toolCalls.some((tc) =>
        tc.id.startsWith('text_tool_'),
      );

      // Drain attachments queued by show_to_user during prior tool calls
      // in this turn. The runtime owns assistant-message persistence, so
      // we attach here rather than letting the tool insert a synthetic
      // message (which would break tool_use/tool_result alternation).
      //
      // v2.9.20: ONLY drain on text-bearing iterations. Tool-only
      // iterations (no text + tool_use blocks) render as compact tool
      // pills in non-wordy mode and have no slot to display
      // attachments - draining onto them silently swallowed the files.
      // The 2026-06-06 JJ-report incident lost the deliverable this
      // way: show_to_user → tracker_complete_step → end. Attachments
      // drained onto the tracker_complete_step pill and vanished. Now
      // the queue persists across tool iterations and only drains
      // when text accompanies the persist - and an end-of-turn safety
      // net catches anything still queued so files can't be lost.
      const { drainPendingAttachments } = await import('../pending-attachments.js');
      const hasTerminalTextThisIter = !!(persistedContent && persistedContent.trim().length > 0);
      const queuedAttachments = hasTerminalTextThisIter ? drainPendingAttachments(agentId) : [];
      const queuedAttachmentsJson =
        queuedAttachments.length > 0 ? JSON.stringify(queuedAttachments) : null;

      // Build content for persistence (text + tool_use blocks if any)
      const effectiveModelIdForPersist =
        state.modelId === '__auto__' ? configuredModelId : state.modelId;

      if (result.toolCalls.length > 0 && !hasXmlFallbackTools) {
        // v2.9.16: voice-mode filler. When a voice-triggered turn is
        // about to run tools AND the model produced no pre-tool text
        // of its own ("let me check that"), push a short random
        // acknowledgment into the active TTS burst so the user doesn't
        // sit in silence while tools execute. Once per turn, works
        // with both local (Kokoro) and cloud (Hume) TTS engines via
        // the engine-agnostic push handle on the voice session.
        if (
          !voiceFillerFired &&
          latestUserSource === 'voice' &&
          (persistedContent ?? '').trim().length === 0
        ) {
          try {
            const { pickFillerPhrase } = await import('../../voice/filler-phrases.js');
            const { pushVoiceFiller } = await import('../../voice/voice-ws.js');
            const phrase = pickFillerPhrase();
            const pushed = pushVoiceFiller(agentId, phrase);
            if (pushed) {
              voiceFillerFired = true;
              logger.info('Voice filler pushed before tool execution', {
                agentId, phrase, toolCount: result.toolCalls.length,
              }, agentId);
            }
          } catch (err) {
            logger.warn('Voice filler push failed (non-fatal)', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        }

        // v2.9.23, same filler logic for live phone calls. Tool calls
        // are the only path that produces noticeable latency on phone
        // (a plain text reply now streams sentence-by-sentence via the
        // onChunk pipe above). When the model jumps straight to tools
        // with no opener text, push a short filler to the CallSession
        // so the caller hears something instead of dead air. Caller
        // hears "On it" / "One sec" / "Let me check" within ~150 ms
        // of finishing their utterance.
        if (
          !voiceFillerFired &&
          phoneStreamCallSid &&
          inboundChannel === 'phone' &&
          (persistedContent ?? '').trim().length === 0
        ) {
          try {
            const { pickFillerPhrase } = await import('../../voice/filler-phrases.js');
            const { getCallSession } = await import('../../twilio/call-session.js');
            const phrase = pickFillerPhrase();
            const session = getCallSession(phoneStreamCallSid);
            if (session && !session.isEnded()) {
              await session.queueAgentSay(phrase);
              voiceFillerFired = true;
              logger.info('Phone filler pushed before tool execution', {
                agentId, callSid: phoneStreamCallSid, phrase, toolCount: result.toolCalls.length,
              }, agentId);
            }
          } catch (err) {
            logger.warn('Phone filler push failed (non-fatal)', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        }
        const assistantContent: Anthropic.ContentBlockParam[] = [];
        if (persistedContent) {
          assistantContent.push({ type: 'text', text: persistedContent });
        }
        for (const tc of result.toolCalls) {
          assistantContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        // NEXT-WAVE item 5 (rule 6): scrub credential values this agent pulled via
        // credential_get out of the PERSISTED + BROADCAST copy of its tool calls
        // (the classic leak is `sshpass -p '<pw>'` landing inline in the exec
        // tool_use). result.toolCalls is untouched, so the live command still runs
        // with the real value; only the stored/shown copy is redacted. No-op (same
        // reference) when the agent has pulled no credentials this process.
        let assistantContentForStore = assistantContent;
        if (hasHandedCredentialValues(agentId)) {
          const scrubValue = (v: unknown): unknown => {
            if (typeof v === 'string') return redactHandedCredentials(agentId, v);
            if (Array.isArray(v)) return v.map(scrubValue);
            if (v && typeof v === 'object') {
              const o: Record<string, unknown> = {};
              for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = scrubValue(val);
              return o;
            }
            return v;
          };
          assistantContentForStore = assistantContent.map((block) => {
            if (block.type === 'tool_use') return { ...block, input: scrubValue((block as { input: unknown }).input) };
            if (block.type === 'text') return { ...block, text: redactHandedCredentials(agentId, (block as { text: string }).text) };
            return block;
          });
        }
        const assistantContentJson = JSON.stringify(assistantContentForStore);
        if (interAgentTurn) {
          // D-A step 8: the agent's OWN inter-agent-turn output goes to the physical
          // inter-agent store, never the `messages` chat table. Persisting it here
          // (stamped source='a2a') is what let a coordination burst bury the owner's
          // conversation 10k rows deep and blank the chat, and the 'a2a' stamp was a
          // leak-prone downstream overlay. The merged tail loaders UNION this row back
          // into the model context byte-identically (role/content/order/attachments/
          // turn_number preserved; the display/accounting columns NULL-pad exactly as
          // for peer-A2A rows), so model continuity holds. Regular-mode chat (messages-
          // only) never sees it; wordy mode serves it from the merged set. The row id
          // stays STABLE (other tables reference message ids) and content byte-identical.
          insertInterAgentOwnOutput({
            id: messageId,
            agentId,
            role: 'assistant',
            content: assistantContentJson,
            attachments: queuedAttachmentsJson,
            turnNumber,
          });
        } else {
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, token_count, model_id, cost, latency_ms, turn_number, reasoning_content, source, created_at)
            VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, NULL, ?, ?, NULL, datetime('now'))
          `).run(
            messageId,
            agentId,
            assistantContentJson,
            queuedAttachmentsJson,
            result.outputTokens,
            effectiveModelIdForPersist,
            null,
            turnNumber,
            result.reasoningContent ?? null,
          );
        }
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: messageId,
            agentId,
            role: 'assistant' as Message['role'],
            content: JSON.stringify(assistantContentForStore),
            tokenCount: null,
            modelId: effectiveModelIdForPersist,
            cost: null,
            latencyMs: null,
            createdAt: new Date().toISOString(),
            attachments: queuedAttachments.length > 0 ? queuedAttachments : undefined,
            reasoningContent: result.reasoningContent ?? undefined,
            source: interAgentTurn ? 'a2a' : null,
            // Carry the turn's conversation key LIVE so the dashboard can hide
            // background-run tool chips in regular mode consistently with reload.
            // conv_key is stamped on the persisted row only at turn end, so this
            // broadcast (mid-turn) sources it from chosenConvKey directly: a
            // human conversation key for a user turn (chips stay visible), null
            // for a background/engine turn (chips hidden). Matches what
            // rowToMessage serves on the next refetch.
            convKey: chosenConvKey,
          },
        });
        // v2.7.24, also track text-with-tools iterations as deliverable
        // assistant text. Previously this branch ran (because there are
        // tool calls) without updating lastAssistantTextForIM, which meant
        // a turn shaped "text + tool call → tool result → [no-reply]" would
        // leave the channel-routing block with nothing to deliver. The
        // user's substantive answer (the text in iter 1) never reached
        // iMessage / Teams / email. Capturing the LAST iteration's text
        // regardless of whether tools rode with it gives the routing
        // block the right value to deliver at end-of-turn.
        if (persistedContent && persistedContent.trim().length > 0) {
          state = advance(state, { lastAssistantTextForIM: stripOrbMood(persistedContent) });
        }
      } else if (persistedContent) {
        if (interAgentTurn) {
          // D-A step 8: own-output on an inter-agent iteration NEVER touches
          // `messages`. In practice outputPersistenceClassifier always suppresses
          // trailing text on an inter-agent turn (so persistedContent is null and
          // this branch does not run), but keeping the relocation here makes the
          // "no own inter-agent output in messages" invariant total and future-proof.
          insertInterAgentOwnOutput({
            id: messageId,
            agentId,
            role: 'assistant',
            content: persistedContent,
            attachments: queuedAttachmentsJson,
            turnNumber,
          });
        } else {
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, token_count, model_id, cost, latency_ms, turn_number, reasoning_content, created_at)
            VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, NULL, ?, ?, datetime('now'))
          `).run(
            messageId,
            agentId,
            persistedContent,
            queuedAttachmentsJson,
            result.outputTokens,
            effectiveModelIdForPersist,
            null,
            turnNumber,
            result.reasoningContent ?? null,
          );
        }
        if (persistedContent.trim().length > 0) {
          state = advance(state, { lastAssistantTextForIM: stripOrbMood(persistedContent) });
        }
        // Per v1 runtime.ts:1303-1318, text-only response. The streaming
        // chunks already delivered the text live, so we'd dupe-render if we
        // unconditionally fired chat:message. With attachments present,
        // however, the dashboard's chat:message handler updates the streaming
        // bubble in-place to ATTACH the files, that's the only way the
        // attachments reach the live UI without a page reload.
        if (queuedAttachments.length > 0) {
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: messageId,
              agentId,
              role: 'assistant' as Message['role'],
              content: persistedContent,
              tokenCount: null,
              modelId: effectiveModelIdForPersist,
              cost: null,
              latencyMs: null,
              createdAt: new Date().toISOString(),
              attachments: queuedAttachments,
            },
          });
        }
      }

      // A-1 (comms-audit): the end-of-turn channel router routes TEXT only, so a
      // deliverable file attached to the reply reached only the dashboard. If the
      // requester is on iMessage, deliver the files to them too. iMessage counterparty
      // only (a dashboard turn already renders the files in its bubble above).
      if (queuedAttachments.length > 0 && counterparty.kind === 'user' && counterparty.channel === 'imessage' && counterparty.senderId) {
        try {
          const { sendIMessageWithAttachment } = await import('../../services/imessage-bridge.js');
          for (const att of queuedAttachments as Array<{ path?: string }>) {
            if (att.path) sendIMessageWithAttachment(counterparty.senderId, att.path, '');
          }
        } catch (err) {
          logger.warn('A-1: reply-attachment iMessage delivery failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
        }
      }

      // Broadcast streaming complete (only if we actually streamed something)
      if ((persistedContent && persistedContent.trim().length > 0) || result.toolCalls.length > 0) {
        broadcast({
          type: 'chat:chunk',
          agentId,
          messageId,
          content: '',
          done: true,
          modelId: state.modelId === '__auto__' ? configuredModelId : state.modelId,
        });
      }

      // No tools? Loop is done.
      if (result.toolCalls.length === 0) {
        // ── v2.7.17: "added a note then stopped" detector ──
        // Common failure: agent is mid-project, calls tracker_add_notes as
        // a status checkpoint, then ends the turn silently because the
        // model treats the note as a stopping point. The user is left
        // wondering why the agent went idle. Detect that pattern and
        // fire a one-shot nudge before the turn ends.
        //
        // Conditions:
        //   - had any tool calls this turn
        //   - LAST tool call was tracker_add_notes
        //   - the target task is still in_progress
        //   - not already nudged this turn (one-shot, no loop)
        if (
          !state.nudgedForAddNotesStopThisTurn &&
          state.toolResults.length > 0
        ) {
          const lastTool = state.toolResults[state.toolResults.length - 1];
          if (lastTool && lastTool.name === 'tracker_add_notes') {
            // Pull the task_id from the original tool call args. The args
            // live on the matching toolCall record by id; search both lists.
            let nudgedTaskId: string | null = null;
            for (let i = state.toolCalls.length - 1; i >= 0; i--) {
              const tc = state.toolCalls[i];
              if (tc.id === lastTool.toolCallId && tc.name === 'tracker_add_notes') {
                const tid = (tc.arguments as { task_id?: unknown })?.task_id;
                if (typeof tid === 'string') nudgedTaskId = tid;
                break;
              }
            }
            if (nudgedTaskId) {
              const row = db.prepare('SELECT status, title FROM tasks WHERE id = ?').get(nudgedTaskId) as { status?: string; title?: string } | undefined;
              if (row?.status === 'in_progress') {
                const titleShort = (row.title ?? '').slice(0, 60);
                const nudgeText = (
                  `[System: you just added a note to "${titleShort}" (${nudgedTaskId.slice(0, 8)}) but did not say what comes next. ` +
                  `That task is STILL in_progress. If you have more work to do on it, KEEP GOING - call your next tool now, do not end the turn. ` +
                  `If you are genuinely waiting on something (user input, an external response, a scheduled time), say so explicitly: ` +
                  `update the task status to "blocked" or "paused" with a clear reason, OR write one sentence in your reply telling the user what you are waiting for. ` +
                  `Silently going idle after tracker_add_notes leaves the user with no idea what is happening.]`
                );
                // RC-19: via persistEngineSteer so the nudge reaches the model
                // (pendingNudge) AND keeps its dashboard row. The prior bare
                // role='system' row was stripped by the assembler, so the re-entered
                // model never saw "keep going / say what you are waiting for".
                state = persistEngineSteer(
                  state,
                  { agentId, content: nudgeText, turnNumber, extra: { nudgedForAddNotesStopThisTurn: true } },
                  { db, broadcast },
                );
                logger.info('v2 add-notes-stop nudge fired', { agentId, taskId: nudgedTaskId }, agentId);
                continue; // re-enter the loop so the model sees the nudge
              }
            }
          }
        }

        // ── v2.7.17: "going idle with in_progress task" detector ──
        // Broader sibling of the add-notes-stop nudge. Catches every case
        // where the agent ends a turn while a task assigned to them is
        // still in_progress AND they did not transition it this turn.
        // Walks them through the decision matrix - keep going, mark
        // complete, mark paused (waiting on user), or mark blocked
        // (needs escalation). One-shot so a model that insists on
        // stopping doesn't trigger a loop.
        //
        // Skip if the close-out gate is already armed for this turn
        // (the gate's own message + dispatcher already covers the case)
        // or the add-notes-stop nudge just fired (we just told them).
        if (
          !state.nudgedForGoingIdleWithInProgressThisTurn &&
          !state.nudgedForAddNotesStopThisTurn &&
          !state.nudgedForCloseOutThisTurn
        ) {
          // Find in_progress tasks assigned to this agent. Use the same
          // criterion the close-out gate uses but at end-of-turn instead
          // of start: any in_progress task at all (even one touched this
          // turn) qualifies, because the issue isn't staleness - it's
          // that the agent went idle without resolving its state.
          const openTasks = db.prepare(`
            SELECT id, title FROM tasks
            WHERE assigned_to = ?
              AND status = 'in_progress'
              AND is_paused = 0
            ORDER BY updated_at DESC
            LIMIT 5
          `).all(agentId) as Array<{ id: string; title: string }>;

          // Skip if no in_progress tasks - then the agent is fine to idle.
          // Also skip if the agent ALREADY transitioned a task this turn
          // (any tracker_update_status / tracker_complete_step call), since
          // that signals they DID make a deliberate state choice and just
          // happened to leave another task in_progress for legitimate reasons.
          const transitionedThisTurn = state.toolResults.some(
            tr => tr.name === 'tracker_update_status' || tr.name === 'tracker_complete_step' || tr.name === 'tracker_close_project',
          );

          // ── Channel-awareness: enforce task bookkeeping only on a TASK-EXECUTION
          // turn, never on a CONVERSATION turn (attribution redesign §4.5). ──
          // The closeout/auto-pause/PM-escalation machinery exists to catch "the
          // agent WORKED a task and forgot to record it." A pure conversational
          // reply, answering "what's on my plate?", searching the vault and telling
          // the user "I couldn't find the key", greeting a contact, is NOT task
          // execution; the standing backlog is not this turn's responsibility.
          // Firing on it is exactly what turned a simple question into a closeout-miss
          // + PM sweep storm. A turn "worked a task" only if it was task-triggered
          // (scheduler / A2A task coordination) OR it produced a real side effect
          // (sent a message, ran exec, created a doc/file). Reading the tracker or
          // just talking does not count. Decide by what the turn actually did.
          //
          // MEMBERSHIP IS DERIVED, NOT HAND-LISTED. The original hand list here
          // froze a snapshot of google-flavored canonical names, so every _ms
          // variant, every user_ twin, and every office/onedrive tool read as
          // "just conversation": a 31-event calendar_create_ms turn skipped this
          // whole machinery, its task sat open for 100 minutes, and an unrelated
          // email wake re-announced the finished work to the owner (observed on
          // the production box 2026-07-08). classifyTool is the canonical,
          // test-covered classifier (every tool in categories.ts must classify,
          // per the shared V5 test), so new tools can never silently fall out.
          // tracker_add_notes / tracker_create_task classify as bookkeeping but
          // counted in the old list on purpose (tending the tracker IS task
          // work); keep them explicitly.
          const countsAsTaskWork = (name: string): boolean =>
            classifyTool(name) === 'effectful-action' ||
            name === 'tracker_add_notes' || name === 'tracker_create_task';
          const schedulerTurn = mostRecentInbound?.origin_intent === 'scheduler' || (lastUserMessageContent ?? '').includes('[SOURCE: SCHEDULER');
          const workedATaskThisTurn = schedulerTurn || isA2ATurn ||
            state.toolResults.some(tr => !tr.isError && !!tr.name && countsAsTaskWork(tr.name));

          if (openTasks.length > 0 && !transitionedThisTurn && workedATaskThisTurn) {
            // v2.10.2, detect scheduler-triggered turns AND scan this
            // turn's tool_results for side-effecting calls that
            // returned success. Pre-fix, the agent had to read a
            // 4-option menu and construct result+evidence themselves,
            // and frequently just emitted "08 done" as text. When
            // we can see "you just ran gmail_send and got [SENT]",
            // surfacing that inline makes the close-out mechanical.
            //
            // Signal source is `state.toolResults` (in-memory, this
            // turn) rather than task_log, most tools don't write
            // per-task log entries when called, so a task_log scan
            // would almost always come up empty.
            // v3.1.10 (attribution redesign §5, Phase 5): decide by structured
            // origin first. The scheduler stamps origin_intent='scheduler'; reading
            // it fixes the case where lastUserMessageContent (now sourced from the
            // authorized-human waiting set) is null on a pure scheduler turn and the
            // prose marker could never match. Prose kept only as the legacy fallback.
            const isSchedulerTriggered =
              mostRecentInbound?.origin_intent === 'scheduler' ||
              (lastUserMessageContent ?? '').includes('[SOURCE: SCHEDULER');
            // Same derived membership as countsAsTaskWork above (minus the
            // tracker tools: this hint warns about re-running EXTERNAL side
            // effects, and re-adding a tracker note is harmless). The old hand
            // list had the same google-only drift as SIDE_EFFECTING did.
            const recentSideEffects: Array<{ name: string; preview: string }> = [];
            for (let i = state.toolResults.length - 1; i >= 0 && recentSideEffects.length < 4; i--) {
              const tr = state.toolResults[i];
              if (!tr.name || classifyTool(tr.name) !== 'effectful-action') continue;
              if (tr.isError) continue;
              const preview = (tr.content ?? '').replace(/\s+/g, ' ').slice(0, 160);
              recentSideEffects.push({ name: tr.name, preview });
            }
            const taskList = openTasks
              .map(t => `  - "${t.title.slice(0, 60)}" (${t.id.slice(0, 8)})`)
              .join('\n');
            const schedulerHint = isSchedulerTriggered
              ? `\n**This turn was scheduler-triggered.** Scheduler-fired tasks rarely need option (1) KEEP GOING, the scheduler does the repetition, not you. The right answer here is almost always option (2) DONE.\n`
              : '';
            const auditHint = recentSideEffects.length > 0
              ? `\nYou successfully called ${recentSideEffects.length === 1 ? 'a side-effecting tool' : 'side-effecting tools'} this turn:\n` +
                recentSideEffects.map(s => `  - \`${s.name}\` returned: ${s.preview}`).join('\n') + `\n\n` +
                `These are NON-IDEMPOTENT actions that already executed. Re-running them would duplicate the side effect (double email, double text, double charge). The work is done. Close the task NOW:\n` +
                `\`tracker_update_status(task_id="${openTasks[0].id}", status="complete", result="<one-line summary of what landed>", evidence=[{kind: "tool_call_ref", claim: "${recentSideEffects[0].name} succeeded"}])\`\n`
              : '';
            const nudgeText = (
              `[System: you are about to end this turn with ${openTasks.length} task${openTasks.length === 1 ? '' : 's'} still in_progress and assigned to you:\n` +
              `${taskList}\n` +
              schedulerHint +
              auditHint +
              `\nPick exactly one of these before ending the turn:\n\n` +
              `  1. KEEP GOING - call your next tool NOW to continue from EXACTLY where you stopped. Long file reads, batch operations, multi-step processes, don't restart, don't re-read content you already processed, just advance to the next line / next item / next step.\n` +
              `  2. DONE - tracker_update_status(task_id, status="complete", result="...", evidence=[...]) (or tracker_complete_step for multi-step projects).\n` +
              `  3. WAITING ON USER (already asked them) - tracker_update_status(task_id, status="paused", notes="waiting for X"). PM will ignore this task entirely; no pokes.\n` +
              `  4. BLOCKED (needs escalation - user does not know yet) - tracker_update_status(task_id, status="blocked", notes="why"). PM will surface this to the primary user.\n\n` +
              `If you go idle with a task still in_progress, the engine will auto-pause it and escalate to PM. Pre-fix for non-idempotent tasks (gmail_send, sms_send, voice_call, exec hitting live APIs), PM was then forced into a re-run remediation that duplicated the side effect. Save everyone the work: close the task now.]`
            );
            // v3.1.10: if the agent ALREADY produced a user-facing reply this
            // turn, do NOT re-prompt it. The weaker model treats the re-prompt
            // as "answer again" and emits a second, slightly-reworded reply, 
            // the double-response the user reported (e.g. the Anthropic-OAuth
            // recall question answered twice), and on a setup turn the same
            // re-prompt makes it redo the work (the duplicate project). Set the
            // flag and fall through to the close-out hardcap below, which
            // reconciles the dangling task deterministically (pause one-shot /
            // reset recurring) while the one reply already shown stands. Only
            // re-prompt when there is NO reply yet (a silent stop), where it can
            // safely get the agent to continue or formally close the task. Build
            // to the weak-model floor: never rely on a re-prompt doing the right
            // thing.
            state = advance(state, { nudgedForGoingIdleWithInProgressThisTurn: true });
            const alreadyRepliedThisTurn = !!(persistedContent && persistedContent.trim().length > 0);
            if (alreadyRepliedThisTurn) {
              logger.info('v2 going-idle-with-in_progress: agent already replied this turn, skipping re-prompt, engine reconciles the dangling task', {
                agentId, openTaskCount: openTasks.length, taskIds: openTasks.map(t => t.id),
              }, agentId);
              // No nudge message, no continue: fall through to the hardcap below,
              // which pauses/resets the dangling task and keeps the single reply.
            } else {
              const nudgeId = uuidv4();
              db.prepare(`
                INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
                VALUES (?, ?, 'system', ?, ?, datetime('now'))
              `).run(nudgeId, agentId, nudgeText, turnNumber);
              broadcast({
                type: 'chat:message',
                agentId,
                message: {
                  id: nudgeId, agentId, role: 'system' as const,
                  content: nudgeText,
                  tokenCount: null, modelId: null, cost: null, latencyMs: null,
                  createdAt: new Date().toISOString(),
                },
              });
              // F2.6: the persisted row above is a role='system' message, which the
              // assembler strips, so the re-entered round would carry NO new info and
              // burn a model call for nothing. Deliver the menu via pendingNudge (a
              // synthetic user message injected next iteration) so the extra round
              // actually shows the model the 4-option decision. Row kept for the
              // dashboard. Gating is unchanged.
              state = advance(state, { pendingNudge: nudgeText });
              logger.info('v2 going-idle-with-in_progress nudge fired', {
                agentId, openTaskCount: openTasks.length, taskIds: openTasks.map(t => t.id),
              }, agentId);
              continue; // re-enter the loop so the model sees the nudge
            }
          }
        }

        // Going-idle reconciliation (demolition Phase 1.3): the going-idle nudge
        // already fired this turn and the model STILL ended with a user-facing
        // closeout ("Done" / "All set") without calling a tracker close verb.
        // P2 drive boundary (owner status-truth invariant, 2026-07-21): the
        // going-idle deliverable_shown stamp that lived here was DELETED. It
        // guessed "the reply the user saw IS the delivery" from the mere fact
        // that a non-empty reply and open tasks coexisted, then marked EVERY
        // in_progress task delivered, and that hidden flag stood the poke
        // ladder down (the yacht-research silent hour). Statuses are promises:
        // an in_progress task stays visibly in_progress and the ladder DRIVES
        // it (check-in poke: continue, or close with evidence, or self-mark
        // paused/blocked). Real delivery evidence files Key-1 through the
        // sanctioned paths; prose never silences the drive.
        //
        // RECURRING CARVE-OUT (kept, janitorial not forgery): a recurring
        // schedule is never terminally completed by a missed close-out; fail
        // THIS run and keep the schedule alive.
        if (
          state.nudgedForGoingIdleWithInProgressThisTurn &&
          persistedContent && persistedContent.trim().length > 0
        ) {
          const recurringDanglers = db.prepare(`
            SELECT id FROM tasks
            WHERE assigned_to = ?
              AND status = 'in_progress'
              AND is_paused = 0
              AND repeat_interval IS NOT NULL
            ORDER BY updated_at DESC
            LIMIT 10
          `).all(agentId) as Array<{ id: string }>;
          if (recurringDanglers.length > 0) {
            const { forceResetStuckRecurringTask } = await import('../../scheduler/runner.js');
            for (const r of recurringDanglers) {
              try { forceResetStuckRecurringTask(r.id); } catch { /* best effort */ }
            }
            logger.info('v2 idle-with-in_progress: recurring dangler(s) failed THIS run and rejoined their schedule; one-shot danglers stay visibly in_progress for the drive boundary', {
              agentId, recurringResetCount: recurringDanglers.length,
            }, agentId);
          }
        }

        // F2.1 (demolition Phase 1.7 #2): same-turn engine close of an
        // engine-auto-scaffolded task on a read-only conversation turn. The
        // mid-turn floor opens a task after 6 work calls of ANY kind, including
        // pure reads. On a read-only turn (e.g. an inbox sweep) the going-idle
        // machinery above never fires (it requires a scheduler / A2A /
        // side-effecting turn), so the task the ENGINE itself opened would dangle
        // and later trip the PM poke chain into re-delivering the old answer as a
        // "ghost done". Requirement satisfied: the engine owns the lifecycle of
        // the tasks it opens. Scope is deliberately narrow, and the demolition
        // narrows it further: closeEngineScaffoldSameTurn verifies the task
        // carries the ENGINE_AUTO_MARKER and was created THIS turn, and closes it
        // complete_validated=0 (UNVALIDATED) so the PM sweep still validates it,
        // instead of the forged complete_validated=1 the old engineCloseDeliveredTask
        // wrote. Unrelated danglers keep their existing handling; a read-only turn
        // must NOT bulk-close unrelated work against an unrelated reply. The
        // !nudgedForGoingIdle guard means the worked-task path above already
        // reconciled it, so this only runs when nothing else did. Natural turn end
        // only (inside result.toolCalls.length === 0), never the turn-budget path.
        if (
          state.autoScaffoldedTaskIdThisTurn &&
          !state.nudgedForGoingIdleWithInProgressThisTurn &&
          persistedContent && persistedContent.trim().length > 0
        ) {
          const scaffoldId = state.autoScaffoldedTaskIdThisTurn;
          const stillOpen = db.prepare(
            `SELECT 1 FROM tasks WHERE id = ? AND status = 'in_progress' AND is_paused = 0`,
          ).get(scaffoldId);
          if (stillOpen) {
            try {
              const { closeEngineScaffoldSameTurn } = await import('../../tracker/tools.js');
              const closed = await closeEngineScaffoldSameTurn(agentId, scaffoldId, persistedContent);
              if (closed) {
                logger.info('v2 same-turn scaffold close: engine closed its own auto-scaffolded task against the delivered reply, unvalidated (read-only turn)', {
                  agentId, taskId: scaffoldId,
                }, agentId);
              }
            } catch { /* best effort */ }
          }
        }

        // ── F3: owed mid-turn interrupt re-prompt ──
        // A quick question that lands WHILE a turn is running is NOT an interrupt:
        // its wakeup row sits conv_key NULL and rides into the running turn's
        // per-iteration reassembled tail (runtime.ts). At teardown,
        // claimAssembledSiblings claims every same-conversation user row that was in
        // the answered context (conv_key NULL, created_at <= the final assembly) so a
        // burst can't earn a duplicate answer, a requirement we KEEP intact. The gap
        // it leaves: "in context when we answered" is treated as "was answered", so a
        // DISTINCT factual question that arrived mid-task is claimed as served and
        // never answered anywhere (the weak model absorbs the interruption silently).
        //
        // Fix the CAUSE, don't suppress the claim: on a user turn that produced a
        // reply, give the model exactly ONE more round to address any owed mid-turn
        // arrival BEFORE the same teardown claim marks it served. The [no-reply]
        // escape is what keeps this from creating a NEW duplicate-answer problem when
        // the main reply already covered it. getOwedMidTurnArrivals scopes to the
        // EXACT set the claim will take (same conv-scoping + window) narrowed to
        // mid-turn arrivals (created_at > turnStartedAt), so the trigger and any
        // pre-turn burst siblings (answered as the turn's subject) are excluded.
        //
        // Placed AFTER the F2.1 scaffold close so that close still runs on THIS
        // iteration's reply (it must not be deferred into a possible [no-reply] extra
        // round), and it yields to the going-idle hardcap above (which breaks first on
        // a worked-task-with-danglers turn) so this never fights that reconciliation.
        // One-shot (nudgedForOwedInterruptThisTurn) and skipped at the loop cap, so it
        // can neither spin the loop nor push past MAX_TOOL_LOOPS.
        if (
          counterparty.kind === 'user' &&
          !isEngineTurn &&
          !state.nudgedForOwedInterruptThisTurn &&
          persistedContent && persistedContent.trim().length > 0 &&
          state.loopCount < MAX_TOOL_LOOPS &&
          lastAssembledAtIso &&
          chosenConvKey &&
          chosenConvKey !== 'engine' &&
          !chosenConvKey.startsWith('park:') &&
          !chosenConvKey.startsWith('relayed:')
        ) {
          let owed = getOwedMidTurnArrivals(agentId, chosenConvKey, turnStartedAt, lastAssembledAtIso);
          if (owed.length > 0) {
            // Belt-and-suspenders on top of the query's origin_kind='engine' filter:
            // never quote human text that merely opens with an engine tag ([System:,
            // [A2A:, [SOURCE: ...) back into a model-visible re-prompt.
            const { looksLikeEngineMessage } = await import('./classifiers/multistep.js');
            owed = owed.filter((m) => !looksLikeEngineMessage(m.content));
          }
          if (owed.length > 0) {
            const quoted = owed
              .slice(0, 3)
              .map((m) => `"${m.content.replace(/\s+/g, ' ').trim().slice(0, 200)}"`)
              .join('; ');
            const itThem = owed.length === 1 ? 'it' : 'them';
            const rePrompt = (
              `[System] While you were working, the user also sent: ${quoted}. ` +
              `Reply ONLY to ${itThem}, in one or two sentences. ` +
              `Answer from what you already know, with at most one quick lookup if truly needed. ` +
              `Do not re-run the tools you used for the main task; that work is done and delivered. ` +
              `Do NOT repeat, summarize, or re-deliver ANY part of your earlier reply; the user already has it. ` +
              `If your earlier reply already answered ${itThem}, reply exactly [no-reply].`
            );
            const rePromptId = uuidv4();
            try {
              // Model-visible engine channel, same pattern as the thrash steer and the
              // auto-scaffold note: an origin_kind='engine' row (EVENTS lane surfaces
              // it) with the 'engine-steer' conv_key sentinel so it can never be picked
              // as a pending engine event, PLUS pendingNudge so the steer reaches the
              // model on the very next iteration. Label form ([System] body) so the
              // events-lane leading-bracket strip keeps the body.
              insertInterAgentEngineRow({
      work: null,
                id: rePromptId,
                agentId,
                content: rePrompt,
                sourceAgentId: null,
                originIntent: 'owed_interrupt',
                convKey: 'engine-steer',
                turnNumber,
              });
            } catch { /* best effort */ }
            state = advance(state, { nudgedForOwedInterruptThisTurn: true, pendingNudge: rePrompt });
            logger.info('v2 owed-interrupt re-prompt: a mid-turn user message was assembled but may be unanswered; giving the model one more round before the teardown claim marks it served', {
              agentId, turnNumber, owedCount: owed.length, convKey: chosenConvKey,
            }, agentId);
            continue; // exactly one more round for the model to answer the owed ask
          }
        }

        // ── Promise floor: a turn whose entire deliverable is a promise to start ──
        // The last member of the fall-asleep family. Observed live 2026-07-08: the
        // owner asked for a calendars-to-markdown job, the ack fired, one
        // load_tool_docs round ran, then the model emitted TEXT ("On it. Let me pull
        // up all your calendars.") with NO tool calls, and the loop took that promise
        // as the turn's reply and ended clean. Every existing floor (task closeout,
        // going-idle, completion ack) keys on tasks or deliveries; NONE catches a
        // reply whose whole content is a promise to begin.
        //
        // Sequenced AFTER the F3 owed-interrupt block so that answering an owed
        // mid-turn ask takes priority (F3 continues before we reach here). Guards
        // mirror F3 (real user turn, non-empty reply, a human conv_key, and the same
        // MAX_TOOL_LOOPS proximity skip so it can neither spin nor push past the cap)
        // plus two more, deliberately conservative because the action is a re-prompt:
        // (2) the reply must LOOK like a forward promise at its END
        // (isForwardPromiseReply, unit-tested), and (3) the turn must have done
        // NEGLIGIBLE work, no successful effectful-action tool result AND no task
        // transitioned/closed this turn (same classifyTool === 'effectful-action'
        // derivation the closeout machinery uses at countsAsTaskWork; retrieval /
        // bookkeeping reads like load_tool_docs do NOT count, so the live case still
        // qualifies). One-shot: if the model ends AGAIN with a promise after the
        // steer, log the tripwire and let the turn end rather than spin.
        if (
          counterparty.kind === 'user' &&
          !isEngineTurn &&
          persistedContent && persistedContent.trim().length > 0 &&
          state.loopCount < MAX_TOOL_LOOPS &&
          chosenConvKey &&
          chosenConvKey !== 'engine' &&
          !chosenConvKey.startsWith('park:') &&
          !chosenConvKey.startsWith('relayed:') &&
          isForwardPromiseReply(persistedContent)
        ) {
          const didEffectfulWorkThisTurn = state.toolResults.some(
            (tr) => !tr.isError && !!tr.name && classifyTool(tr.name) === 'effectful-action',
          );
          const transitionedATaskThisTurn = state.toolResults.some(
            (tr) => !tr.isError && (
              tr.name === 'tracker_update_status' ||
              tr.name === 'tracker_complete_step' ||
              tr.name === 'tracker_close_project'
            ),
          );
          if (!didEffectfulWorkThisTurn && !transitionedATaskThisTurn) {
            const quoted = persistedContent.replace(/\s+/g, ' ').trim().slice(0, 200);
            if (state.nudgedForPromiseFloorThisTurn) {
              // Steered once already this turn and the model STILL ended on a promise.
              // Don't spin, let the turn end. This warn is the tripwire that a harder
              // floor is needed if the weak model can't be talked past it.
              logger.warn('promise floor: second promise ending, letting the turn end', {
                agentId, turnNumber, convKey: chosenConvKey,
              }, agentId);
            } else {
              const steer = (
                `[System] Your reply to the user was a promise to start ('${quoted}') but the turn ` +
                `was about to end with no work done. Do the work NOW with tool calls and deliver the ` +
                `result. Do not narrate what you are about to do again.`
              );
              const steerId = uuidv4();
              try {
                // Model-visible engine channel, same pattern as the owed-interrupt
                // re-prompt: an origin_kind='engine' row on the 'engine-steer' conv_key
                // sentinel (never pickable as a pending event), PLUS pendingNudge so the
                // steer reaches the model on the next iteration. The promise text row the
                // user already saw is KEPT visible (never delete a user-visible row); the
                // follow-through lands after it.
                insertInterAgentEngineRow({
      work: null,
                  id: steerId,
                  agentId,
                  content: steer,
                  sourceAgentId: null,
                  originIntent: 'promise_floor',
                  convKey: 'engine-steer',
                  turnNumber,
                });
              } catch { /* best effort */ }
              state = advance(state, { nudgedForPromiseFloorThisTurn: true, pendingNudge: steer });
              logger.info('v2 promise floor: reply was a forward promise with negligible work this turn; steering the model to do the work now', {
                agentId, turnNumber, convKey: chosenConvKey,
              }, agentId);
              continue; // one more round to actually do the work and deliver
            }
          }
        }

        // A2A-handoff floor (owner law 2026-07-09: a turn the user triggered may
        // never end in silence because work was delegated). The async handoff
        // contract tells the model to end its turn after send_to_agent; on a weak
        // model that instruction wins over "tell the user first," so a user-facing
        // turn can end with results in hand and nothing delivered (production
        // transcript 2026-07-09: live device list fetched, then a handoff, then
        // silence). Mutually exclusive with the promise floor above, which
        // requires a non-empty final reply; this one requires an EMPTY one.
        // Steer once; if the model STILL ends silently, the engine delivers a
        // short handoff notice itself, so silence stops being a possible outcome.
        // A successful explicit channel send this turn (explicitSendThisTurn)
        // means the user already heard something delivered on purpose; stand down.
        if (
          counterparty.kind === 'user' &&
          !isEngineTurn &&
          (!persistedContent || persistedContent.trim().length === 0) &&
          chosenConvKey &&
          chosenConvKey !== 'engine' &&
          !chosenConvKey.startsWith('park:') &&
          !chosenConvKey.startsWith('relayed:') &&
          !Object.values(state.explicitSendThisTurn).some(Boolean) &&
          state.toolResults.some((tr) => !tr.isError && tr.name === 'send_to_agent')
        ) {
          if (!state.nudgedForA2AHandoffFloorThisTurn && state.loopCount < MAX_TOOL_LOOPS) {
            const steer = (
              `[System] You handed work to another agent and are ending this turn without telling ` +
              `the user anything. The user is waiting. Send the user a short message NOW: report any ` +
              `results you already have, and say you have asked another agent for the rest and will ` +
              `report back when they answer. Do not message the other agent again.`
            );
            const steerId = uuidv4();
            try {
              insertInterAgentEngineRow({
      work: null,
                id: steerId,
                agentId,
                content: steer,
                sourceAgentId: null,
                originIntent: 'a2a_handoff_floor',
                convKey: 'engine-steer',
                turnNumber,
              });
            } catch { /* best effort */ }
            state = advance(state, { nudgedForA2AHandoffFloorThisTurn: true, pendingNudge: steer });
            logger.info('v2 a2a-handoff floor: user-facing turn ending silently after a handoff; steering the model to report to the user first', {
              agentId, turnNumber, convKey: chosenConvKey,
            }, agentId);
            continue; // one more round to report to the user
          }
          // RC-4.2: the hard-floor handoff notice is a channel-delivered A2A-handoff
          // ack. Never push it to an agent-flagged counterparty (ack ping-pong); a peer
          // box handles a silent handoff on its own lane and does not need the notice.
          if (state.nudgedForA2AHandoffFloorThisTurn && !counterpartyIsAgentSender) {
            // Hard floor: the steer did not produce a user-facing send, so the
            // engine says the honest minimum itself. Deterministic, model-free.
            try {
              await deliverEngineUserAck(pickA2AHandoffAck(), 'engine_progress_ack');
              logger.warn('v2 a2a-handoff floor: model ended silently after the steer; engine delivered the handoff notice itself', {
                agentId, turnNumber, convKey: chosenConvKey,
              }, agentId);
            } catch { /* best effort; never block the turn end */ }
          }
        }

        // ── Reminder-delivery silence floor (P3 wave, 2026-07-21) ──
        // A turn serving a kind='reminder' occurrence exists to SAY one thing
        // to the owner. Observed silent-close: the model closed the run
        // (correct bookkeeping) and ended without replying, so the reminder
        // never reached the owner at all. The floor is deterministic and
        // model-free: the task description IS the reminder text, so if the
        // turn ends with no user-visible reply and no owner-channel send,
        // the engine delivers the reminder itself. Same pattern as the
        // A2A-handoff hard floor (engine states a fact; no prose authority).
        {
          const servedRem = currentTurnServedWork.get(agentId);
          if (
            servedRem?.taskKind === 'reminder' &&
            (!persistedContent || persistedContent.trim().length === 0) &&
            !Object.values(state.explicitSendThisTurn).some(Boolean)
          ) {
            try {
              const remRow = servedRem.taskId
                ? (db.prepare('SELECT title, description FROM tasks WHERE id = ?')
                    .get(servedRem.taskId) as { title: string | null; description: string | null } | undefined)
                : undefined;
              const remText = (remRow?.description || remRow?.title || '').replace(/^Reminder:?\s*/i, '').trim();
              if (remText) {
                await deliverEngineUserAck(`Reminder: ${remText}`, 'engine_reminder_delivery');
                logger.warn('v2 reminder silence floor: reminder turn ended with no user-visible delivery; engine delivered the reminder text itself', {
                  agentId, turnNumber, taskId: servedRem.taskId,
                }, agentId);
              }
            } catch { /* best effort; never block turn end */ }
          }
        }

        // Cross-conversation re-answer floor (2026-07-09 disease, structural
        // stage). The tail [Engine hint] alone did not stop the weakest
        // supported model from re-answering another conversation's settled
        // question (verified on dev 2026-07-10), so when the deterministic
        // content detector (re-answer-guard.ts) flags the final reply as a
        // near-duplicate of an answer the user already received elsewhere, the
        // model gets ONE steer to respond only to this turn's trigger. A second
        // emission is DELIVERED (never suppressed, per house rules) and logged
        // loudly as the evidence for any harder future stage.
        if (
          persistedContent && persistedContent.trim().length >= 160 &&
          chosenConvKey !== 'engine' &&
          !(chosenConvKey ?? '').startsWith('park:') &&
          !(chosenConvKey ?? '').startsWith('relayed:')
        ) {
          const reAnswer = findCrossConvReAnswer(db, agentId, persistedContent, chosenConvKey ?? null);
          if (reAnswer) {
            // LOG-ONLY, deliberately (2026-07-10). The steer version of this
            // floor false-positived on legitimately similar recurring content
            // (a reused agent's repeated fixtures in the battery; daily reports
            // and repeated confirmations in real life) and its escape hatch
            // ("or nothing at all") licensed the weak model into a SILENT reply
            // on a basic question, the exact disease this work exists to kill.
            // The ROOT fix for re-answers lives in memory/assembler.ts (never
            // delete delivered history); this detector remains as production
            // telemetry proving that fix holds. It must never alter behavior.
            logger.warn('v2 re-answer telemetry: final reply resembles a settled answer from another conversation (delivering normally; root fix is the assembler)', {
              agentId, turnNumber, convKey: chosenConvKey, matchConv: reAnswer.convKey, similarity: reAnswer.similarity,
            }, agentId);
          }
        }

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
          state.nudgedForMissedReplyOnAssignId === a2aReplyAssignMessageId &&
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
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
            VALUES (?, ?, 'system', ?, ?, datetime('now'))
          `).run(stopId, agentId, stopMsg, turnNumber);
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
          break;
        }

        // Missed-reply nudge (subsumes v1 runtime.ts:1344-1378)
        const replyDecision = a2aReplyEnforcer({
          triggeredByReplyNeededIntent: a2aReplyContext !== null,
          sentToAgentThisTurn: state.sentToAgentThisTurn,
          alreadyNudgedForMissedReply:
            !!a2aReplyAssignMessageId && state.nudgedForMissedReplyOnAssignId === a2aReplyAssignMessageId,
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
          // (pendingNudge) AND keeps its dashboard row. The bare role='system' row
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
              extra: a2aReplyAssignMessageId ? { nudgedForMissedReplyOnAssignId: a2aReplyAssignMessageId } : undefined,
            },
            { db, broadcast },
          );
          // Continue loop so the agent reads the nudge and retries
          continue;
        }

        // ── End-of-turn tracker close-out check (v2.5.40) ──
        // Common failure: agent opens a project, marks task 1 in_progress,
        // does the work, never marks it complete (or any subsequent task).
        // The PM agent's poke chain eventually catches it but costs a 30-min
        // wait. Detect at the moment of failure: agent is ending the turn
        // with text, has at least one in_progress task assigned, AND made
        // no tracker_update_status / tracker_complete_step call this turn.
        //
        // Hardcap mirrors the A2A enforcer: if the agent already saw the
        // nudge once this turn and STILL produces text without updating
        // tracker status, end the turn cleanly. Don't loop forever.
        const agentProducedText = !!(persistedContent && persistedContent.trim().length > 0);
        if (agentProducedText) {
          // ── v2.5.46 / demolition Phase 1.4: pre-turn close-out gate ──
          // The pre-turn system message already gave the agent a chance to
          // engage with the tracker BEFORE generating any response. If they
          // produced text instead of calling a tracker tool, they forfeited the
          // chance. The gate USED TO auto-pause the danglers here and pre-bless
          // the pause (pause_validated=1) so the PM could never re-flag it, a
          // forgery of the PM's key. De-fanged: the danglers keep their TRUE
          // status (one-shots stay in_progress), the recurring janitorial reset
          // stays, and the miss is escalated to the PM (visible A2A) to decide
          // per task. The turn then ends.
          //
          // No "second chance" hard nudge: the prior implementation streamed a
          // second response to the user before the duplicate detector could
          // suppress it, the user saw two responses. One shot, then the turn ends.
          if (
            state.danglingTaskIds.length > 0 &&
            !state.closeOutGateSatisfied
          ) {
            // ── KEEP the agent's reply visible; reconcile the tracker silently ──
            // BUG-2 (comms-audit convergence pass): this gate used to DELETE the
            // just-streamed assistant reply and erase the bubble whenever an
            // UNRELATED idle/stranded tracker task existed, with no human-waiting
            // guard. On the weak-model floor the agent routinely answers a fresh,
            // unrelated human question in plain text (without first calling a
            // tracker_* tool); the gate then ate that answer and the user got
            // silence (inv 2). That is the same silent-drop class as the whole P0,
            // and it contradicts the sibling going-idle hardcap which was already
            // fixed (2026-06-25, ~line 3333) to KEEP the closeout visible. Apply the
            // identical trade here: protecting an internal tracker-consistency
            // invariant the user never sees (they read the chat, not the task table)
            // is NOT worth suppressing a real reply. The reply was already persisted
            // AND streamed earlier this turn, so we simply let it stand and STILL
            // reconcile the danglers below (one-shots stay in_progress + escalate to
            // PM / recurring reset / on_deck left in place). No duplicate risk: there
            // is no second-chance re-prompt here (only one reply was ever generated).
            logger.info('v2: pre-turn close-out gate, keeping the agent reply visible, reconciling danglers in the background', {
              agentId, danglingCount: state.danglingTaskIds.length,
            }, agentId);

            try {
              // Distinguish the two kinds of danglers. One-shot in_progress rows
              // keep their TRUE status (no pause, no stamp); on_deck stragglers
              // stay on_deck, the user can decide whether to reassign or close
              // the project.
              const inProgressIds = db
                .prepare(
                  `SELECT id FROM tasks WHERE id IN (${state.danglingTaskIds.map(() => '?').join(',')}) AND status = 'in_progress'`,
                )
                .all(...state.danglingTaskIds) as Array<{ id: string }>;
              const onDeckIds = state.danglingTaskIds.filter(
                (id) => !inProgressIds.some((r) => r.id === id),
              );

              // Demolition Phase 1.4: the gate no longer PAUSES one-shot danglers
              // or pre-blesses a pause (pause_validated=1). That flag was an
              // engine-authored "PM-blessed" verdict the PM sweep could never
              // re-flag, a forgery of the PM's key. One-shot danglers now stay
              // in_progress and are escalated to the PM (which decides per task).
              // Recurring danglers keep the janitorial reset (a single missed
              // close-out fails THIS run via forceResetStuckRecurringTask, never
              // pausing/closing the whole schedule).
              const { forceResetStuckRecurringTask } = await import('../../scheduler/runner.js');
              const recurringResetIds: string[] = [];
              const oneShotDanglerIds: string[] = [];
              for (const tid of inProgressIds.map((r) => r.id)) {
                const isRecurring = db.prepare(`SELECT repeat_interval FROM tasks WHERE id = ?`).get(tid) as { repeat_interval: number | null } | undefined;
                if (isRecurring?.repeat_interval) {
                  try { forceResetStuckRecurringTask(tid); recurringResetIds.push(tid); } catch { /* best effort */ }
                  continue;
                }
                oneShotDanglerIds.push(tid);
              }

              if (oneShotDanglerIds.length > 0 || recurringResetIds.length > 0 || onDeckIds.length > 0) {
                // Repaint the board (recurring rows changed; one-shots are
                // unchanged but harmless to re-broadcast). No INVISIBLE
                // retrospective note: the old engine-steer-exempt "[System: ...
                // the engine reconciled the danglers ...]" row is deleted. The
                // going-idle menu steer already gave the model its (visible)
                // instruction this turn, and the PM escalation below is a visible
                // A2A; nothing model-facing is owed on this (ending) turn.
                try {
                  const { getTask } = await import('../../tracker/schema.js');
                  for (const tid of state.danglingTaskIds) {
                    const updatedTask = getTask(tid);
                    if (updatedTask) {
                      broadcast({ type: 'tracker:task_updated', data: updatedTask });
                    }
                  }
                } catch { /* best effort */ }
                logger.warn('v2: pre-turn close-out gate unsatisfied, reply kept visible, one-shot danglers left in_progress (no pause, no stamp), recurring reset on schedule', {
                  agentId, oneShotDanglerCount: oneShotDanglerIds.length, recurringResetCount: recurringResetIds.length, onDeckCount: onDeckIds.length, totalDangling: state.danglingTaskIds.length,
                }, agentId);
                // Escalate the one-shot danglers to the PM (visible A2A). They
                // keep their true in_progress status until the PM decides.
                if (oneShotDanglerIds.length > 0) {
                  try {
                    const { escalateCloseoutMissToPM } = await import('../../tracker/pm-agent.js');
                    await escalateCloseoutMissToPM({
                      agentId,
                      danglingTaskIds: oneShotDanglerIds,
                      agentText: persistedContent ?? '',
                      source: 'pre-turn-gate',
                    });
                  } catch (escErr) {
                    logger.warn('v2: pre-turn gate closeout-miss escalation failed (non-fatal)', {
                      agentId, error: escErr instanceof Error ? escErr.message : String(escErr),
                    }, agentId);
                  }
                }
              }
            } catch (escErr) {
              logger.error('v2: close-out one-shot escalation failed', {
                agentId, error: escErr instanceof Error ? escErr.message : String(escErr),
              }, agentId);
            }
            break;
          }

          if (
            state.nudgedForTrackerCloseThisTurn &&
            !state.trackerStatusUpdatedThisTurn
          ) {
            // Hardcap: nudge fired once and was ignored. End the turn.
            // The PM agent will catch the dangling tasks on its next poke pass.
            logger.warn('v2: tracker close-out nudge ignored, ending turn anyway', {
              agentId,
            }, agentId);
            break;
          }

          // Lane separation (attribution redesign §4.5): this nudge re-prompts the
          // model ("close out your open tasks; write NO user-facing text"). On a live
          // conversation turn the model ignores the no-text instruction and re-answers
          // the present user, producing the near-duplicate reply (field-documented
          // below). The deeper problem is the bleed itself: task-closeout is machinery
          // (Lane 2/3), and it has no business re-running the model in the middle of a
          // Lane-1 conversation about something unrelated (the open tasks are usually
          // pre-existing background danglers, not this turn's work). So on a user turn
          // we do NOT re-prompt, the agent answered the user, the turn ends here, and
          // the danglers are caught off the conversation path by the deterministic
          // pre-turn close-out gate next turn and by the PM poke chain (which is where
          // closeout enforcement belongs). The re-prompt remains for non-conversation
          // turns (autonomous / A2A), where any resulting text is already routed to the
          // agent-internal lane and never surfaces to the user.
          if (
            counterparty.kind !== 'user' &&
            !state.nudgedForTrackerCloseThisTurn &&
            !state.trackerStatusUpdatedThisTurn &&
            state.nonTrackerToolCalls > 0
          ) {
            let openTasks: Array<{ id: string; title: string }> = [];
            try {
              const { listTasks } = await import('../../tracker/schema.js');
              const inProgress = listTasks({ status: 'in_progress', assignedTo: agentId });
              openTasks = inProgress.map((t) => ({ id: t.id, title: t.title }));
            } catch (err) {
              logger.warn('Tracker close-out nudge: listTasks failed', {
                agentId, err: err instanceof Error ? err.message : String(err),
              }, agentId);
            }
            if (openTasks.length > 0) {
              const taskList = openTasks
                .map((t) => `  - "${t.title}" (${t.id.slice(0, 8)})`)
                .join('\n');
              // v2.5.42, rewritten to a direct, action-only command.
              // Prior wording was a paragraph with an "or end your turn
              // silently" escape hatch. Field test showed DeepSeek V4 Pro
              // ignoring the escape and re-running the whole response,
              // producing a duplicate reply to the user. The user noticed
              // immediately ("notice that something triggered him to do
              // it twice now"). New wording: tool call ONLY, no text,
              // explicit "do not repeat your prior message" guardrail.
              const nudgeText = (
                `[System: ${openTasks.length} in_progress task${openTasks.length === 1 ? '' : 's'} assigned to you was not closed out this turn:\n` +
                `${taskList}\n` +
                `REQUIRED ACTION: call tracker_complete_step (for multi-step projects) or tracker_update_status (complete | blocked | paused) on each task above. Make ONLY the tool call(s). Do NOT write any user-facing text, the user already received your previous response and a duplicate reply is worse than a stale tracker. ` +
                `If a task is genuinely still in progress, end your turn now with NO text output (no tool call, no message); the engine will continue you on the next user turn.]`
              );
              // RC-19: via persistEngineSteer so the close-out directive reaches the
              // model (pendingNudge) AND keeps its dashboard row. This branch is
              // non-user turns only (any resulting text is routed to the agent-internal
              // lane, see the lane note above), so the bare role='system' row the
              // assembler strips meant the re-prompt never actually reached the model.
              state = persistEngineSteer(
                state,
                { agentId, content: nudgeText, turnNumber, extra: { nudgedForTrackerCloseThisTurn: true } },
                { db, broadcast },
              );
              logger.info('v2: tracker close-out nudge fired', {
                agentId, openTaskCount: openTasks.length,
              }, agentId);
              continue;
            }
          }
        }

        break;
      }

      // ── Engine-injected ack, DISABLED ──
      //
      // The v2 plan called for an engine-written ack ("Working on it…") to fire
      // when the agent goes straight to a tool call without text. In practice
      // this turned out to be both noise AND structurally broken: the ack was
      // persisted as a system message into the messages table BETWEEN the
      // assistant's tool_use and its matching tool_result, which violates the
      // conversation invariant (tool_use and tool_result must be in adjacent
      // messages). The assembler's defensive `sanitizeToolPairs` would then
      // drop both messages from context, and the model would re-issue the
      // tool call on the next turn because it lost memory of running it.
      //
      // The chat:tool_call broadcast (fired by executePhase below) already
      // serves the "agent is working" signal. The ack adds no information
      // and broke the conversation invariant. Removed 2026-05-04.
      //
      // INVARIANT (Part XIX, sharpened): never insert any persisted message
      // between an assistant tool_use and its matching tool_result. If we
      // ever want a transient "thinking" indicator, it must be broadcast-only,
      // never written to the messages table.
      //
      // The `ackInjector` classifier (agent/v2/classifiers/ack.ts) and its
      // tests are kept for potential future use as a broadcast-only path.

      // Engine-side tracker enforcement lives in the runtime nudge + engine
      // floor below (search "Runtime tracker nudge"); the v2.0.0-era classifier
      // (agent/v2/classifiers/tracker.ts) was never wired to side effects and
      // its intent is served there, so it was removed in v3.1.11 (FN-9).

      // ── Phase: execute tools (partitioned) ──
      state = advance(state, { phase: 'execute' });
      const batches = partitionTools(result.toolCalls);
      const turnToolResults: Array<{
        toolCallId: string;
        name: string;
        content: string;
        isError: boolean;
        contentBlocks?: Array<{ type: string; [key: string]: unknown }>;
      }> = [];

      let stoppedMidBatch = false;
      let calledCompleteTask = false;
      let calledFireAndForgetGen = false;
      // P3 once-per-response guard (lanes & lineage): a NON-IDEMPOTENT call
      // signature (fire-and-forget generation, people-channel send) executes
      // AT MOST ONCE per model response. Maps signature -> short first-result
      // note; a second identical call in the SAME response returns a
      // structured result naming the first execution instead of re-running
      // the side effect (the four-images / double-send class). Exact
      // signature only; different args execute; repeats across RESPONSES are
      // governed by the loop detector and brake, unchanged.
      const onceGuardExecuted = new Map<string, string>();
      let recentSigs = state.recentToolSignatures;

      outer: for (const batch of batches) {
        if (stoppedMidBatch) break;

        // Per-call processing (used in both parallel and serial paths).
        const runOne = async (tc: ToolCall) => {
          // ── Technique-acknowledgement gate (v2.7.6) ──
          // D6: the technique-acknowledgement HARD GATE is removed. It used to
          // refuse EVERY tool except a 7-tool allowlist until the agent wrote a
          // >=100-char paraphrase, a persistent, cross-turn GLOBAL tool lock that
          // (a) deadlocked with the close-out gate (their allowlists were disjoint,
          // so with both armed every tool was refused by one or the other), and
          // (b) survived turns via agents.config, so an unrelated "what's on my
          // calendar?" tomorrow was refused tool-by-tool with no expiry. A forced
          // paraphrase doesn't make a model comply (it emits boilerplate); the
          // inline injection of the technique text (see the technique-injection
          // block earlier in the turn) already puts the technique in front of the
          // model. technique_acknowledge remains an OPTIONAL affordance the agent
          // may call; it just no longer blocks anything. Cross-turn hydration and
          // the config persistence are dropped too (see initialPendingTechniqueAck
          // and the arming site).

          // On an A2A turn, send_to_agent / broadcast_to_group IS the agent's
          // single legitimate reply, it must never be thrash-gated. The gates'
          // premise ("stop verifying, respond to the USER with text") doesn't
          // apply: there is no user, and A2A-turn text is suppressed, so blocking
          // the reply leaves the agent with no valid exit and it loops (observed:
          // 12 send_to_agent calls ignoring the STOP). The hard turn-end after a
          // successful send (further below) keeps this single-shot, so exempting
          // it from the gates cannot itself cause a loop.
          const isA2AReplyTool =
            counterparty.kind === 'agent' && (tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group');

          // P6a: publish the executing call id for the execution-record writers.
          currentToolCallId.set(agentId, tc.id);

          // Loop-break check
          const loopCheck = loopDetector(tc, recentSigs);
          recentSigs = bumpLoopSignature(recentSigs, loopCheck.signature, RECENT_TOOL_WINDOW);
          if (loopCheck.decision === 'block' && !isA2AReplyTool) {
            loopBlockFiredThisTurn = true;
            try {
              broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
              broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: loopCheck.refusalMessage!.slice(0, 500) });
            } catch { /* best effort */ }
            return {
              toolCallId: tc.id,
              name: tc.name,
              content: loopCheck.refusalMessage! + '\n\n' + ENGINE_BLOCK_ESCAPE_HATCH,
              isError: true,
            };
          }

          // ── P3 once-per-response guard (non-idempotent duplicate) ──
          const isNonIdempotent = FIRE_AND_FORGET_GEN_TOOLS.has(tc.name) || SEND_TO_PEOPLE_SET.has(tc.name);
          if (isNonIdempotent && onceGuardExecuted.has(loopCheck.signature)) {
            return {
              toolCallId: tc.id,
              name: tc.name,
              content:
                `Already executed in this response: an identical ${tc.name} call ran moments ago and its side effect is real ` +
                `(${onceGuardExecuted.get(loopCheck.signature)}). It was NOT run again; re-running would duplicate the ` +
                `send/generation. Reference the first result. If you genuinely intend a second identical ${tc.name}, ` +
                `issue it in your NEXT response.`,
              isError: true,
            };
          }

          // ── Reminder-delivery lane + owner-drift arm (destination-from-root) ──
          // Two refuse-once guards on channel sends, each costing legitimate
          // work at most one corrective round (an identical re-send proceeds):
          //  1. Reminder lane: this turn serves a kind='reminder' task (read
          //     structurally off the claimed trigger's task_id, migration 112).
          //     Reminder output belongs to the OWNER; a send naming someone who
          //     is not the owner is refused once with guidance ("remind my
          //     wife" repeats and goes through).
          //  2. Owner-drift, GENERAL form (P6 destination-from-root; the battery
          //     found the A2A gap: an A2A-poked turn about owner-rooted work
          //     texted the owner a completion report while the owner sat at the
          //     dashboard, and the old engine-served-only arm never fired). Any
          //     turn, ANY lane (engine, A2A, dashboard): a send TO the owner
          //     while the owner is IN the dojo belongs in chat, unless the turn
          //     itself is rooted in the owner's own text conversation (the
          //     owner texted us; replying in-channel is the conversation).
          if ((tc.name === 'imessage_send' || tc.name === 'sms_send')) {
            const served = currentTurnServedWork.get(agentId);
            const a = (tc.arguments ?? {}) as Record<string, unknown>;
            const recip = String(a.recipient ?? a.to ?? '').trim();
            const recipIsOwner = recip ? recipientIsChannelOwner(tc.name, recip) : false;
            if (served?.taskKind === 'reminder' && recip && !recipIsOwner) {
              const laneSig = `${tc.name}|${recip}`;
              if (!reminderLaneRefusedSigs.has(laneSig)) {
                reminderLaneRefusedSigs.add(laneSig);
                return {
                  toolCallId: tc.id,
                  name: tc.name,
                  content:
                    `Refused once: this turn is delivering the owner's reminder, and "${recip}" is not the owner. ` +
                    `Reminders are delivered to the owner: reply in chat (the owner is watching the dashboard conversation this reminder came from), ` +
                    `or send to the owner's own address. If the owner explicitly asked for this reminder to be delivered to "${recip}", ` +
                    `repeat the exact same send and it will go through.`,
                  isError: true,
                };
              }
            } else if (
              recip && recipIsOwner && getPresence() === 'in_dojo' &&
              !(counterparty.kind === 'user' && counterparty.relation === 'owner' &&
                (counterparty.channel === 'imessage' || counterparty.channel === 'sms'))
            ) {
              const driftSig = `owner-drift|${tc.name}|${recip}`;
              if (!reminderLaneRefusedSigs.has(driftSig)) {
                reminderLaneRefusedSigs.add(driftSig);
                const rootNote = served?.originConvKey === 'owner'
                  ? 'This work was asked for in the owner\'s dashboard conversation and the owner is currently IN the dojo'
                  : 'The owner is currently IN the dojo (at the dashboard)';
                return {
                  toolCallId: tc.id,
                  name: tc.name,
                  content:
                    `Refused once: ${rootNote}, so deliver this to the owner as your chat reply (just say it); ` +
                    `no channel send is needed. ` +
                    `If the owner explicitly asked to be texted, repeat the exact same send and it will go through.`,
                  isError: true,
                };
              }
            }
          }

          // ── A2A re-send cap (per recipient per turn) ──
          // Inter-agent replies are ASYNC, the recipient answers on its OWN
          // later turn, never synchronously in this one. An agent that doesn't
          // get an instant reply re-sends the same ask, REWORDING it each time,
          // which defeats the content-signature dedup (every rewording is a new
          // signature) and spams the recipient (observed: 29 send_to_agent calls
          // to one agent in a single turn). Cap it at A2A_SEND_CAP_PER_RECIPIENT
          // per recipient per turn, set well ABOVE any genuine case (two distinct
          // messages to one agent, a retry after a transient failure) so it only
          // catches a pathological re-send loop, never real multi-send. Different
          // recipients are independent, and the first several sends always pass.
          if (tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group') {
            const a = (tc.arguments ?? {}) as Record<string, unknown>;
            const recip = String(
              a.to_agent ?? a.agent ?? a.to ?? a.recipient ?? a.group ?? a.group_id ?? '',
            ).trim().toLowerCase();
            if (recip && (state.sendsPerAgentThisTurn[recip] ?? 0) >= A2A_SEND_CAP_PER_RECIPIENT) {
              const refusal =
                `[System: you have already sent "${recip}" ${A2A_SEND_CAP_PER_RECIPIENT} messages this turn. ` +
                `Inter-agent replies are ASYNCHRONOUS, "${recip}" answers on their OWN next turn, not in this one. ` +
                `Re-sending the same ask (even reworded) does NOT get a faster reply; it only spams them. ` +
                `End your turn now; you will see their reply when it arrives. ${ENGINE_BLOCK_ESCAPE_HATCH}]`;
              try {
                broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
                broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: refusal.slice(0, 500) });
              } catch { /* best effort */ }
              logger.info('v2: A2A re-send cap, recipient over per-turn cap', {
                agentId, recipient: recip, cap: A2A_SEND_CAP_PER_RECIPIENT,
              }, agentId);
              return { toolCallId: tc.id, name: tc.name, content: refusal, isError: true };
            }
          }

          // ── Thrash-gate refusal (per-canonical-signature) ──
          // The iteration-top thrash detector added this signature to the
          // gate when it caught the agent repeating the same call. The
          // gate refuses ONLY this exact (tool, normalized_args) combo, 
          // the agent can keep calling the same tool with DIFFERENT args.
          // The refusal message names the exact call so DeepSeek can't
          // miss it (unlike a buried system message). Refusal count tracks
          // how many times the agent ignored the gate.
          if (state.thrashGatedSignatures.length > 0 && !isA2AReplyTool) {
            const thisSig = canonicalToolSignature(tc.name, tc.arguments);
            if (state.thrashGatedSignatures.includes(thisSig)) {
              const argsPart = thisSig.includes(':') ? thisSig.slice(thisSig.indexOf(':') + 1) : '{}';
              const refusal =
                `BLOCKED by engine thrash gate, \`${tc.name}(${argsPart})\` is refused. ` +
                `You've already called this exact signature multiple times and have the result from the first call.\n\n` +
                `Pick a different next action:\n` +
                `  (a) Call \`${tc.name}\` with DIFFERENT args (a different id / target) if you have more to read.\n` +
                `  (b) Call tracker_update_status(status='complete', result='...', evidence=[...]) using the data you've already gathered.\n` +
                `  (c) Call tracker_update_status(status='blocked', notes='<specific obstacle>') if you genuinely cannot proceed.\n` +
                `  (d) Send the user a direct question if you need clarification.\n\n` +
                ENGINE_BLOCK_ESCAPE_HATCH;
              state = advance(state, { thrashGateRefusalCount: state.thrashGateRefusalCount + 1 });
              logger.warn('v2: thrash gate refused tool call', {
                toolName: tc.name, signature: thisSig,
                refusalCount: state.thrashGateRefusalCount,
              }, agentId);
              try {
                broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
                broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: refusal.slice(0, 500) });
              } catch { /* best effort */ }
              return {
                toolCallId: tc.id,
                name: tc.name,
                content: refusal,
                isError: true,
              };
            }
          }
          // ── Anti-hoarding gate (v2.5.43) ──
          // Refuse loading-tool calls past LOADING_GATE_THRESHOLD when no
          // structuring (tracker_create_*, file_write/append/patch,
          // scratchpad_set, tracker_update_status, etc.) has happened
          // this turn. Engine enforcement of the corpus-synthesis pattern
          //, prompt-level guidance was being ignored on prod by
          // DeepSeek V4 Pro. See classifiers/hoarding.ts for full
          // rationale. The structuring call itself is NEVER refused
          // (we check loading-only), and once any structuring happens
          // the gate is permanently off for the rest of the turn.
          //
          // v2.7.8, carve-out: trainer reading from its own techniques
          // directory doesn't count. The trainer's job IS reading the
          // technique files it manages; the gate fired on a trainer
          // doing exactly that (reading the 4 scripts + TECHNIQUE.md
          // of its own technique) and forced it to open a confused
          // "Edit Technique" tracker for what was a one-shot ask.
          // D3: anti-hoarding is now a NON-BLOCKING compaction-proximity advisory,
          // not a count-based refusal. The old gate refused the (THRESHOLD+1)th
          // read of a turn until a tracker/file write landed, which blocked
          // legitimate multi-source work ("check my inboxes", 6-source research,
          // exec-heavy asks), taxed weak models by effort-count (a weaker model
          // needs MORE reads for the same job), and even demanded "open a tracker
          // project" in order to read email. The real hazard is context PRESSURE
          // (loaded sources summarized into confabulation at compaction), which the
          // engine already measures (lastContextRatio). So when many unscaffolded
          // loads have happened AND context is genuinely near compaction, nudge
          // ONCE (advice, framed as an engine hint, never a refusal) to write the
          // sources down now, then let the read through. Reads are never blocked.
          // The count (heavyLoadsThisTurn) reflects the SIZE of prior results this
          // turn (see the post-result accounting below); the trigger no longer
          // keys on whether THIS call is a "loading tool" (that name-set is gone).
          // We only skip nudging on the very call that structures (isStructuringTool),
          // since telling the agent to write things down as it writes them down is
          // noise; !structuringToolCalledThisTurn already covers "already structured".
          if (
            !state.structuringToolCalledThisTurn &&
            !state.nudgedForHoardingThisTurn &&
            !isStructuringTool(tc.name) &&
            state.heavyLoadsThisTurn >= LOADING_GATE_THRESHOLD &&
            state.lastContextRatio >= 0.85
          ) {
            const nudge = (
              `[Engine hint: you've pulled ${state.heavyLoadsThisTurn} sources into context this turn and ` +
              `memory is about ${(state.lastContextRatio * 100).toFixed(0)}% full. Compaction may soon summarize ` +
              `the older ones, and a deliverable written from a summary rather than the source can drift. If there ` +
              `are facts here you'll rely on, jot them into scratchpad_set / a file_write / a tracker note now so ` +
              `they survive. This is advice, not a block, keep going.]`
            );
            // Phase 0.4: route the [Engine hint] through persistEngineSteer so the
            // advice reaches the model (pendingNudge, injected as a synthetic user
            // message next iteration) AND keeps the dashboard row. The old bare
            // role='system' INSERT was stripped by the assembler, so the advisory
            // never reached the model at all (INVISIBLE by choice, but the model
            // could not act on advice it never saw). This stays ADVICE, not a block:
            // the tool still executes below (no refusal, no `continue`), the nudge
            // just rides along to the next iteration. Already gated once per turn by
            // nudgedForHoardingThisTurn.
            state = persistEngineSteer(
              state,
              { agentId, content: nudge, turnNumber, extra: { nudgedForHoardingThisTurn: true } },
              { db, broadcast },
            );
            logger.info('v2: hoarding advisory nudged (non-blocking)', {
              agentId, tool: tc.name, heavyLoads: state.heavyLoadsThisTurn, ratio: state.lastContextRatio,
            }, agentId);
            // Fall through: the tool executes normally. No refusal.
          }
          // ── Pre-turn close-out gate (v2.5.46) ──
          // Refuse non-tracker tool calls when the agent has dangling
          // in_progress tasks from a previous turn. The agent MUST
          // engage with the tracker (status update, complete_step, or
          // add_notes for "still working") before doing other work.
          // Once any qualifying tracker call lands, the gate disengages
          // for the rest of the turn (re-arms next turn if there are
          // still danglers).
          //
          // HAND-PICKED, NOT DERIVABLE, and legitimately so: this is a tracker-
          // FAMILY allowlist (the stable tracker_* surface plus load_tool_docs so
          // the agent can fetch a close-out tool's schema). Its domain is the
          // tracker family, which does not span the google/microsoft/_ms/user_
          // tool explosion that drifts, so it does not have the defect-class
          // disease. No display/effect classifier encodes "counts as engaging
          // with your dangling tasks"; that is exactly this gate's private rule.
          const CLOSE_OUT_TRACKER_TOOLS = new Set([
            'tracker_update_status',
            'tracker_complete_step',
            'tracker_add_notes',
            'tracker_close_project',      // bulk-resolve a whole stranded project
            'tracker_get_status',         // read-only allowed (investigate before resolving)
            'tracker_list_active',        // ditto
            'tracker_edit_task',           // editing the task counts as engagement
            'tracker_pause_schedule',
            'tracker_resume_schedule',
            'tracker_resolve_missed_runs',
            'load_tool_docs',              // schema lookup must work, agents may need to fetch
                                           // schemas for the close-out tools above before calling them
          ]);
          if (
            state.danglingTaskIds.length > 0 &&
            !state.closeOutGateSatisfied &&
            !CLOSE_OUT_TRACKER_TOOLS.has(tc.name)
          ) {
            const taskListShort = state.danglingTaskIds.slice(0, 5).map((id) => id.slice(0, 8)).join(', ');
            const refusalText = (
              `Refused: engine close-out gate. You have ${state.danglingTaskIds.length} in_progress ` +
              `task(s) from a previous turn that you never closed (ids: ${taskListShort}${state.danglingTaskIds.length > 5 ? '...' : ''}). ` +
              `Before any other tool call, resolve at least one with tracker_complete_step, ` +
              `tracker_update_status (complete | blocked | paused), or, if you're genuinely still working ` +
              `on it across turns, tracker_add_notes to signal "in flight." After ANY one of those, the gate ` +
              `disengages for the rest of this turn and "${tc.name}" will work normally. ` +
              `Results already delivered to the user must NOT be repeated; after your tracker call, reply [no-reply] unless the user asked something new.\n\n` +
              ENGINE_BLOCK_ESCAPE_HATCH
            );
            try {
              broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
              broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: refusalText.slice(0, 500) });
            } catch { /* best effort */ }
            logger.info('v2: close-out gate refused call', {
              agentId, tool: tc.name, danglingCount: state.danglingTaskIds.length,
            }, agentId);
            return {
              toolCallId: tc.id,
              name: tc.name,
              content: refusalText,
              isError: true,
            };
          }
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
          // If the agent is taking a qualifying tracker action this
          // turn (status update, complete_step, add_notes, close_project),
          // disengage the close-out gate for the remainder of the turn.
          // They can keep resolving the other dangling tasks but they're
          // no longer forced to.
          if (
            state.danglingTaskIds.length > 0 &&
            !state.closeOutGateSatisfied &&
            (tc.name === 'tracker_update_status' || tc.name === 'tracker_complete_step' || tc.name === 'tracker_add_notes' || tc.name === 'tracker_close_project')
          ) {
            state = advance(state, { closeOutGateSatisfied: true });
            logger.info('v2: close-out gate satisfied', { agentId, tool: tc.name }, agentId);
          }
          // Thrash-gate clear on any tracker transition. Any successful
          // tracker_update_status (complete/blocked/paused/in_progress) is
          // forward progress, the gate's purpose was to force the agent
          // to wrap up, so wrapping up clears it.
          if (
            (tc.name === 'tracker_update_status' || tc.name === 'tracker_complete_step' || tc.name === 'tracker_close_project') &&
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
          if (isStructuringTool(tc.name)) {
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
                return { toolCallId: tc.id, name: tc.name, content: refusal, isError: heldIsError };
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

          // First-tool hook for the work-gated start ack: real work is now
          // beginning. If the user has already been waiting past the ack
          // threshold (a slow model that thought before acting), speak now;
          // under the threshold the armed timer handles it.
          if (!anyToolStartedThisTurn) {
            anyToolStartedThisTurn = true;
            if (startAckArmed && !engineStartAckDeliveredThisTurn &&
                Date.now() - startAckArmedAtMs > ENGINE_START_ACK_AFTER_MS) {
              void fireStartAckIfOwed('first-tool');
            }
          }
          // Execute (with safety wrapper)
          let toolResult;
          // Identical-call brake, pre-execution half: an exact call that has
          // already failed REFUSE_AT times this turn is not executed again
          // (no side effects, no provider cost); the refusal text is the result.
          const brakeSig = identicalCallSignature(tc.name, tc.arguments);
          const refusal = toolPhaseEndedBySpinBrake
            ? '[Engine: the tool phase for this turn ended after an identical call was refused repeatedly. No further tools will run this turn. Answer in text with what you have.]'
            : checkIdenticalCallRefusal(identicalCallState, brakeSig);
          try {
            if (refusal) {
              toolResult = { toolCallId: tc.id, name: tc.name, content: refusal, isError: true };
              if (!toolPhaseEndedBySpinBrake) {
                logger.warn('v2: identical-call brake refused re-execution', {
                  agentId, tool: tc.name, sig: brakeSig.slice(0, 120),
                }, agentId);
                if (isSignatureTerminal(identicalCallState, brakeSig)) {
                  // Refused, taught, and resubmitted unchanged three times:
                  // nothing real is blocked (nothing was executing); stop
                  // paying for attempts that cannot succeed. Text untouched.
                  toolPhaseEndedBySpinBrake = true;
                  logger.warn('v2: spin brake TERMINAL, tool phase ended for this turn (identical refused call resubmitted repeatedly)', {
                    agentId, tool: tc.name, sig: brakeSig.slice(0, 200),
                  }, agentId);
                }
              }
            } else {
              toolResult = await executeTool(agentId, tc);
            }
            // P3 once-guard, post-result half: a SUCCESSFUL non-idempotent
            // execution registers its signature for the rest of this response.
            if ((FIRE_AND_FORGET_GEN_TOOLS.has(tc.name) || SEND_TO_PEOPLE_SET.has(tc.name)) && toolResult.isError !== true) {
              const preview = typeof toolResult.content === 'string' ? toolResult.content.slice(0, 140) : 'executed';
              onceGuardExecuted.set(loopCheck.signature, preview);
            }
            // Identical-call brake, post-result half: count consecutive identical
            // failures; at WARN_AT append the corrective notice so the model
            // changes course; a success resets the signature.
            {
              const errText = typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content ?? '');
              const brakeNotice = recordIdenticalCallResult(identicalCallState, brakeSig, toolResult.isError === true, errText);
              if (brakeNotice && typeof toolResult.content === 'string') {
                toolResult = { ...toolResult, content: toolResult.content + brakeNotice };
              }
            }
            // Transfer content blocks from the tool call (set by file_read for images/PDFs)
            const contentBlocks = (tc as unknown as Record<string, unknown>).__contentBlocks as
              | Array<{ type: string; [key: string]: unknown }>
              | undefined;
            if (contentBlocks) {
              (toolResult as { contentBlocks?: unknown }).contentBlocks = contentBlocks;
            }
            // v2.5.9, Just-in-time visibility hint. When a tool result
            // contains a URL or a shared-uploads file path, append a small
            // informational note reminding the agent that tool results are
            // only visible to itself, not to the user. Informational only, 
            // does NOT pressure the agent to share anything, just makes
            // sure it knows the user can't "see above". Skips sub-agents
            // (their results go to their parent agent, not the user).
            if (isPrimaryAgent(agentId)) {
              toolResult = appendVisibilityHintIfRelevant(toolResult);
            }
            // v2.7.22, soft nudge toward [no-reply] after bookkeeping tools.
            // C22: NEVER append this nudge on a turn serving a waiting human. On the
            // weak model, "Booked for Tuesday." + tracker_update_status in one iteration
            // defers the text (G-SUP-2); the tool result then carries the "end with
            // [no-reply]" nudge; iteration 2 emits [no-reply] as instructed → the REG-3
            // clear discards the deferred genuine answer → the user gets silence. Gating
            // on !triggerRow && !hasUnansweredUser confines the nudge to engine/background
            // turns where silence is the correct outcome, stopping the conflict at the
            // source rather than hoping the reworded prompt holds on a weak model.
            if (!triggerRow && !hasUnansweredUser) {
              // When this close targets a still-unanswered USER-REQUESTED task, the
              // note must ask for the outcome + link, not offer [no-reply] (which is
              // what let the floor model close a user-requested doc task and go
              // silent). An already-answered cross-turn close falls back to the
              // generic note (silence is correct there).
              const userRequestedClose = userRequestedCloseWantsReply(
                tc.name, (tc.arguments ?? {}) as Record<string, unknown>, agentId,
              );
              toolResult = appendBookkeepingNudgeIfRelevant(toolResult, userRequestedClose);
            }
          } catch (toolErr) {
            const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            logger.error('v2: tool crashed', { tool: tc.name, error: errMsg }, agentId);
            toolResult = {
              toolCallId: tc.id,
              name: tc.name,
              content: `Error: Tool "${tc.name}" crashed: ${errMsg}. Try a different approach or skip this step.`,
              isError: true,
            };
          }

          // Cross-turn attempt record (Invariant II): failures accumulate in
          // the DB by canonical signature; a success clears its signature.
          // When the SAME call keeps failing across separate turns, the
          // failing result carries a note so the model stops re-trying it
          // verbatim ("works in circles" had no cross-turn guard at all).
          try {
            const crossTurnSig = canonicalToolSignature(tc.name, tc.arguments);
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

          state = advance(state, {
            toolCallsExecutedThisTurn: state.toolCallsExecutedThisTurn + 1,
            // Success-only, same discipline as the once-guard: a failed call
            // performed no side effect and must not block the abort re-arm.
            nonIdempotentCallsThisTurn: state.nonIdempotentCallsThisTurn +
              ((toolResult.isError !== true &&
                (classifyTool(tc.name) === 'effectful-action' ||
                 FIRE_AND_FORGET_GEN_TOOLS.has(tc.name) ||
                 SEND_TO_PEOPLE_SET.has(tc.name))) ? 1 : 0),
          });

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
            !isStructuringTool(tc.name) &&
            !isLoadCountExemptRead(tc.name) &&
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
              // RC-1: cross-recipient iMessage → dual-home the sent text into the
              // recipient's conversation so their next turn can see the question.
              if (!toCp && imArgRecip != null) {
                const recip = String(imArgRecip).trim();
                persistCrossConvSendEcho('imessage', recip, resolveRecipientDisplay('imessage', recip), 'iMessage',
                  String(tc.arguments?.message ?? tc.arguments?.text ?? tc.arguments?.body ?? ''));
              }
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
              // RC-1: cross-recipient SMS → dual-home the sent text.
              if (!toCp && smsArgNum != null) {
                const recip = String(smsArgNum).trim();
                persistCrossConvSendEcho('sms', recip, resolveRecipientDisplay('sms', recip), 'SMS',
                  String(tc.arguments?.body ?? tc.arguments?.message ?? tc.arguments?.text ?? ''));
              }
            } else if (tc.name === 'gmail_send' || tc.name === 'outlook_send') {
              // RC-1: an explicit email SEND (not a reply) to someone other than an
              // email counterparty. Replies (gmail_reply/outlook_reply) inherently
              // target the inbound thread and are handled above; a fresh send names
              // its own recipient, so dual-home it when that recipient isn't the
              // person this turn is answering. Does NOT touch explicitSendThisTurn
              // (email auto-route is reply-only; a fresh send never triggers it).
              const cpEmail = counterparty.kind === 'user' && counterparty.channel === 'email' ? counterparty.senderId : null;
              const emailArgTo = tc.arguments?.to;
              const toCp = cpEmail == null || emailArgTo == null || String(emailArgTo).trim() === '' || recipientIdsMatch(emailArgTo, cpEmail);
              if (!toCp && emailArgTo != null) {
                const recip = String(emailArgTo).trim();
                const subject = String(tc.arguments?.subject ?? '').trim();
                const body = String(tc.arguments?.body ?? '').trim();
                const sentText = subject ? `${subject}: ${body.slice(0, 300)}` : body.slice(0, 300);
                persistCrossConvSendEcho('email', recip, resolveRecipientDisplay('email', recip), 'email', sentText);
              }
            }
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
              let sendMarkerLabel: string | null = null;
              let sendDelivery: Omit<DeliveryInput, 'agentId'> | null = null;
              if (tc.name === 'imessage_send') {
                const to = String(tc.arguments?.to ?? tc.arguments?.recipient ?? tc.arguments?.handle ?? '').trim()
                  || (counterparty.kind === 'user' && counterparty.channel === 'imessage' ? (counterparty.senderId ?? '') : '');
                if (to) {
                  sendMarkerLabel = `iMessage to ${resolveRecipientDisplay('imessage', to)}`;
                  sendDelivery = { tool: tc.name, channel: 'imessage', outcome: 'delivered', recipientId: to, recipientDisplay: resolveRecipientDisplay('imessage', to) };
                }
              } else if (tc.name === 'sms_send') {
                const to = String(tc.arguments?.to ?? tc.arguments?.number ?? tc.arguments?.recipient ?? '').trim()
                  || (state.inboundContext?.smsFromNumber ?? '');
                if (to) {
                  sendMarkerLabel = `SMS to ${resolveRecipientDisplay('sms', to)}`;
                  sendDelivery = { tool: tc.name, channel: 'sms', outcome: 'delivered', recipientId: to, recipientDisplay: resolveRecipientDisplay('sms', to) };
                }
              } else if (tc.name === 'gmail_send' || tc.name === 'outlook_send') {
                const to = String(tc.arguments?.to ?? '').trim();
                if (to) {
                  sendMarkerLabel = `email to ${resolveRecipientDisplay('email', to)}`;
                  // A fresh outbound email is a NEW thread; its conversation
                  // resolves at (channel, provider, recipient, null thread).
                  sendDelivery = { tool: tc.name, channel: 'email', outcome: 'delivered', recipientId: to, recipientDisplay: resolveRecipientDisplay('email', to), provider: tc.name === 'gmail_send' ? 'gmail' : 'outlook' };
                }
              }
              if (sendMarkerLabel) persistRoutingMarker(sendMarkerLabel, sendDelivery ?? undefined);
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
                    const m = toolResult.content.match(/^══ TECHNIQUE FRESH READ ══ (.+?) \(/);
                    if (m) displayName = m[1];
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
              const { getAgentPermissions } = await import('../permissions.js');
              const { getFilteredTools } = await import('../tools.js');
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
          // Broadcast result
          try {
            broadcast({
              type: 'chat:tool_result',
              agentId,
              tool: tc.name,
              result: toolResult.content.slice(0, 500),
            });
          } catch { /* best effort */ }
          // FN-8: only a SUCCESSFUL complete_task is a lifecycle exit. When the
          // engine guard refuses the call (a persistent agent that shouldn't be
          // able to self-terminate emitted it), the tool returns an error and the
          // agent is NOT terminated, so the loop must keep running to let it act
          // on the guidance (report the block / use tracker_update_status) rather
          // than end the turn silently. Mirrors the fire-and-forget check below.
          if (tc.name === 'complete_task' && !toolResult.isError) calledCompleteTask = true;
          // Only a SUCCESSFUL generator call is terminal (the job started and
          // the asset arrives later via async delivery). An error result, 
          // e.g. the param validator kicking the call back for a missing or
          // out-of-range value, must NOT exit the loop, or the agent never
          // gets the turn it needs to re-call with corrected values.
          if (FIRE_AND_FORGET_GEN_TOOLS.has(tc.name) && !toolResult.isError) calledFireAndForgetGen = true;
          return toolResult;
        };

        if (batch.category === 'safe') {
          // Parallel execution for safe reads
          const results = await Promise.all(batch.calls.map(runOne));
          turnToolResults.push(...results);
        } else {
          // Serial execution for everything else
          for (const tc of batch.calls) {
            // Stop check between each serial call
            if (stoppedAgents.has(agentId)) {
              stoppedAgents.delete(agentId);
              // Fill synthetic Cancelled for remaining calls (Part XIX preservation)
              const remaining = batch.calls.slice(batch.calls.indexOf(tc));
              for (const rem of remaining) {
                turnToolResults.push({
                  toolCallId: rem.id,
                  name: rem.name,
                  content: 'Cancelled by user (agent stopped).',
                  isError: true,
                });
              }
              stoppedMidBatch = true;
              break outer;
            }
            const r = await runOne(tc);
            turnToolResults.push(r);
          }
        }
      }

      // Update state with new signatures + results
      state = advance(state, {
        recentToolSignatures: recentSigs,
        toolResults: state.toolResults.concat(turnToolResults),
      });

      // ── Persist tool results ──
      // XML-fallback path (matches v1 runtime.ts:1542-1570): collapse tool
      // calls + results into a single plain-text assistant message and
      // broadcast that. The DB INSERT is IGNORE'd because messageId is the
      // same as the assistant message we already persisted (text-only above);
      // the broadcast carries the user-facing collapsed view. Net effect:
      // model context has plain text only, dashboard shows tool calls + results.
      if (hasXmlFallbackTools) {
        const collapsedParts: string[] = [];
        if (persistedContent) collapsedParts.push(persistedContent);
        for (let i = 0; i < result.toolCalls.length; i++) {
          const tc = result.toolCalls[i];
          const tr = turnToolResults[i];
          const argJson = JSON.stringify(tc.arguments);
          collapsedParts.push(`[Called ${tc.name}: ${argJson}]`);
          if (tr) {
            collapsedParts.push(`[Result${tr.isError ? ' ERROR' : ''}: ${tr.content}]`);
          }
        }
        const collapsedTextRaw = collapsedParts.join('\n');
        // NEXT-WAVE item 5 (rule 6): this is the DeepSeek/floor-model path (the very
        // one that constructs `sshpass -p '<pw>'`), and collapsedText inlines the
        // tool ARGS + RESULTS as plain text. Scrub any credential value the agent
        // pulled via credential_get out of the persisted + broadcast copy. The live
        // command already ran with the real value; only the stored/shown copy is
        // redacted. No-op when the agent has pulled no credentials this process.
        const collapsedText = hasHandedCredentialValues(agentId)
          ? redactHandedCredentials(agentId, collapsedTextRaw)
          : collapsedTextRaw;
        // Same messageId as the assistant first-persist, INSERT OR IGNORE
        // keeps the original text-only row intact.
        if (interAgentTurn) {
          // D-A step 8: the weak-model (XML-fallback) own-output on an inter-agent
          // iteration relocates to the store too, so the DeepSeek floor path never
          // leaks collapsed tool narration into the owner's chat.
          insertInterAgentOwnOutput({
            id: messageId,
            agentId,
            role: 'assistant',
            content: collapsedText,
            turnNumber,
          });
        } else {
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, token_count, model_id, cost, latency_ms, turn_number, created_at)
            VALUES (?, ?, 'assistant', ?, ?, ?, NULL, NULL, ?, datetime('now'))
          `).run(
            messageId,
            agentId,
            collapsedText,
            result.outputTokens,
            effectiveModelIdForPersist,
            turnNumber,
          );
        }
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: messageId,
            agentId,
            role: 'assistant' as Message['role'],
            content: collapsedText,
            tokenCount: null,
            modelId: effectiveModelIdForPersist,
            cost: null,
            latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
        logger.info('v2: collapsed XML-fallback tool calls into plain text', {
          toolCount: result.toolCalls.length,
          tools: result.toolCalls.map((tc) => tc.name),
        }, agentId);
      } else {
        // Normal path: persist as a separate `tool` role message with
        // structured tool_result blocks. If a tool result has contentBlocks
        // (e.g. file_read on an image), use those instead of plain string, 
        // the model sees the image via vision capabilities.
        const toolMessageId = uuidv4();
        const toolResultContent = turnToolResults.map((tr) => {
          const blocks = (tr as { contentBlocks?: Array<{ type: string; [key: string]: unknown }> }).contentBlocks;
          return {
            type: 'tool_result' as const,
            tool_use_id: tr.toolCallId,
            content: blocks
              ? (blocks as unknown as Anthropic.ToolResultBlockParam['content'])
              : tr.content,
            is_error: tr.isError,
          };
        }) as Anthropic.ToolResultBlockParam[];
        const toolResultJson = JSON.stringify(toolResultContent);
        if (interAgentTurn) {
          // D-A step 8: the inter-agent turn's tool_result rows relocate to the
          // store alongside their assistant tool_use rows (same per-phase
          // interAgentTurn classification), so a coordination burst's tool pills
          // never bury or leak into the owner's chat. The merged tail UNIONs them
          // back with role='tool', so the tool_use/tool_result pairing the model
          // sees on its next turn is byte-identical.
          insertInterAgentOwnOutput({
            id: toolMessageId,
            agentId,
            role: 'tool',
            content: toolResultJson,
            turnNumber,
          });
        } else {
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
            VALUES (?, ?, 'tool', ?, ?, datetime('now'))
          `).run(toolMessageId, agentId, toolResultJson, turnNumber);
        }
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: toolMessageId, agentId, role: 'tool' as Message['role'],
            content: JSON.stringify(toolResultContent),
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
      }

      clearErrors(agentId);

      if (stoppedMidBatch) {
        setAgentStatus(agentId, 'idle');
        break;
      }

      // ── Runtime tracker nudge (v2.5.40) ──
      // Detect "agent is doing real multi-step work but never opened a
      // tracker entry" mid-turn and inject a one-shot system reminder.
      // Multi-step work without a tracker task drifts and stalls, the PM
      // agent can't intervene because there's nothing to monitor, and on
      // the user's most recent test, an agent ran for tens of minutes,
      // hit compaction, and started re-reading sources it had already
      // lost from context. The reflex in the tool index header tells
      // agents to do this; this nudge is the runtime safety net for
      // agents that ignored it.
      const trackerInThisIter = result.toolCalls.filter(
        (tc) => tc.name.startsWith('tracker_'),
      ).length;
      // FA-T3: the multi-step floor counts REAL WORK calls only, calls that are
      // neither tracker ops nor TRIVIAL_TOOLS (read-only reconnaissance / utility
      // / bookkeeping). Before this, a pure recon turn (check email + calendar +
      // texts + vault, ~6 read-only lookups) tripped the >=6 floor, auto-scaffolded
      // a junk project, then failed the close-out gate, auto-paused, and fired
      // CLOSEOUT_MISS at the PM. Trivial lookups are not multi-step work. Reads
      // still never DISARM the floor (FN-9); they simply no longer COUNT toward it.
      const nonTrackerInThisIter = result.toolCalls.filter(
        (tc) => !tc.name.startsWith('tracker_') && !TRIVIAL_TOOLS.has(tc.name),
      ).length;
      // tracker_update_status / tracker_complete_step are the status-mutation
      // tools, they're the signal "agent advanced or closed a task this
      // turn", distinct from broad tracker engagement (which includes
      // tracker_create_project / tracker_list_active / tracker_get_status).
      const trackerStatusInThisIter = result.toolCalls.some(
        (tc) => tc.name === 'tracker_update_status' || tc.name === 'tracker_complete_step' || tc.name === 'tracker_close_project',
      );
      // v3.1.11 (FN-9) + FA-T2: disarm the multi-step floor only when the agent
      // OPENS or ADVANCES its own work. Creating / editing / adding-notes /
      // advancing-a-step is tending; tracker_update_status disarms only when its
      // status arg advances the task to an active state. CLOSING / abandoning /
      // handing off (tracker_close_project, tracker_reassign_task,
      // tracker_resolve_missed_runs, update_status -> complete/fallen/paused/blocked)
      // does NOT disarm: it removes what the PM watches, so new multi-step work
      // later in the SAME turn must not ride in behind an earlier close. For those
      // the floor falls through to the hasRecentlyTendedTask DB check. READS never
      // disarm (they are absent from the disarming set).
      const trackerWriteInThisIter = result.toolCalls.some(
        (tc) =>
          TRACKER_DISARMING_MUTATION_TOOLS.has(tc.name) ||
          (tc.name === 'tracker_update_status' && isAdvancingStatusArg(tc.arguments?.status)),
      );
      if (nonTrackerInThisIter > 0 || trackerInThisIter > 0) {
        state = advance(state, {
          nonTrackerToolCalls: state.nonTrackerToolCalls + nonTrackerInThisIter,
          trackerToolCalledThisTurn: state.trackerToolCalledThisTurn || trackerInThisIter > 0,
          trackerWriteThisTurn: state.trackerWriteThisTurn || trackerWriteInThisIter,
          trackerStatusUpdatedThisTurn: state.trackerStatusUpdatedThisTurn || trackerStatusInThisIter,
        });
        // RC-19 item 3: mirror this iteration's untracked-work delta into the
        // cross-turn counter for the agent's current human conversation, so an A2A
        // send that breaks the turn can't reset the >=6 auto-scaffold floor. A tracker
        // write clears it (work is now tracked); a conversation change resets it (via
        // the conv_key tag inside accumulate). a2a/engine turns (conv_key null) are
        // transparent, so an interleaved A2A detour never clobbers the human total.
        if (trackerWriteInThisIter) {
          clearUntrackedWorkAcrossTurns(agentId);
        } else if (nonTrackerInThisIter > 0) {
          const turnConv = currentTurnConvKey.get(agentId);
          if (typeof turnConv === 'string' && turnConv.length > 0) {
            accumulateUntrackedWorkAcrossTurns(agentId, turnConv, nonTrackerInThisIter);
          }
        }
      }
      // START ACK (NEXT-WAVE item 1, agent-created path): the owner rule is that
      // the user hears "on it" whenever their request is judged project-worthy.
      // That judgment can come from the engine classifier (the two auto-scaffold
      // sites below) OR from the AGENT proactively opening its own project. A
      // diligent agent that self-organizes must not DEPRIVE the user of the ack,
      // so fire it here too, deduped by the same one-per-turn flag and gated to
      // user turns. If the engine auto-scaffold already fired this turn the flag
      // is set, so there is never a double ack.
      if (
        counterparty.kind === 'user' &&
        !counterpartyIsAgentSender && // RC-4.2: no start-ack to an agent-flagged sender
        !engineStartAckDeliveredThisTurn &&
        result.toolCalls.some((tc) => tc.name === 'tracker_create_project')
      ) {
        // Flag set synchronously; wording composed fire-and-forget with a
        // guaranteed pool fallback so it never blocks the loop.
        engineStartAckDeliveredThisTurn = true;
        void (async () => {
          const ackText = await composeStartAck({ userMessage: lastUserMessageContent ?? '', agentId });
          await deliverEngineUserAck(ackText, 'engine_start_ack');
        })();
      }
      // F2 (post-D3): the deleted anti-hoarding gate was ALSO the thing that forced
      // task scaffolding at the 6th load; deleting it removed all engine pressure to
      // scaffold multi-step work (observed: a 7-call research job created no tracker
      // task, drifted, and the PM had nothing to monitor). Re-homed as two tiers:
      //   nudge at >3 real work calls (model-choice assist, one-shot, non-blocking),
      //   ENGINE FLOOR at >=6: the engine auto-creates the task itself via the same
      //   ENGINE_AUTO_MARKER machinery the turn-start classifier uses, so on the
      //   weakest model the work is tracked regardless of what the model chooses.
      const TRACKER_NUDGE_THRESHOLD = 3;
      const TRACKER_AUTO_SCAFFOLD_AT = 6;
      // RC-19 item 3: the >=6 auto-scaffold FLOOR keys on the CROSS-TURN untracked-work
      // total for this human conversation (accumulated above), so an A2A send that
      // breaks the turn can no longer drop the count below the floor. Falls back to the
      // per-turn count on a2a/engine turns (conv_key null). The per-turn count is a
      // subset of the cross-turn total on a human turn, so Math.max is just defensive.
      // The >3 NUDGE tier stays per-turn (it is a within-turn model-choice assist).
      const turnConvForFloor = currentTurnConvKey.get(agentId);
      const effectiveUntracked =
        typeof turnConvForFloor === 'string' && turnConvForFloor.length > 0
          ? Math.max(state.nonTrackerToolCalls, getUntrackedWorkAcrossTurns(agentId, turnConvForFloor))
          : state.nonTrackerToolCalls;
      if (
        // D-B v2: the Healer is tracker-exempt (no tracker tools; SOUL forbids
        // touching it). Neither nudge it nor auto-open a task it cannot tend,
        // which would go stale and trip the PM poke ladder, the exact trap a held
        // destructive consent must not spring against the waiting Healer.
        !isHealerAgent(agentId) &&
        !state.trackerWriteThisTurn &&
        ((!state.nudgedForTrackerThisTurn && state.nonTrackerToolCalls > TRACKER_NUDGE_THRESHOLD) ||
          effectiveUntracked >= TRACKER_AUTO_SCAFFOLD_AT)
      ) {
        // Secondary check: the agent may have a RECENTLY-TENDED task from a
        // previous turn that they're just continuing. Don't nudge them either.
        // The v2.5.40 concern (a nudge firing right after the agent cleanly
        // completed a 3-task project, when every task was already `complete`) is
        // covered by the trackerWriteThisTurn gate above: completing tasks is a
        // tracker write, which disarms this whole block. on_deck was previously
        // counted here as belt-and-suspenders, but is now EXCLUDED (NEXT-WAVE
        // item 2, see the candidate filter below): a queued/scheduled task is not
        // active work, so it must neither suppress this nudge nor be named by it.
        //
        // v3.1.11 (FN-9): "recently tended", not "has any active task". A STALE
        // open task (assigned but untouched for longer than
        // STALE_TASK_WINDOW_MINUTES) no longer suppresses the tiers. That was
        // the second disarm hole: an agent sitting on a long-dead in_progress
        // task could do unlimited untracked multi-step work and never be
        // nudged. Any tracker mutation bumps updated_at, so genuinely-active
        // work stays inside the window. A stale open task (if any) is captured
        // so the nudge can name it and offer "update it, or open a new one".
        let hasRecentlyTendedTask = false;
        let hasAnyInProgressTask = false;
        let staleOpenTask: { id: string; title: string } | null = null;
        try {
          const { listTasks } = await import('../../tracker/schema.js');
          const { normalizeDbTimestamp } = await import('../../scheduler/engine.js');
          const cutoffMs = Date.now() - STALE_TASK_WINDOW_MINUTES * 60_000;
          // NEXT-WAVE item 2 (verified misfire): candidates are in_progress ONLY.
          // on_deck (queued / scheduled) tasks are NOT work the agent is
          // neglecting, they are waiting their turn, and their naturally-old
          // updatedAt made a queued task (e.g. a recurring scheduled brief) get
          // named as "the only open tracker task... hasn't been updated in a
          // while" while the agent was actively working a DIFFERENT in_progress
          // task. A queued scheduled task coming due is a SCHEDULER concern and
          // must never be cited by this nudge, so it can no longer be picked as
          // staleOpenTask nor count toward the floor.
          const candidates = listTasks({ assignedTo: agentId }).filter(
            (t) => t.status === 'in_progress',
          );
          for (const t of candidates) {
            hasAnyInProgressTask = true;
            const tendedMs = new Date(normalizeDbTimestamp(t.updatedAt)).getTime();
            if (tendedMs >= cutoffMs) {
              hasRecentlyTendedTask = true;
            } else if (!staleOpenTask) {
              staleOpenTask = { id: t.id, title: t.title };
            }
          }
        } catch (err) {
          logger.warn('Tracker nudge: listTasks failed (treating as no recently-tended task)', {
            agentId, err: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
        if (
          // NEXT-WAVE item 2: never auto-scaffold a NEW project when an
          // in_progress task already exists (worked or not). If it exists but is
          // stale, the nudge branch below names it and asks the agent to bring it
          // current, rather than opening a duplicate. Only genuinely-untracked
          // work (zero in_progress tasks) reaches the engine floor here.
          !hasAnyInProgressTask &&
          effectiveUntracked >= TRACKER_AUTO_SCAFFOLD_AT &&
          state.lastUserMessageContent &&
          !isPMAgent(agentId) &&
          // P2b: the Dreamer's batch turns make dozens of vault_remember work
          // calls, so this >=6 floor fired EVERY batch and auto-created a tracker
          // project on it, which same-turn-closed and posted a notifyPrimaryAgent
          // completion pair to the primary's chat. Its cycle work is engine-
          // orchestrated maintenance, not a user ask, so the floor skips it (same
          // reasoning as the turn-start classifier skip above).
          !isDreamerAgent(agentId)
        ) {
          // ENGINE FLOOR: the model has done 6+ real work calls with no tracker
          // engagement (the exact point where the old anti-hoarding gate used to
          // force scaffolding). Stop asking; create the task ourselves via the
          // same ENGINE_AUTO_MARKER path the turn-start classifier uses, so the
          // work is tracked on the weakest model regardless of what it chooses.
          try {
            const { createProject } = await import('../../tracker/schema.js');
            const { ENGINE_AUTO_MARKER } = await import('./classifiers/multistep.js');
            // F12.5: cleaned interim name (strip filler, word-boundary truncate,
            // capitalize) instead of a mangled raw slice; PM rename handoff below
            // gives it a proper umbrella name. Capture the prompt now (narrowed to
            // string by the enclosing guard) so the rename dispatch below still has
            // it after the state reassignments that follow.
            const scaffoldPrompt: string = state.lastUserMessageContent;
            const scaffoldName = deriveScaffoldTitle(scaffoldPrompt) || 'Multi-step task';
            const created = createProject({
                    origin: { kind: 'engine_scaffold', sourceMessageId: state.lastUserMessageId, turn: turnNumber, convKey: chosenConvKey },
              title: scaffoldName,
              description: ENGINE_AUTO_MARKER + scaffoldPrompt.slice(0, 2000),
              level: 1,
              tasks: [{ title: scaffoldName, assignedTo: agentId }],
              createdBy: agentId,
            });
            const scaffoldTaskId = created.taskIds?.[0] ?? null;
            // F2.2: scaffold note on the model-visible steer channel. The old
            // role='system' row was stripped by the assembler, so a continuing
            // agent never learned the engine had opened the task (it then drifted
            // and the PM later re-delivered the old answer). Persist as an
            // origin_kind='engine' row (EVENTS lane surfaces it) AND pendingNudge
            // so the continuing agent sees the task id + how to close it THIS turn.
            // Label form ([System] body) so the events-lane leading-bracket strip
            // keeps the body. conv_key sentinel keeps it un-selectable as an event.
            const autoNoteText = (
              `[System] The engine opened tracker task "${scaffoldName}" (task_id: ${scaffoldTaskId ?? created.projectId}) for this work ` +
              `(you made ${state.nonTrackerToolCalls} work calls with no tracker entry; untracked multi-step work drifts and the PM cannot monitor it). ` +
              `Keep working; update it with tracker_add_notes as you go and close it with tracker_update_status(complete) plus result/evidence when done.`
            );
            const autoNoteId = uuidv4();
            try {
              insertInterAgentEngineRow({
      work: null,
                id: autoNoteId,
                agentId,
                content: autoNoteText,
                sourceAgentId: null,
                originIntent: 'auto_scaffold',
                convKey: 'engine-steer',
                turnNumber,
              });
            } catch { /* best effort */ }
            // The floor just performed a tracker mutation (createProject), so
            // set trackerWriteThisTurn to fully disarm the gate above and stop
            // it re-entering on later iterations. trackerToolCalledThisTurn is
            // kept for parity with the agent-engaged-tracker signal. pendingNudge
            // delivers the scaffold note to a continuing agent this turn (F2.2);
            // autoScaffoldedTaskIdThisTurn lets natural turn-end close JUST this
            // task if the turn was read-only and nothing else closed it (F2.1).
            state = advance(state, {
              trackerToolCalledThisTurn: true,
              trackerWriteThisTurn: true,
              nudgedForTrackerThisTurn: true,
              pendingNudge: autoNoteText,
              autoScaffoldedTaskIdThisTurn: scaffoldTaskId,
            });
            // RC-19 item 3: the floor just tracked the work (createProject), so reset
            // the cross-turn untracked-work total. This is an engine-side tracker
            // write that never flows through the per-iteration accumulate/clear above,
            // so clear it explicitly or the count would re-trip the floor next turn.
            clearUntrackedWorkAcrossTurns(agentId);
            logger.info('v2: tracker auto-scaffold fired (engine floor)', {
              agentId, nonTrackerToolCalls: state.nonTrackerToolCalls, projectId: created.projectId,
            }, agentId);
            // START ACK (NEXT-WAVE item 1): second project-auto-creation site.
            // The engine just decided this in-flight work is project-worthy, so
            // the person who asked hears it is being tracked, once per turn.
            // RC-4.2: never start-ack an agent-flagged counterparty (ack ping-pong).
            if (counterparty.kind === 'user' && !counterpartyIsAgentSender && !engineStartAckDeliveredThisTurn) {
              // Flag set synchronously; wording composed fire-and-forget. This
              // site fires MID-WORK (the engine just opened a task for in-flight
              // work), so it uses the 'inprogress' flavor ("already working on
              // it") rather than the fresh-start flavor.
              engineStartAckDeliveredThisTurn = true;
              // Title-free (see the other start-ack site): scaffoldName is a raw
              // truncated user request and reads as broken grammar if spliced in.
              void (async () => {
                const ackText = await composeStartAck({ userMessage: lastUserMessageContent ?? '', agentId, phase: 'inprogress' });
                await deliverEngineUserAck(ackText, 'engine_start_ack');
              })();
            }
            // F12.5: same PM rename handoff the turn-start site uses, so this
            // interim name also gets a proper umbrella name. Fire-and-forget.
            if (scaffoldTaskId) {
              void dispatchPMRenameHandoff({
                callingAgentId: agentId,
                projectId: created.projectId,
                taskId: scaffoldTaskId,
                projectTitle: scaffoldName,
                taskTitle: scaffoldName,
                originalPrompt: scaffoldPrompt,
              });
            }
          } catch (err) {
            logger.warn('Tracker auto-scaffold failed (non-fatal, falling back to nudge)', {
              agentId, err: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        } else if (!hasRecentlyTendedTask && !state.nudgedForTrackerThisTurn) {
          // v3.1.11 (FN-9): two wordings. When the agent has a STALE open task
          // (assigned but not recently tended), name it and give a fork: update
          // that task if this is the same work, otherwise open a project for
          // the new work. When there's no open task at all, keep the original
          // create-a-project wording.
          const nudgeText = staleOpenTask
            ? (
              `[System: you've made ${state.nonTrackerToolCalls} work tool calls this turn, but the only open tracker task assigned to you ("${staleOpenTask.title}", task_id ${staleOpenTask.id.slice(0, 8)}) hasn't been updated in a while. ` +
              `Multi-step work that isn't reflected in a live tracker task drifts and stalls (the PM agent can't intervene because there's nothing current to monitor) and your context is filling up which means compaction is coming and you'll lose source detail you've already read. ` +
              `Decide now: if what you've been doing IS that task, bring it current via tracker_update_status / tracker_add_notes; otherwise this is NEW work, so open a project for it with tracker_create_project(title="<short name>", level=2, tasks=[…one task per discrete batch…]). ` +
              `Then keep each task current via tracker_update_status, and use scratchpad_set to keep a running outline that survives compaction. ` +
              `Resume the work once the tracker reflects it.]`
            )
            : (
              `[System: you've made ${state.nonTrackerToolCalls} work tool calls this turn without an active tracker task assigned to you. ` +
              `Multi-step work without a tracker entry drifts and stalls (the PM agent can't intervene because there's nothing to monitor) and your context is filling up which means compaction is coming and you'll lose source detail you've already read. ` +
              `STOP what you're doing right now and call tracker_create_project(title="<short name>", level=2, tasks=[…one task per discrete batch…]) describing the steps for what you've been doing and what's left. ` +
              `Then update each task as you complete it via tracker_update_status, and use scratchpad_set to keep a running outline that survives compaction. ` +
              `Resume the work after the project is opened.]`
            );
          // RC-19 (F-18): via persistEngineSteer so the STOP/open-a-project directive
          // reaches the model (pendingNudge) AND keeps its dashboard row. This is the
          // site the owner remembered "ignoring the STOP": the bare role='system' row was
          // stripped by the assembler, so the model was never actually told to stop.
          state = persistEngineSteer(
            state,
            { agentId, content: nudgeText, turnNumber, extra: { nudgedForTrackerThisTurn: true } },
            { db, broadcast },
          );
          logger.info('v2: tracker nudge fired', {
            agentId, nonTrackerToolCalls: state.nonTrackerToolCalls,
          }, agentId);
        }
      }

      // ── complete_task / fire-and-forget generator exit conditions (Part XIX) ──
      if (calledCompleteTask) {
        logger.info('v2: complete_task called, exiting loop', { agentId }, agentId);
        break;
      }
      if (calledFireAndForgetGen) {
        logger.info('v2: fire-and-forget generator called, exiting loop (async delivery)', { agentId }, agentId);
        break;
      }
      // ── A2A turn: the send_to_agent IS the response, end the turn once it
      // fires. Without this, a weak model can loop calling send_to_agent on an
      // inter-agent turn; the thrash gate's "respond with TEXT" escape doesn't
      // help because A2A-turn text is suppressed, so the turn would never
      // terminate (observed: 12 send_to_agent calls ignoring 9 STOP messages,
      // and runaway turns that thrash send_to_agent then wander into file work
      // and deliver attachments to the OWNER). The reply is already delivered +
      // recorded; there is nothing else to do.
      //
      // Read THIS iteration's actual tool calls, not state.sentToAgentThisTurn:
      // that flag is set via `state = advance(...)` inside the parallel
      // `runOne` callbacks (Promise.all), where concurrent reassignments clobber
      // each other, so it can silently fail to stick and the turn runs away.
      // result.toolCalls is deterministic.
      const issuedA2AReplyThisIteration = (result.toolCalls ?? []).some(
        (tc) => tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group',
      );
      if (counterparty.kind === 'agent' && (state.sentToAgentThisTurn || issuedA2AReplyThisIteration)) {
        logger.info('v2: A2A reply sent, exiting loop (send_to_agent is the response)', { agentId }, agentId);
        break;
      }

      // ── Delegation turn-end (agent-coordination flow) ──
      // On a NON-A2A turn, a wake-intent send_to_agent (QUESTION / ASSIGN /
      // BLOCK) means the agent asked another agent for something it needs, and
      // that reply is ASYNCHRONOUS, it lands on a LATER turn, never in this one.
      // End the turn now. Without this, the agent loops re-asking (observed: 29
      // send_to_agent calls in one turn) AND/OR fabricates the answer before the
      // reply arrives. The owner's question is parked + resumed when the reply
      // lands (close-the-loop, handled below / in the runtime). The model can
      // still delegate to MULTIPLE agents in this single response's tool batch
      // before the turn ends, so genuine multi-delegation is not blocked.
      const issuedWakeAsk = (result.toolCalls ?? []).some((tc) => {
        if (tc.name !== 'send_to_agent') return false;
        const intent = String((tc.arguments as Record<string, unknown> | undefined)?.intent ?? '').toUpperCase();
        return intent === 'QUESTION' || intent === 'ASSIGN' || intent === 'BLOCK';
      });
      if (counterparty.kind !== 'agent' && issuedWakeAsk) {
        // PARK the owner's question on the thread we just asked. At pickup this
        // turn's trigger was stamped "served" (anti-thrash); overwrite that with
        // a park marker so the question (a) does NOT re-trigger, no re-asking, 
        // and (b) is NOT falsely treated as answered. When the other agent's reply
        // comes back on this thread, the ENGINE closes the loop directly: it delivers
        // the answer to the owner on their own channel and marks the parked row
        // `relayed:<thread>` (see a2a-transport.ts). It does NOT un-park to NULL / re-fire
        // the model, that proved flaky (the weak model re-reads "ask X" and re-asks,
        // an ask→park→answer→re-ask loop). Deterministic delivery, regardless of the model.
        if (triggerRow && chosenConvKey) {
          let parkKey: string | null = null;
          const parkThreads: string[] = [];
          // T-2 (comms-audit): derive the asked thread(s) STRUCTURALLY from the A2A rows
          // the sends just created (source_agent_id = this agent, this turn), not by
          // regex-scraping the tool-result prose. If the result wording ever changed, the
          // regex would miss and the owner's question would be SILENTLY DROPPED (it keeps
          // its served conv_key and never re-fires). Regex kept as a single-thread fallback.
          //
          // Fan-out delegation (2026-07-17): ONE owner ask can hand off to N>1 threads in a
          // single response's tool batch, so we collect EVERY reply-warranting thread of the
          // turn (dropping the old LIMIT 1) and park the owner's question on the WHOLE set.
          // buildOwnerParkKey encodes one thread as today's single park:<thread>
          // (deterministic engine relay preserved) and two+ as a multi park:~<full>#<remaining>
          // that a2a-transport close-the-loop holds until the LAST piece lands, then steers the
          // model to compile the combined reply, never relaying a partial. Ordering is ASC
          // (oldest first) so the encoded set reads in hand-off order.
          try {
            // C9: constrain to reply-warranting intents. The weak model routinely batches a
            // real QUESTION/ASSIGN/BLOCK to a worker AND a STATUS/FYI to the PM in one
            // response; the intent filter keeps only the delegations that actually await a reply.
            // D-A: this agent's own outbound wake-ask is persisted as the RECIPIENT's inbound
            // row, and for peer A2A that row now lives in inter_agent_messages, not `messages`.
            // Read the MERGED source so the structural derivation still finds the sends it just
            // made (a messages-only read would miss them and silently fall back to the fragile
            // prose regex). The messages arm dedups against store ids; the cross-table tiebreak
            // (created_at, then messages-first on a tie, then rowid) preserves hand-off order.
            const sentRows = db.prepare(
              `SELECT a2a_thread_id, created_at, rowid AS _rowid, 0 AS _tag FROM messages
                 WHERE source_agent_id = @agentId AND a2a_thread_id IS NOT NULL
                   AND a2a_intent IN ('QUESTION','ASSIGN','BLOCK') AND created_at >= @turnStartedAt
                   AND id NOT IN (SELECT id FROM inter_agent_messages WHERE source_agent_id = @agentId)
               UNION ALL
               SELECT a2a_thread_id, created_at, rowid AS _rowid, 1 AS _tag FROM inter_agent_messages
                 WHERE source_agent_id = @agentId AND a2a_thread_id IS NOT NULL
                   AND a2a_intent IN ('QUESTION','ASSIGN','BLOCK') AND created_at >= @turnStartedAt
               ORDER BY created_at ASC, _tag ASC, _rowid ASC`,
            ).all({ agentId, turnStartedAt }) as Array<{ a2a_thread_id: string }>;
            // BUG-4 (comms-audit): park under FULL thread ids (never an 8-char prefix). Two
            // threads sharing an 8-hex prefix would otherwise collide in the relay. Full ids
            // make both the single and the multi encoding collision-free (the relay reads the
            // full key; the 8-char key is only the rare regex-fallback below, single-thread).
            for (const r of sentRows) {
              if (r.a2a_thread_id && !parkThreads.includes(r.a2a_thread_id)) parkThreads.push(r.a2a_thread_id);
            }
            if (parkThreads.length > 0) {
              // Canonical encoder lives in a2a-transport (the reader), imported here so the
              // park key format has a single source of truth. Dynamic import keeps this within
              // the park block (module is already loaded; the call returns the cached export).
              const { buildOwnerParkKey } = await import('../a2a-transport.js');
              parkKey = buildOwnerParkKey(parkThreads);
            }
          } catch { /* best effort, fall back to the prose regex */ }
          if (!parkKey) {
            // Regex fallback: single thread only (the tool-result prose carries one 8-char
            // thread token). Fan-out never reaches here (the structural read above finds the
            // sends); this only covers the rare prose-only case.
            for (let i = state.toolResults.length - 1; i >= 0; i--) {
              const tr = state.toolResults[i];
              if (tr.name === 'send_to_agent' && typeof tr.content === 'string') {
                const m = tr.content.match(/on thread ([a-z0-9]{6,})/i);
                if (m) { parkKey = `park:${m[1].slice(0, 8)}`; break; }
              }
            }
          }
          if (parkKey) {
            try {
              db.prepare(`UPDATE messages SET conv_key = ? WHERE agent_id = ? AND rowid = ?`)
                .run(parkKey, agentId, triggerRow.rowid);
              logger.info('v2: parked owner question awaiting agent reply', {
                agentId, park: parkKey, threads: parkThreads.length, ownerRowid: triggerRow.rowid,
              }, agentId);
            } catch { /* best effort */ }
          }
        }
        logger.info('v2: delegation send, exiting loop (reply is async; owner question parked)', { agentId }, agentId);
        break;
      }

      // ── Phase: post-execution gates ──
      state = advance(state, { phase: 'postExecution' });

      // ── Repetition detection (matches v1 runtime.ts:1622-1634) ──
      // If the model produces the SAME text + SAME tool calls as the last
      // iteration, it's stuck. Nudge once. If still repeating, break with
      // STUCK_REPEATING. The loopDetector catches duplicate-tool-call
      // patterns; this catches duplicate-FULL-response patterns including
      // text-only responses.
      const currentResponseSig =
        (result.content ?? '') +
        '|' +
        result.toolCalls
          .map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`)
          .sort()
          .join(',');
      if (state.lastResponseSig === currentResponseSig) {
        if (!state.nudgedForRepetition) {
          logger.warn('v2: agent repeating itself, nudging on next iteration', {
            loopCount: state.loopCount,
          }, agentId);
          state = advance(state, {
            nudgedForRepetition: true,
            pendingNudge:
              // FN-8: complete_task is not available to every agent, so don't
              // name it here where the filtered tool list isn't in scope. Point
              // at tracker_update_status (universally available) instead.
              '[System: You are repeating yourself, your last two responses were identical. ' +
              'Try a different approach. If the task is complete, mark it done (e.g. tracker_update_status) and stop. ' +
              'If you need help, explain what you are stuck on.]',
          });
          continue;
        }
        logger.warn('v2: breaking tool loop, agent still repeating after nudge', {
          loopCount: state.loopCount,
        }, agentId);
        broadcast({
          type: 'chat:error',
          agentId,
          error: 'Agent got stuck repeating itself. Send a follow-up to redirect it.',
          code: 'STUCK_REPEATING',
          severity: 'warning',
          retryable: true,
        });
        break;
      }
      state = advance(state, { lastResponseSig: currentResponseSig });

      // Permission denial counter
      const allBlocked = turnToolResults.every((tr) => tr.isError && tr.content.includes('[BLOCKED]'));
      if (allBlocked && turnToolResults.length > 0) {
        state = advance(state, {
          consecutivePermissionDenials: state.consecutivePermissionDenials + turnToolResults.length,
        });
      } else if (turnToolResults.length > 0) {
        state = advance(state, { consecutivePermissionDenials: 0 });
      }

      // ── No-results detection (matches v1 runtime.ts:1658-1678) ──
      // When search tools (vault_search, history_search, web_search, etc.)
      // repeatedly return "No results found" / "not in memory", the agent
      // is probably looking for something that doesn't exist. Nudge once,
      // then break with a NO_RESULTS error if it persists.
      const allNoResults =
        turnToolResults.length > 0 &&
        turnToolResults.every(
          (tr) =>
            tr.content.includes('No results found') ||
            tr.content.includes('not in memory'),
        );
      if (allNoResults && turnToolResults.every((tr) => !tr.isError)) {
        const nextNoResultsCount = state.consecutiveNoResultTools + 1;
        if (nextNoResultsCount >= 2) {
          if (!state.nudgedForNoResults) {
            logger.warn('v2: consecutive empty search results, nudging on next iteration', {
              loopCount: state.loopCount,
              consecutiveNoResultTools: nextNoResultsCount,
            }, agentId);
            state = advance(state, {
              nudgedForNoResults: true,
              pendingNudge:
                '[System: Multiple searches returned no results. The information may not exist in memory. ' +
                'Try responding based on what you already know, or ask the user for clarification.]',
              consecutiveNoResultTools: 0,
            });
            continue;
          }
          // Already nudged, break with NO_RESULTS error
          logger.warn('v2: breaking tool loop, still no results after nudge', {
            loopCount: state.loopCount,
          }, agentId);
          broadcast({
            type: 'chat:error',
            agentId,
            error: 'Agent stopped, searches kept coming up empty. The info may not be in memory yet.',
            code: 'NO_RESULTS',
            severity: 'warning',
            retryable: true,
          });
          break;
        }
        state = advance(state, { consecutiveNoResultTools: nextNoResultsCount });
      } else if (turnToolResults.length > 0) {
        state = advance(state, { consecutiveNoResultTools: 0 });
      }

      // Spinning detection (Part XVIII §F, engine asks model before breaking)
      const progressDecision = progressClassifier({
        toolCallsExecutedThisTurn: state.toolCallsExecutedThisTurn,
        consecutiveSmallDeltas: 0, // Phase 4 will track this
        consecutivePermissionDenials: state.consecutivePermissionDenials,
        consecutiveNoResultTools: 0, // Phase 4 will track this
        spinningNudgeCount: state.spinningNudgeCount,
        loopCount: state.loopCount,
      });
      if (!progressDecision.progressing) {
        // If we've already nudged 3 times and the agent kept going, break.
        if (progressDecision.signals?.includes('nudge cap')) {
          logger.warn('v2: spinning nudge cap reached, breaking', { agentId }, agentId);
          break;
        }
        // Otherwise inject a nudge and continue once.
        // FN-8: the nudge only names complete_task for agents that can actually
        // self-complete; a persistent agent gets "explain the block in your
        // reply" wording instead of being pointed at a tool the guard refuses.
        const nudgeText = buildSpinningNudge({
          toolCallsExecutedThisTurn: state.toolCallsExecutedThisTurn,
          consecutiveSmallDeltas: 0,
          consecutivePermissionDenials: state.consecutivePermissionDenials,
          consecutiveNoResultTools: 0,
          spinningNudgeCount: state.spinningNudgeCount,
          loopCount: state.loopCount,
        }, agentCanSelfCompleteById(agentId));
        // RC-19: via persistEngineSteer so the "you seem stuck, here is what to do"
        // question reaches the model (pendingNudge) AND keeps its dashboard row. The
        // comment above ("engine asks model before breaking") only works if the model
        // actually hears the question; the bare role='system' row the assembler strips
        // meant it never did. Bump the ignored-nudge count via extra.
        state = persistEngineSteer(
          state,
          { agentId, content: nudgeText, turnNumber, extra: { spinningNudgeCount: state.spinningNudgeCount + 1 } },
          { db, broadcast },
        );
      }

      // Loop continues, model will see tool results and respond
    }

    if (state.loopCount >= MAX_TOOL_LOOPS) {
      // Matches v1 runtime.ts:1683-1707. Hit the soft tool-loop cap but
      // (presumably) still making progress, auto-continue with a fresh
      // turn instead of dead-stopping. The continuity brief + tracker
      // tasks let the agent pick up where they left off.
      logger.warn('v2 hit MAX_TOOL_LOOPS, auto-continuing with fresh turn', {
        agentId, maxLoops: MAX_TOOL_LOOPS,
      }, agentId);
      const sysMsg = (
        `[System: This turn reached ${MAX_TOOL_LOOPS} tool calls. Starting a fresh turn ` +
        `to continue your work. Pick up where you left off.]`
      );
      const sysMsgId = uuidv4();
      db.prepare(`
        INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
        VALUES (?, ?, 'system', ?, ?, datetime('now'))
      `).run(sysMsgId, agentId, sysMsg, turnNumber);
      broadcast({
        type: 'chat:message',
        agentId,
        message: {
          id: sysMsgId, agentId, role: 'system' as const,
          content: sysMsg,
          tokenCount: null, modelId: null, cost: null, latencyMs: null,
          createdAt: new Date().toISOString(),
        },
      });
      // Schedule a self-continuation. Reassembles context fresh, the agent
      // sees its full history including the work it just did and continues
      // naturally. 1s delay lets DB writes settle.
      stashContinuationIfHuman(); // C3: carry the human conversation into the continuation
      setTimeout(() => {
        try {
          getAgentRuntime().handleMessage(agentId, '').catch((err) => {
            logger.error('v2 auto-continuation after tool limit failed', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          });
        } catch (err) {
          logger.error('v2 auto-continuation failed to schedule', {
            agentId, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
      }, 1000);
    }

    // ── Phase: finalize ──
    state = advance(state, { phase: 'finalize' });

    // ── G-SUP-2 recovery (comms-audit) ──
    // A human was waiting, the only user-facing text this turn rode with tool
    // calls (deferred above as possible narration), and the turn delivered NO
    // proper tool-less reply (lastAssistantTextForIM still unset). Recover the
    // deferred text so the ask is answered, never silently dropped, deliver it
    // to the dashboard chat AND hand it to the channel router below. When a real
    // tool-less reply DID land, lastAssistantTextForIM is set and this is skipped,
    // so there is no double-reply.
    if (deferredUserReplyWithTools && !state.lastAssistantTextForIM) {
      const recoveredId = uuidv4();
      try {
        // RC-12 item 6: the recovery path used to route deferred text WITHOUT the
        // grounding detector (it only runs on tool-LESS terminal replies above), so a
        // false "sent it" that rode with a tool call slipped straight to the channel.
        // The loop has exited here (no re-entry to correct), so we run the detector +
        // receipt ledger and, if the claim is genuinely ungrounded (no receipt), log a
        // LOUD tripwire. We still deliver: a waiting human must not be left in silence
        // (the very failure G-SUP-2 exists to prevent), and the tool-less terminal gate
        // is the model-visible correction path for the common case.
        try {
          const g = detectUngroundedDeliveryClaim({
            responseText: deferredUserReplyWithTools,
            toolCallsThisTurn: state.toolResults.filter((r) => !r.isError).map((r) => ({ name: r.name })),
            counterpartyName: counterparty.name,
          });
          if (g.ungrounded &&
              findRecentDeliveriesKeyed(agentId, g.recipient, 24).length === 0 &&
              findRecentDeliveries(agentId, g.recipient, 24).length === 0) {
            logger.warn('v2 G-SUP-2 recovery: delivered text asserts an UNGROUNDED delivery (no receipt); no re-entry available at finalize', {
              agentId, turnNumber, recipient: g.recipient,
            }, agentId);
          }
        } catch { /* detection is best-effort; never block the recovery delivery */ }
        db.prepare(
          `INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at) VALUES (?, ?, 'assistant', ?, ?, datetime('now'))`,
        ).run(recoveredId, agentId, deferredUserReplyWithTools, turnNumber);
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: recoveredId, agentId, role: 'assistant' as const, content: deferredUserReplyWithTools,
            tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString(),
          },
        });
        state = advance(state, { lastAssistantTextForIM: stripOrbMood(deferredUserReplyWithTools) });
        logger.info('v2 G-SUP-2 recovery: delivered deferred text-with-tools reply (turn ended with no tool-less reply)', {
          agentId, turnNumber,
        }, agentId);
      } catch (err) {
        logger.warn('v2 G-SUP-2 recovery failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
      }
    }

    // ── COMPLETION ACK (NEXT-WAVE item 1, the hard part) ──
    // A turn that served a human request and finished ENGINE-scaffolded work MUST
    // tell the person it is done, before the turn can end on a background / A2A
    // obligation. This runs on EVERY exit path (natural end, [no-reply], the
    // delegation-send break, a gate/limit), so the owed human ack is delivered no
    // matter how the turn ended, the exact production gap (owner heard nothing on
    // a completed backup+reset because the floor model drifted into A2A). It is
    // engine-composed and delivered directly, so it holds on the floor model
    // regardless of what the model chose to emit.
    //
    // Dedup / prefer the model's own words: skip entirely if the model already
    // produced a user-facing reply this turn (lastAssistantTextForIM set, or a
    // reply surfaced). Scope: user counterparty only (A2A-turn completions are
    // owned by the close-the-loop report below), and ONLY engine-scaffolded
    // (ENGINE_AUTO_MARKER) tasks that completed THIS turn, so a plain reply, a
    // trivial task, or a model-authored completion never triggers a canned line.
    // [no-reply] is not a valid resolution here: if the model went silent on a
    // completed user-requested task, the engine speaks for it.
    //
    // Same channel-delivery blindness as the F10 start-ack: a turn that
    // delivered its "done" through a channel send TOOL leaves no assistant text
    // row (lastAssistantTextForIM / surfacedReplyThisTurn both stay unset), so
    // without the explicitSendThisTurn guard the engine would compose a second,
    // duplicate completion line on top of the model's own send. A genuine
    // silent drift-to-A2A sets none of these (send_to_agent is not a channel
    // send), so the engine still speaks there.
    // Set when THIS turn composed an engine "done" ack for just-finished scaffolded
    // work. The settled-context hold at the route site reads it to NEVER withhold a
    // genuine completion push (always-acknowledge-user-work is a hard rule): a real
    // deliverable must still reach an away owner's phone even on a background wake.
    let engineCompletionAckThisTurn = false;
    if (
      counterparty.kind === 'user' &&
      !counterpartyIsAgentSender && // RC-4.2: no engine completion-ack to an agent-flagged sender
      !state.lastAssistantTextForIM &&
      !state.surfacedReplyThisTurn &&
      !Object.values(state.explicitSendThisTurn).some(Boolean)
    ) {
      try {
        const { ENGINE_AUTO_MARKER } = await import('./classifiers/multistep.js');
        // The ENGINE_AUTO_MARKER lives on the PROJECT description (both scaffold
        // sites set it there; the task carries the user content), so match it via
        // the task's project, not the task's own description.
        const justCompletedScaffold = db.prepare(`
          SELECT t.title AS title, t.result AS result, t.created_at AS created_at, t.source_message_id AS source_message_id FROM tasks t
          JOIN projects p ON p.id = t.project_id
          WHERE t.assigned_to = ?
            AND t.status = 'complete'
            AND t.completed_at >= ?
            AND t.repeat_interval IS NULL
            AND p.description LIKE ?
          ORDER BY t.completed_at ASC
          LIMIT 3
        `).all(agentId, turnStartedAt, `${ENGINE_AUTO_MARKER}%`) as Array<{ title: string; result: string | null; created_at: string }>;
        // CROSS-TURN DEDUP: the per-turn dedup on the outer gate
        // (lastAssistantTextForIM / surfacedReplyThisTurn) misses the common case
        // where the model DELIVERED the real answer on an earlier turn and the
        // scaffolded task only reached 'complete' on a later, silent continuation
        // turn (e.g. the turn continued past a tracker nudge). That produced a
        // redundant "Done, I finished..." AFTER the user already had the answer.
        // Suppress the ack when the user has ALREADY received a substantive,
        // model-authored reply for this work since the earliest just-completed task
        // was created. Exclude the engine's own start/completion ack lines and the
        // tool_use/tool_result JSON rows so only a genuine model answer counts. The
        // genuine silent case (did the work, never told the user, drifted to A2A)
        // has no such reply, so the ack still fires there.
        const earliestTaskCreatedAt = justCompletedScaffold
          .map((t) => t.created_at)
          .filter((c): c is string => !!c)
          .sort()[0] ?? turnStartedAt;
        // P4b keyed read: if every just-completed scaffold's birthing ask
        // already records an answering reply (answer_message_id, mig 113),
        // the user has the answer and the ack is redundant, by identity.
        const rootIds = justCompletedScaffold
          .map((t) => (t as unknown as { source_message_id?: string | null }).source_message_id)
          .filter((x): x is string => !!x);
        const answeredByKey = rootIds.length === justCompletedScaffold.length && rootIds.length > 0 && rootIds.every((mid) => {
          const row = db.prepare('SELECT answer_message_id FROM messages WHERE id = ?').get(mid) as { answer_message_id: string | null } | undefined;
          return !!row?.answer_message_id;
        });
        const userAlreadyAnswered = answeredByKey || (justCompletedScaffold.length > 0 && !!db.prepare(`
          SELECT 1 FROM messages
          WHERE agent_id = ? AND role = 'assistant' AND created_at >= ?
            AND (source IS NULL OR source != 'a2a')
            AND content NOT LIKE '[{%'
            -- Engine acks are excluded STRUCTURALLY by their origin_intent tag.
            AND origin_intent IS NULL
            AND length(trim(content)) > 40
          LIMIT 1
        `).get(agentId, earliestTaskCreatedAt));
        if (justCompletedScaffold.length > 0 && userAlreadyAnswered) {
          logger.info('v2: completion ack skipped, user already received a substantive reply for this work (cross-turn dedup)', {
            agentId, turnNumber,
          }, agentId);
        } else if (justCompletedScaffold.length > 0) {
          // Do NOT splice the task title into the sentence: the auto-scaffold names
          // the task from a raw, truncated user request, which reads as broken
          // grammar. The task result (model-written) carries the specifics.
          const firstResult = justCompletedScaffold.find((t) => t.result && t.result.trim())?.result ?? null;
          // DELIVERABLE HANDOFF: a silent completion still owes the person the
          // thing they asked for (the link to the doc/sheet/file just created).
          // Extract the link(s) FIRST and always in full, from this turn's tool
          // results (the create tools emit "Link:"/"Open:"/"Share link:" lines)
          // plus the model-written task results (in case the model pasted the
          // labeled link into its result). Only THEN condense the prose, at a
          // word boundary, so a link is never sliced mid-word or before the URL.
          const deliverableLinks = extractDeliverableLinks([
            ...state.toolResults.map((tr) => tr.content),
            ...justCompletedScaffold.map((t) => t.result),
          ]);
          const condensed = firstResult
            ? condenseResultProse(firstResult, { dropUrls: deliverableLinks })
            : '';
          const resultLine = condensed ? ` ${condensed}` : '';
          // Vary the "done" sentence (best-effort model, guaranteed pool
          // fallback); the caller still appends the model-written result line.
          // Awaited inline (turn teardown, not the model loop) because the
          // resolver below routes lastAssistantTextForIM to the away channel.
          const doneLine = await composeCompletionAck({ resultLine, agentId });
          // Links go on their own line(s) after the summary sentence, whole and
          // untruncated, so the person can actually open the deliverable.
          const linksBlock = deliverableLinks.length ? `\n${deliverableLinks.join('\n')}` : '';
          const ackText = `${doneLine}${resultLine}${linksBlock}`;
          const ackId = uuidv4();
          db.prepare(
            `INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, origin_intent, created_at) VALUES (?, ?, 'assistant', ?, ?, 'engine_completion_ack', datetime('now'))`,
          ).run(ackId, agentId, ackText, turnNumber);
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: ackId, agentId, role: 'assistant' as const,
              content: ackText,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
          // Hand the ack to the reply-destination resolver below so an away user
          // gets it on their real channel (iMessage / phone / SMS), not only the
          // dashboard. This is the "human ack blocks turn-end ahead of background
          // obligations" guarantee: the person hears "done" as part of ending the
          // turn even when the model tried to end on a send_to_agent.
          state = advance(state, { lastAssistantTextForIM: ackText });
          engineCompletionAckThisTurn = true;
          logger.info('v2: engine-composed completion ack (owed human reply for engine-scaffolded work)', {
            agentId, turnNumber, taskCount: justCompletedScaffold.length,
          }, agentId);
        }
      } catch (err) {
        logger.warn('v2: completion-ack composition failed (non-fatal)', {
          agentId, error: err instanceof Error ? err.message : String(err),
        }, agentId);
      }
    }

    // ── Reply-destination resolver (v2.7.23, OpenClaw-inspired) ──
    // The model just writes text; the engine decides which channel to
    // route it through. The 2.7.22 "model must call imessage_send for
    // every reply" pattern failed in practice (the model defaults to
    // streaming text and can't reliably switch to tool mode for short
    // conversational replies), historical investigation logged
    // separately in the iMessage-routing fix notes.
    //
    // Routing rules (see reply-destination.ts):
    //   - inbound from channel X → reply auto-routes back to X
    //   - dashboard inbound / proactive turn → dashboard
    //   - AWAY OVERRIDE: dashboard destination + presence='away' +
    //     bridge configured → rewrite to iMessage so the user (who
    //     isn't at the dashboard) gets the message on their phone
    //
    // Dedup: if the agent already called the channel's explicit send
    // tool this turn (state.explicitSendThisTurn[channel]), skip the
    // auto-route, they handled it directly.
    if (isPrimaryAgent(agentId) && state.lastAssistantTextForIM) {
      try {
        // ── File download-link backstop (P6b-2: keyed rows) ──
        // file_write / file_append return the share URL ONLY in the tool
        // result, which the user never sees. Agents under load routinely
        // reply "saved to your desktop" and drop the link, so the deliverable
        // is never actually delivered. The engine guarantees it instead: any
        // download URL minted this turn that the agent left out of its
        // user-facing reply is (a) appended to the channel-routed text so it
        // rides along to iMessage/SMS/etc., and (b) surfaced in the dashboard
        // as its own assistant bubble. Model-independent, the link lands
        // whether or not the agent remembered it (correctness-floor rule).
        // The links are turn_artifacts rows recorded by the tools at the
        // source (they hold url + path as variables); the old prose regexes
        // over tool-result text are dead.
        {
          // A file shown in the canvas already has a download button right
          // there, so a user AT the dashboard doesn't need a follow-up link
          // bubble. But an AWAY user (reply routing to iMessage/SMS) can't see
          // the canvas, so the link must still ride along to the channel. Hence
          // the split: channel delivery covers every undelivered URL; the
          // dashboard link bubble is suppressed for the doc currently on canvas.
          const { getCurrentCanvas } = await import('../canvas-view.js');
          const { drainTurnLinkArtifacts } = await import('../pending-attachments.js');
          const currentCanvasPath = getCurrentCanvas(agentId)?.path ?? null;
          const replyText = state.lastAssistantTextForIM;
          const undeliveredForChannel: string[] = [];
          const undeliveredForDashboard: string[] = [];
          const seen = new Set<string>();
          for (const link of drainTurnLinkArtifacts(agentId, turnNumber)) {
            if (!link.url || seen.has(link.url)) continue;
            seen.add(link.url);
            if (replyText.includes(link.url)) continue; // the agent already shared it
            const shownInCanvas = !!link.path && !!currentCanvasPath && link.path === currentCanvasPath;
            undeliveredForChannel.push(link.url);
            if (!shownInCanvas) undeliveredForDashboard.push(link.url);
          }
          // Channel safety net: ensure links reach an away user via the routed
          // text (inert when the reply stays on the dashboard).
          if (undeliveredForChannel.length > 0) {
            const linkBlock = undeliveredForChannel.map(u => `Download: ${u}`).join('\n');
            state = advance(state, {
              lastAssistantTextForIM: `${replyText.trimEnd()}\n\n${linkBlock}`,
            });
          }
          // Dashboard link bubble: only for files NOT already on the canvas.
          if (undeliveredForDashboard.length > 0) {
            const linkBlock = undeliveredForDashboard.map(u => `Download: ${u}`).join('\n');
            const linkMsgId = uuidv4();
            db.prepare(`
              INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
              VALUES (?, ?, 'assistant', ?, ?, datetime('now'))
            `).run(linkMsgId, agentId, linkBlock, turnNumber);
            broadcast({
              type: 'chat:message',
              agentId,
              message: {
                id: linkMsgId, agentId, role: 'assistant' as const,
                content: linkBlock,
                tokenCount: null, modelId: null, cost: null, latencyMs: null,
                createdAt: new Date().toISOString(),
              },
            });
            logger.info('delivered file download link(s) the reply omitted', {
              agentId, count: undeliveredForDashboard.length, turnNumber,
            }, agentId);
          }
        }
        // The entry guard guarantees lastAssistantTextForIM is non-null and the
        // backstop above only ever replaces it with a longer non-null string;
        // the intervening `state = advance(...)` widens the type back to
        // `string | null` for the compiler, so re-assert the invariant once.
        if (state.lastAssistantTextForIM === null) {
          throw new Error('unreachable: lastAssistantTextForIM null after download-link backstop');
        }

        // Turn continuity: this turn produced a terminal reply for its human
        // counterparty. Tagging this turn's messages with the conversation's
        // conv_key (below) is BOTH the durable "served" signal (the next turn
        // moves on to the next waiting conversation rather than re-answering this
        // one, and it survives a restart) AND the content-isolation tag. A turn
        // that ends WITHOUT reaching here (interrupted by a gate/limit mid-task)
        // tags nothing, so the conversation stays waiting and resumes under the
        // SAME counterparty, routing correctly.
        // Tag this turn's OWN messages with the conversation they belong to, so a
        // later turn for a different counterparty never sees this turn's reply or
        // work in its live tail (content bleed across conversations).
        if (chosenConvKey) {
          try { db.prepare(`UPDATE messages SET conv_key = ? WHERE agent_id = ? AND turn_number = ? AND role IN ('assistant','tool') AND conv_key IS NULL`).run(chosenConvKey, agentId, turnNumber); } catch { /* best effort */ }
        }

        const { resolveReplyDestination } = await import('./reply-destination.js');
        const { getPresence, isImessageConfigured } = await import('../../services/presence.js');
        const { sendResponseViaIMessage } = await import('../../services/imessage-bridge.js');

        // Invariant #2 (attribution redesign): an A2A turn's reply goes to the
        // other agent via send_to_agent, its trailing text must NEVER route to
        // a human channel. Without this guard, resolveReplyDestination falls
        // through to the dashboard default and the "away" override then promotes
        // it to iMessage, texting the OWNER an answer meant for another agent
        // (observed: the PM agent's A2A question answered by texting the owner). Force the
        // no-auto-route value ('dashboard' matches none of the channel branches
        // below) when this turn's counterparty is an agent.
        const presenceNow = getPresence();
        // ── Turn-anchored auto-route (phantom-outreach fix, 2026-07-18) ──
        // The 3:32 AM phantom: a background wake with NO inbound this turn produced
        // user-facing text, and this auto-route promoted it to the owner's phone on
        // channel AFFINITY ALONE (owner's recent channel), inboundChannel null, owner
        // not away. Affinity is not consent. Refuse the affinity-only promotion here,
        // at the destination computation (not the send site): downgrade to dashboard.
        // The two affirmative bases survive untouched inside resolveReplyDestination,
        // a human iMessage counterparty (Layer 1) and the away-owner promotion (Layer
        // 2), and the model-initiated imessage_send TOOL path is a separate, explicit
        // act that never reaches here.
        const affinityRefused = affinityPromotionRefusedNoBasis({
          ownerAffinityChannel: ownerAffinityDestination,
          inboundChannel: state.inboundChannel,
          presence: presenceNow,
        });
        if (affinityRefused) {
          logger.info('v2.7.23 route: affinity-only iMessage promotion refused, no inbound this turn and owner not away; text stays in dashboard', {
            agentId, turnNumber, convKey: chosenConvKey ?? null, presence: presenceNow,
          }, agentId);
        }
        const effectiveOwnerAffinity = affinityRefused ? null : ownerAffinityDestination;
        const destination = counterparty.kind === 'agent'
          ? 'dashboard'
          : resolveReplyDestination({
              state,
              presence: presenceNow,
              imessageBridgeConfigured: isImessageConfigured(),
              // RC-10: owner-channel affinity, resolved once at turn start (rate limited
              // per conversation). Only the owner qualifies, never a contact. Nulled
              // above when affinity would be the sole basis (phantom-outreach fix).
              counterpartyIsOwner: counterparty.kind === 'user' && counterparty.relation === 'owner',
              ownerAffinityChannel: effectiveOwnerAffinity,
            });
        // RC-10: if the affinity promotion is what put this reply on iMessage (the away
        // override would have promoted regardless, but affinity is a distinct, rate-
        // limited mechanism), record it so a background-wake storm can't become a text
        // storm. Recorded only when the promotion actually resolves to iMessage AND
        // affinity DROVE it this turn (effectiveOwnerAffinity, so a refused promotion
        // never starts a cooldown) AND the owner is not away; the per-conversation
        // cooldown starts now.
        if (destination === 'imessage' && effectiveOwnerAffinity === 'imessage' && presenceNow !== 'away') {
          recordAffinityPromotion(agentId, ownerAffinityConversationId);
        }

        // ── Settled-context hold (phantom-outreach fix, 2026-07-18) ──
        // The single settled-context tripwire implementation (moved here from the
        // in-loop calibration site so the hold can reach the route decision). This turn
        // started with every visible user conversation already answered; a user-facing
        // outbound with NO inbound this turn (inboundChannel null) and no active human
        // conversation is the phantom shape. For it we withhold the auto-route CHANNEL
        // PUSH: no iMessage/SMS/etc. push fires. This is channel discipline, NOT reply
        // suppression, the reply text stays persisted and visible in the dashboard chat
        // exactly as it already is (design law: never suppress agent replies; only the
        // outbound PUSH is withheld). Carve-outs keep genuine proactive deliveries
        // flowing to an away owner: an A2A turn (forced to dashboard anyway), an engine
        // turn (a scheduler/reminder the agent must deliver), and an engine completion
        // ack (a real "done" for just-finished work, always-ack hard rule) are never
        // held.
        const settledContextHold =
          settledContextWakeTurn &&
          state.inboundChannel === null &&
          counterparty.kind !== 'agent' &&
          !isEngineTurn &&
          !engineCompletionAckThisTurn;
        // Calibration log (2026-07-09 re-answer class + the phantom outcome), one line
        // per settled-wake user-facing outbound, carrying the routing outcome.
        if (settledContextWakeTurn && counterparty.kind !== 'agent') {
          const heldNow = settledContextHold && destination !== 'dashboard';
          logger.warn('settled-context tripwire: user-facing outbound from a wake turn whose visible conversations were all answered; verify it is a genuine delivery and not a re-answer', {
            agentId, turnNumber, convKey: chosenConvKey ?? null,
            inboundChannel: state.inboundChannel, presence: presenceNow, destination,
            outcome: heldNow ? 'held' : (destination === 'dashboard' ? 'dashboard' : `channel:${destination}`),
            explicitSend: Object.values(state.explicitSendThisTurn).some(Boolean),
            snippet: (state.lastAssistantTextForIM ?? '').replace(/\s+/g, ' ').slice(0, 140),
          }, agentId);
        }

        // Outbound routing markers are written via the hoisted
        // persistRoutingMarker helper (defined near deliverEngineUserAck), the
        // single writer shared with the engine-ack channel pushes so the
        // dashboard's "to <recipient> via <channel>" pill wording cannot drift
        // between the two paths.

        // The agent works out details DIRECTLY with whoever it is talking to,
        // including someone it proactively reached on the owner's behalf (the
        // owner asked it to reach a contact). Its reply to that person routes
        // BACK to that person over iMessage; it then brings the result to the
        // owner separately, when it actually has it. That is the whole point of
        // having an agent handle this kind of back-and-forth.
        //
        // This path used to force such a reply to stay in the dashboard, on the
        // assumption the agent's text was a report to the owner, but the agent's
        // reply was addressed to the CONTACT, so a contact-bound message ended up
        // dropped into the owner's chat (the exact failure observed). Removed:
        // a reply to a contact always routes to that contact.
        if (settledContextHold && destination !== 'dashboard') {
          // Held: on this settled wake there is no active conversation to push into,
          // so the auto-route CHANNEL PUSH is withheld. The reply already lives in the
          // dashboard chat (persisted + broadcast above); nothing is deleted or
          // reclassified. Mark it so the dashboard pill reads "held" instead of
          // claiming a channel delivery that never happened.
          persistRoutingMarker('held in dashboard: no active conversation', {
            tool: 'auto-route', channel: 'dashboard', outcome: 'held', detail: 'no active conversation',
          });
          logger.warn('settled-context hold: withheld auto-route channel push (no active conversation); reply stays visible in dashboard', {
            agentId, turnNumber, destination, presence: presenceNow,
          }, agentId);
        } else if (destination === 'imessage' && !state.repliedToCounterpartyThisTurn.imessage && isImessageConfigured()) {
          // Label the badge with the recipient the bridge ACTUALLY delivered
          // to, never a hardcoded default. If the send was suppressed (sender
          // no longer authorized, empty body), skip the marker entirely so we
          // don't claim a delivery that didn't happen.
          // Route to THIS turn's counterparty (stable). counterparty.senderId is the
          // iMessage address for a human iMessage turn; null (proactive/away) lets
          // the bridge fall back to the owner.
          const imRecipient = counterparty.kind === 'user' && counterparty.channel === 'imessage' ? counterparty.senderId : undefined;
          // C8: this reply reached iMessage EITHER because the turn's counterparty is an
          // iMessage contact (imRecipient set → reply to them) OR because the away-override
          // promoted a dashboard/proactive turn to iMessage to reach the OWNER (imRecipient
          // undefined). In the latter case the send is owner-bound by definition, flag it
          // so the bridge routes to the owner, never to a contact (the "owner's reply
          // texted to a contact" bug class).
          const ownerBound = imRecipient === undefined;
          const delivered = sendResponseViaIMessage(state.lastAssistantTextForIM, agentId, imRecipient, ownerBound);
          if (delivered) {
            // C26 tier 3: the engine iMessage auto-route is honestly
            // UNVERIFIABLE (AppleScript/imsg exit code only). Write an
            // exit-code receipt so PM/the user story never pretend delivery
            // was confirmed. Tier 3 imposes no new gate requirement.
            writeToolReceipt({ agentId, tool: 'imessage_send', tier: 3, verified: false, basis: 'exit-code', recipient: delivered.address, sentText: state.lastAssistantTextForIM, detail: { route: 'auto', textLength: state.lastAssistantTextForIM.length } });
            persistRoutingMarker(`iMessage to ${delivered.name}`, {
              tool: 'auto-route', channel: 'imessage', outcome: 'delivered',
              recipientId: delivered.address, recipientDisplay: delivered.name,
              conversationId: currentTurnRoot.get(agentId)?.conversationId ?? null,
            });
            logger.info('v2.7.23: routed reply via iMessage', {
              agentId,
              inboundChannel: state.inboundChannel,
              recipient: delivered.name,
              presence: getPresence(),
              textLength: state.lastAssistantTextForIM.length,
            }, agentId);
          } else {
            logger.info('v2.7.23: iMessage auto-reply suppressed (no valid recipient)', {
              agentId,
              inboundChannel: state.inboundChannel,
            }, agentId);
          }
        } else if (destination === 'teams' && !state.repliedToCounterpartyThisTurn.teams && state.inboundContext?.chatId) {
          // v2.7.24, Teams reply routing. Inbound Teams DM → reply
          // auto-routes back to the same chat_id via teams_send_message.
          // We invoke executeTool with a synthetic ToolCall so the
          // existing dispatcher handles auth, retries, audit logging.
          // Group chats stay 'message_tool' per the resolver (inbound
          // context populates chatType='group' for those), so this only
          // fires for DM-style Teams chats.
          try {
            const tc: ToolCall = {
              id: uuidv4(),
              name: 'teams_send_message',
              arguments: {
                chat_id: state.inboundContext.chatId,
                message: state.lastAssistantTextForIM,
              },
            };
            const result = await executeTool(agentId, tc);
            if (result.isError) {
              logger.warn('v2.7.24: teams auto-reply failed', { agentId, error: result.content }, agentId);
            } else {
              persistRoutingMarker(`Teams to chat ${state.inboundContext.chatId.slice(0, 8)}…`, {
              tool: 'auto-route', channel: 'teams', outcome: 'delivered',
              recipientId: state.inboundContext.chatId, threadRoot: state.inboundContext.chatId,
              conversationId: currentTurnRoot.get(agentId)?.conversationId ?? null,
            });
              logger.info('v2.7.24: routed reply via Teams', {
                agentId,
                chatId: state.inboundContext.chatId,
                textLength: state.lastAssistantTextForIM.length,
              }, agentId);
            }
          } catch (err) {
            logger.warn('v2.7.24: teams auto-reply crashed', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        } else if (destination === 'email' && !state.repliedToCounterpartyThisTurn.email && state.inboundContext?.emailMessageId) {
          // v2.7.24, email reply routing. Only fires when the inbound
          // was a "Re:" from a known safe-sender (set in preflight). For
          // those, the model's terminal text is sent as an in-thread
          // reply via outlook_reply (Outlook) or gmail_reply (Gmail).
          // Random new-email notifications keep the existing "agent
          // decides whether to surface" flow, they get inboundChannel=
          // 'dashboard', not 'email'.
          const toolName = state.inboundContext.emailService === 'gmail' ? 'gmail_reply' : 'outlook_reply';
          try {
            const tc: ToolCall = {
              id: uuidv4(),
              name: toolName,
              arguments: {
                message_id: state.inboundContext.emailMessageId,
                body: state.lastAssistantTextForIM,
                // B-1 (comms-audit): reply FROM the same mailbox that received it.
                // Omitted before, so with 2+ agent accounts the reply silently failed.
                ...(state.inboundContext.emailAccount ? { account: state.inboundContext.emailAccount } : {}),
              },
            };
            const result = await executeTool(agentId, tc);
            if (result.isError) {
              logger.warn('v2.7.24: email auto-reply failed', { agentId, tool: toolName, error: result.content }, agentId);
            } else {
              // Prefer the recipient address (the person we replied to) so the
              // badge reads "to <addr> via email"; fall back to the thread
              // subject form when the address isn't known (recipient stays null,
              // badge falls back to "sent via email reply").
              const emailRecipient = state.inboundContext.recipientAddress;
              const subjectPreview = state.inboundContext.emailSubject?.slice(0, 40) ?? '(no subject)';
              persistRoutingMarker(
                emailRecipient
                  ? `email to ${resolveRecipientDisplay('email', emailRecipient)}`
                  : `email reply (thread: "${subjectPreview}")`,
                {
                  tool: 'auto-route', channel: 'email', outcome: 'delivered',
                  recipientId: emailRecipient ?? null,
                  provider: state.inboundContext.emailService ?? null,
                  conversationId: currentTurnRoot.get(agentId)?.conversationId ?? null,
                },
              );
              logger.info('v2.7.24: routed reply via email', {
                agentId,
                emailService: state.inboundContext.emailService,
                subject: state.inboundContext.emailSubject,
                textLength: state.lastAssistantTextForIM.length,
              }, agentId);
            }
          } catch (err) {
            logger.warn('v2.7.24: email auto-reply crashed', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        } else if (destination === 'phone' && !state.repliedToCounterpartyThisTurn.phone && state.inboundContext?.phoneCallSid) {
          // v2.9.18 - phone call reply routing. The agent just emitted
          // text in response to a caller utterance during an active
          // phone call. Push the text into the call's TTS pipeline so
          // it gets spoken back over the same call.
          // v2.9.23, if streaming TTS already flushed sentences via
          // onChunk above, we ONLY queue whatever tail remains in
          // phoneStreamBuffer. If nothing was streamed (e.g. the
          // model returned in one shot, or onChunk never fired) we
          // fall back to the original one-shot push so we never
          // silently drop the reply.
          try {
            const { getCallSession } = await import('../../twilio/call-session.js');
            const session = getCallSession(state.inboundContext.phoneCallSid);
            if (!session) {
              logger.warn('v2.9.18: phone auto-reply skipped - no active session for callSid', {
                agentId, callSid: state.inboundContext.phoneCallSid,
              }, agentId);
            } else if (session.isEnded()) {
              logger.warn('v2.9.18: phone auto-reply skipped - call already ended', {
                agentId, callSid: state.inboundContext.phoneCallSid,
              }, agentId);
            } else if (phoneStreamFlushedAny) {
              // Streaming path took care of the body. Flush the
              // remaining tail (final sentence without trailing
              // punctuation-plus-whitespace) if any.
              const tail = phoneStreamBuffer.trim();
              if (tail) {
                await session.queueAgentSay(tail);
                phoneStreamBuffer = '';
              }
              persistRoutingMarker(`phone call to ${resolveRecipientDisplay('phone', state.inboundContext.phoneFromNumber ?? '(unknown)')}`, {
                tool: 'auto-route', channel: 'phone', outcome: 'delivered',
                recipientId: state.inboundContext.phoneFromNumber ?? null,
                conversationId: currentTurnRoot.get(agentId)?.conversationId ?? null,
              });
              logger.info('v2.9.23: routed reply via phone TTS (streamed)', {
                agentId,
                callSid: state.inboundContext.phoneCallSid,
                to: state.inboundContext.phoneFromNumber,
                tailLength: tail.length,
                totalTextLength: state.lastAssistantTextForIM.length,
              }, agentId);
            } else {
              await session.queueAgentSay(state.lastAssistantTextForIM);
              persistRoutingMarker(`phone call to ${resolveRecipientDisplay('phone', state.inboundContext.phoneFromNumber ?? '(unknown)')}`, {
                tool: 'auto-route', channel: 'phone', outcome: 'delivered',
                recipientId: state.inboundContext.phoneFromNumber ?? null,
                conversationId: currentTurnRoot.get(agentId)?.conversationId ?? null,
              });
              logger.info('v2.9.18: routed reply via phone TTS', {
                agentId,
                callSid: state.inboundContext.phoneCallSid,
                to: state.inboundContext.phoneFromNumber,
                textLength: state.lastAssistantTextForIM.length,
              }, agentId);
            }
          } catch (err) {
            logger.warn('v2.9.18: phone auto-reply crashed', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        } else if (destination === 'sms' && !state.repliedToCounterpartyThisTurn.sms && state.inboundContext?.smsFromNumber) {
          // v2.9.18 - SMS reply routing. Inbound SMS from a known
          // sender → agent's terminal text auto-routes back via
          // Twilio sendSms to the original sender. From-number is
          // the same Twilio number that received the inbound (so
          // the thread looks continuous on the recipient's phone).
          try {
            const { sendSms } = await import('../../twilio/client.js');
            const { getDefaultFromNumber } = await import('../../twilio/auth.js');
            const fromNumber = state.inboundContext.smsToNumber ?? getDefaultFromNumber();
            if (!fromNumber) {
              logger.warn('v2.9.18: sms auto-reply skipped - no from-number available', { agentId }, agentId);
            } else {
              const r = await sendSms(state.inboundContext.smsFromNumber, state.lastAssistantTextForIM, fromNumber);
              if (!r.ok) {
                logger.warn('v2.9.18: sms auto-reply failed', { agentId, error: r.error }, agentId);
              } else {
                // C26 (FA-C3): the SMS auto-route was the only durable-channel auto-send
                // without a receipt, so a PM/user story could not prove it happened. Write a
                // tier-1 receipt exactly like the sms_send TOOL and the iMessage auto-route:
                // verified on the Twilio SID (provider-id), else http-status. r.data.sid is
                // the SID (sendSms returns { ok, data }, not a flat r.sid). This cannot block a
                // completion, the gate only demands receipts for turns that ran a send TOOL.
                const smsSid = r.data.sid;
                writeToolReceipt({ agentId, tool: 'sms_send', tier: 1, verified: !!smsSid, basis: smsSid ? 'provider-id' : 'http-status', providerId: smsSid ?? null, recipient: state.inboundContext.smsFromNumber, sentText: state.lastAssistantTextForIM, detail: { route: 'auto', textLength: state.lastAssistantTextForIM.length } });
                persistRoutingMarker(`SMS to ${resolveRecipientDisplay('sms', state.inboundContext.smsFromNumber)}`, {
                tool: 'auto-route', channel: 'sms', outcome: 'delivered',
                recipientId: state.inboundContext.smsFromNumber,
                conversationId: currentTurnRoot.get(agentId)?.conversationId ?? null,
              });
                logger.info('v2.9.18: routed reply via SMS', {
                  agentId,
                  to: state.inboundContext.smsFromNumber,
                  from: fromNumber,
                  textLength: state.lastAssistantTextForIM.length,
                }, agentId);
              }
            }
          } catch (err) {
            logger.warn('v2.9.18: sms auto-reply crashed', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        }
      } catch (err) {
        logger.warn('v2.7.23: reply-destination routing failed', {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        }, agentId);
      }
    }

    // v2.9.20, show_to_user end-of-turn safety net.
    //
    // If the turn ended with attachments still queued from
    // show_to_user calls (the model didn't write terminal text
    // after queuing - common failure mode that lost JJ's report on
    // 2026-06-06), surface them now as a final assistant message
    // so they reach the user instead of vanishing. Uses any caption
    // strings the model passed to show_to_user as the bubble text;
    // falls back to a generic "Here are the files for you." when
    // no caption was provided.
    try {
      const { drainPendingAttachmentsWithCaptions } = await import('../pending-attachments.js');
      const stranded = drainPendingAttachmentsWithCaptions(agentId);
      // P6b-2c: the per-session filename dedup died with the durable-rows
      // rekey. delivered_at on the artifact row IS the once-only guarantee; a
      // re-generated file in a later turn is a NEW artifact and legitimately
      // surfaces again (the old filename-history scan suppressed genuine
      // updated versions along with the spam it targeted).
      if (stranded.attachments.length > 0 && counterparty.kind !== 'agent') {
        // Caption: prefer the model's own caption. Otherwise derive an INFORMATIVE
        // line from the deliverables themselves, never a content-free generic
        // "Here are the files for you.". Root reason: that generic line is identical
        // for every uncaptioned deliverable, so two distinct files (blog_migration_plan,
        // team_offsite_july_2026) surfaced on different turns read as duplicate spam in
        // the owner's chat (the owner's run-#9 report). Naming the file makes each surface
        // distinct and tells the owner WHAT it is. We are not hiding a duplicate; we are
        // making the message say what it always should have.
        const describeDeliverables = (atts: Array<{ filename?: string }>): string => {
          const names = atts
            .map(a => (a.filename ?? '').trim())
            .filter(Boolean)
            .map(fn => fn.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim())
            .filter(Boolean);
          if (names.length === 0) return 'Here you go.';
          if (names.length === 1) return `Here's the ${names[0]}.`;
          return `Here are the files:\n${names.map(n => `• ${n}`).join('\n')}`;
        };
        const captionText = stranded.captions.length > 0
          ? stranded.captions.join('\n\n')
          : describeDeliverables(stranded.attachments);
        const synthId = uuidv4();
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, turn_number, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, datetime('now'))
        `).run(synthId, agentId, captionText, JSON.stringify(stranded.attachments), turnNumber);
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: synthId,
            agentId,
            role: 'assistant' as Message['role'],
            content: captionText,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
            attachments: stranded.attachments,
          },
        });
        logger.warn('show_to_user safety net fired - surfaced stranded attachments', {
          agentId,
          fileCount: stranded.attachments.length,
          captionCount: stranded.captions.length,
        }, agentId);
        // A-1/A-2 (comms-audit): this safety net runs AFTER the channel router above,
        // so setting lastAssistantTextForIM here would NEVER route, the stranded
        // deliverable files reached only the dashboard. If the requester is on
        // iMessage, send the FILES (with the caption on the first) to them directly so
        // a file they asked for actually reaches their channel, not just the dashboard.
        if (counterparty.kind === 'user' && counterparty.channel === 'imessage' && counterparty.senderId) {
          try {
            const { sendIMessageWithAttachment } = await import('../../services/imessage-bridge.js');
            let first = true;
            for (const att of stranded.attachments as Array<{ path?: string }>) {
              if (att.path) { sendIMessageWithAttachment(counterparty.senderId, att.path, first ? captionText : ''); first = false; }
            }
          } catch (err) {
            logger.warn('A-1/A-2: stranded-file iMessage delivery failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
          }
        }
        if (stranded.attachments.length > 0) {
          state = advance(state, { lastAssistantTextForIM: captionText });
        }
      }
    } catch (err) {
      logger.warn('show_to_user safety net failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }

    // ── Close-the-loop completion report (attribution redesign §4.5.3, Phase 3) ──
    // The ack-and-ghost fix. When a one-shot task the owner asked for finishes on
    // an A2A turn, the agent's text was suppressed (it was answering another agent
    // / the PM), so the owner never heard "done." Schedule ONE bounded, user-facing
    // follow-up turn so the agent reports what it did. Guarantees:
    //   • Fires ONLY on A2A turns. A normal user turn already wraps up to the user,
    //     so it never double-reports (§9).
    //   • The scheduled turn is engine-triggered (not A2A), so isA2ATurn is false on
    //     it → its reply is NOT suppressed and reaches the owner, and it cannot
    //     re-trigger another completion report (no infinite loop).
    //   • Scoped to completions in THIS turn's window (completed_at >= turnStartedAt),
    //     so each completion is reported at most once across turns.
    //   • One-shot only (repeat_interval IS NULL): recurring/scheduler runs stay
    //     silent per the silent-closeout rule.
    //   • Bounded: the engine prompt says summarize, do not redo.
    if (isA2ATurn) {
      try {
        const justCompleted = db.prepare(`
          SELECT id, title, result FROM tasks
          WHERE assigned_to = ?
            AND status = 'complete'
            AND completed_at >= ?
            AND repeat_interval IS NULL
          ORDER BY completed_at ASC
          LIMIT 5
        `).all(agentId, turnStartedAt) as Array<{ id: string; title: string; result: string | null }>;
        if (justCompleted.length > 0) {
          const taskLines = justCompleted
            .map(t => `  - "${t.title}"${t.result ? `, ${t.result.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`)
            .join('\n');
          const reportMsg = (
            `[Engine event: completion report owed] You just finished work the owner asked for while you were talking to another agent, so they have not seen the result yet:\n` +
            `${taskLines}\n\n` +
            `Send the owner ONE short completion note: that the task(s) named ABOVE are done, plus a one-line note of what you did. Hard limits:\n` +
            `- Mention ONLY the task(s) listed above. Do NOT list, summarize, or mention ANY other tasks, blockers, projects, or your overall status, this is a completion note, not a status report or a "what needs you" rundown.\n` +
            `- One or two sentences, on the owner's channel. Do NOT redo the work or re-run tools.\n` +
            `If there is genuinely nothing worth telling them, reply with [no-reply].`
          );
          const reportId = uuidv4();
          // D-A step 6 closeout: the LAST engine writer moved off `messages` into
          // the inter-agent store (the other five moved in step 4). conv_key NULL
          // keeps it a PENDING engine event: the merged getPendingEngineEvent finds
          // it in the store and the claim branches on its home table, exactly like
          // the scheduler/tracker/healer events. The universal NO_INTERAGENT_LEAK
          // battery invariant now holds absolutely (no by-design exceptions).
          insertInterAgentEngineRow({
      work: null,
            id: reportId,
            agentId,
            content: reportMsg,
            sourceAgentId: null,
            originIntent: 'completion_report',
            convKey: null,
            turnNumber,
          });
          // Queue wakeup so handleMessage's finally fires the report turn.
          pendingWakeups.add(agentId);
          logger.info('v2 close-the-loop: scheduled completion report after A2A turn', {
            agentId, taskCount: justCompleted.length, taskIds: justCompleted.map(t => t.id.slice(0, 8)),
          }, agentId);
        }
      } catch (err) {
        logger.warn('v2 close-the-loop completion-report scheduling failed (non-fatal)', {
          agentId, error: err instanceof Error ? err.message : String(err),
        }, agentId);
      }
    }

    stopStatusHeartbeat(agentId);

    // Clean turn end, clear the in-loop recovery streak. The agent reached
    // a natural exit without further recovery, so any prior recovery
    // attempts are presumed resolved (matches v1 runtime.ts:1404).
    recoveryRunStreak.delete(agentId);

    // Set agent back to idle (unless terminated)
    const currentAgent = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as
      | { status: string }
      | undefined;
    if (currentAgent && currentAgent.status !== 'terminated') {
      setAgentStatus(agentId, 'idle');
    }

    // Reset the persisted recovery_attempts counter on a successful turn.
    // Pre-2026-05-06 the counter only reset inside reset_session, so 3
    // transient errors spread over weeks would silently accumulate and
    // permanently suppress the Healer for the agent until the user
    // manually intervened. Only fire onAgentRecovered when attempts > 0
    // (there was actually something to recover from) to avoid spamming
    // the "recovered" toast on every healthy turn.
    if (currentAgent && currentAgent.status !== 'terminated') {
      try {
        const attemptsRow = db
          .prepare('SELECT recovery_attempts FROM agents WHERE id = ?')
          .get(agentId) as { recovery_attempts: number | null } | undefined;
        if ((attemptsRow?.recovery_attempts ?? 0) > 0) {
          const { onAgentRecovered } = await import('../../healer/injury-recovery.js');
          onAgentRecovered(agentId);
        }
      } catch { /* best effort */ }
    }

    // D14: the per-turn checkTimeouts() call is removed. The 30s interval in
    // index.ts already reaps expired agents; running a full agents-table scan
    // after every single turn was redundant overhead (and, before the sensei
    // fix, an extra path that re-hit the unterminate-able-sensei warn on every
    // turn as well as every 30s).

    // 5a: the injected technique's usage row learns the turn's outcome.
    if (turnInjectedTechniqueId) {
      try {
        const { recordTechniqueOutcome } = await import('../../techniques/store.js');
        recordTechniqueOutcome(turnInjectedTechniqueId, agentId, true);
      } catch { /* best effort */ }
    }

    // Compaction is rare in v2 (Part V). For Phase 2 we skip the post-turn
    // call entirely, the pre-call compactionGate (added in Phase 4) will
    // handle it. v1's post-turn compaction call was the failure mode this
    // whole architecture is fixing.
  } catch (err) {
    // Best-effort cleanup before recovery so heartbeats / abort controllers
    // don't keep firing while the recovery cascade does its DB writes.
    stopStatusHeartbeat(agentId);
    activeAbortControllers.delete(agentId);

    // C2: a throw anywhere AFTER the pickup-stamp (assembleContext, decideTier,
    // enforceModelCapabilities, the grounding INSERT, the assistant/tool persists, 
    // all before the model call's own try/catch owns the error) reaches THIS
    // function-level catch with the human trigger still stamped served at pickup, so
    // the ask would be silently stranded and never re-served (inv 2 + 6).
    // recoverFromError does NOT touch conv_key. reArmIfStrandedNoAnswer re-arms the
    // ask so the drain re-serves it, but ONLY under the clean-retry guard (no reply
    // delivered AND no tool executed this turn). That guard is deliberately
    // conservative: it covers the common, dominant case (a transient model/infra
    // failure on the FIRST call, pre-tool sites like assembleContext / decideTier /
    // enforceModelCapabilities), which is the one we live-verified. It intentionally
    // does NOT re-arm the POST-tool throw sites listed above (grounding INSERT,
    // assistant/tool persists): a turn that already executed a tool may have committed
    // a non-idempotent side effect (created a task, wrote a file, sent a message), and
    // re-serving it would DUPLICATE that side effect, the OPEN-12/duplicate-project
    // class the pickup-stamp exists to prevent. So we accept a narrow residual strand
    // (a post-tool non-model throw that delivered no reply) rather than risk a
    // duplicate; those "did work but didn't reply" cases are owned by the
    // note-then-stopped / going-idle nudges. (The symmetric engine-stamp revert is
    // intentionally left to C6/C7's loss-over-loop handling for engine events, a
    // dropped scheduler tick re-fires next cycle; it is not re-armed here.)
    reArmIfStrandedNoAnswer();

    // 5a: a turn that died with a technique injected counts as a failure
    // signal for that technique.
    if (turnInjectedTechniqueId) {
      try {
        const { recordTechniqueOutcome } = await import('../../techniques/store.js');
        recordTechniqueOutcome(turnInjectedTechniqueId, agentId, false);
      } catch { /* best effort */ }
    }

    // Phase 6 (2026-05-04), v2 now owns its own recovery cascade.
    // recoverFromError handles all side effects: context-overflow recovery,
    // recoverable provider 4xx (with streak cap + system note), or generic
    // injury (recordError + last_error + healer notification + chat:error).
    //
    // No re-throw, handleMessage's outer catch is now a no-op for v2 errors,
    // and any exception escaping recoverFromError is itself logged but
    // swallowed (the agent is already in a degraded state; throwing further
    // would double-handle).
    try {
      const { recoverFromError } = await import('./recovery.js');
      await recoverFromError(state, err);
    } catch (recovErr) {
      logger.error('v2 recovery cascade itself threw, swallowing to avoid double-handle', {
        agentId,
        recoveryError: recovErr instanceof Error ? recovErr.message : String(recovErr),
        originalError: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  } finally {
    // F10: the wall-clock start-ack timer must never outlive its turn. The DB
    // check inside the callback also guards a race where the timer fired just
    // before this clear, but cancelling here is the primary discipline.
    if (startAckTimer) { clearTimeout(startAckTimer); startAckTimer = null; }
    // C15: on EVERY exit path (clean reply, decline, MAX_TOOL_LOOPS, spinning/thrash
    // break, exception) tag THIS turn's own assistant/tool rows with the conversation's
    // conv_key. The clean reply/decline exits (~:2851/:5199) already stamp, but the
    // abort/break paths did not, leaving tool_use/tool_result rows conv_key NULL forever;
    // scopeToHumanConversation keeps untagged self rows as "in-progress work", so an
    // aborted turn's scratch (e.g. a contact's deep-research tool output) bled into the NEXT
    // person's live tail + conversation-scoped recall (inv 4). turn_number scopes it to
    // this turn's own rows only. Independent of C2/C4's TRIGGER revert (which nulls the
    // role='user' trigger row to re-serve the ask; this tags the role in ('assistant',
    // 'tool') rows so they don't leak), different roles, no conflict. On the clean path
    // the rows are already tagged, so `conv_key IS NULL` makes this a no-op. Best-effort.
    if (chosenConvKey) {
      try {
        db.prepare(
          `UPDATE messages SET conv_key = ? WHERE agent_id = ? AND turn_number = ? AND role IN ('assistant','tool') AND conv_key IS NULL`,
        ).run(chosenConvKey, agentId, turnNumber);
      } catch { /* best effort, turn teardown must not throw */ }
      // F9: claim same-conversation sibling user rows that were inside this
      // turn's final assembled context (they got answered by this reply); a
      // burst's second message no longer earns a duplicate answer. Human
      // conversations only, never engine/park sentinels.
      if (
        lastAssembledAtIso &&
        chosenConvKey !== 'engine' &&
        !chosenConvKey.startsWith('park:') &&
        !chosenConvKey.startsWith('relayed:')
      ) {
        try {
          // Abort-safety: only claim siblings when this turn actually persisted
          // an ANSWER for this conversation. A no-answer abort must leave them
          // NULL so the drain re-serves them (never silently dropped).
          const answered = db.prepare(
            `SELECT 1 FROM messages WHERE agent_id = ? AND turn_number = ? AND role = 'assistant' AND conv_key = ? LIMIT 1`,
          ).get(agentId, turnNumber, chosenConvKey);
          const claimed = answered ? claimAssembledSiblings(agentId, chosenConvKey, lastAssembledAtIso, turnNumber) : 0;
          if (claimed > 0) {
            logger.info('F9 batch-claim: claimed sibling rows answered by this turn', { agentId, convKey: chosenConvKey, claimed }, agentId);
          }
        } catch { /* best effort, turn teardown must not throw */ }
      }
    }

    // ── P4 turn record finalize: how this turn ENDED, on every exit path ──
    // Outcome from durable facts + turn-local flags; answer id = this turn's
    // plain assistant reply row. The runtime recovery site covers turns that
    // threw before reaching this finally (outcome='error').
    try {
      const answerRow = db.prepare(
        `SELECT id FROM messages WHERE agent_id = ? AND turn_number = ? AND role = 'assistant'
           AND content NOT LIKE '[{%' AND length(trim(content)) > 0
         ORDER BY rowid DESC LIMIT 1`,
      ).get(agentId, turnNumber) as { id: string } | undefined;
      const parkedRow = !answerRow ? db.prepare(
        `SELECT 1 FROM messages WHERE agent_id = ? AND conv_key LIKE 'park:%' AND created_at >= ? LIMIT 1`,
      ).get(agentId, turnBoundary.get(agentId) ?? new Date().toISOString()) : undefined;
      const handoffRow = !answerRow && !parkedRow ? db.prepare(
        `SELECT 1 FROM inter_agent_messages WHERE agent_id = ? AND turn_number = ? LIMIT 1`,
      ).get(agentId, turnNumber) : undefined;
      const outcome = toolPhaseEndedBySpinBrake ? 'brake'
        : answerRow ? 'answered'
        : parkedRow ? 'parked'
        : handoffRow ? 'handoff'
        : 'no_reply';
      finalizeTurn(agentId, turnNumber, outcome, answerRow?.id ?? null);
      // P8 reply binding for the PHONE lane, riding the P4 answer stamp: the
      // spoken reply row is bound by id to its voice session with speaker
      // 'agent' (the dashboard-voice equivalent happens at the TTS burst's
      // markAssistantMessageVoiced; a call has no burst-side message hook, so
      // the finalize stamp is its binding point).
      if (answerRow && inboundChannel === 'phone' && inboundContext?.phoneCallSid) {
        try {
          const { getVoiceSessionIdForCall, stampSpokenMessage } = await import('../../voice/session-record.js');
          stampSpokenMessage(answerRow.id, 'agent', getVoiceSessionIdForCall(inboundContext.phoneCallSid));
        } catch { /* best effort */ }
      }
      // Per-ask outcome: every row this turn served records the reply that
      // answered it (both stores; sibling rows were stamped served_by_turn in
      // claimAssembledSiblings above).
      if (answerRow) {
        db.prepare('UPDATE messages SET answer_message_id = ? WHERE agent_id = ? AND served_by_turn = ? AND answer_message_id IS NULL')
          .run(answerRow.id, agentId, turnNumber);
        db.prepare('UPDATE inter_agent_messages SET answer_message_id = ? WHERE agent_id = ? AND served_by_turn = ? AND answer_message_id IS NULL')
          .run(answerRow.id, agentId, turnNumber);
      }
    } catch { /* best effort, turn teardown must not throw */ }

    // FA-TS4: pending-attachments teardown net. The three normal drain sites
    // (:~3187 no-reply, :~3365 text-bearing persist) and the end-of-turn safety
    // net (:~6064) all live INSIDE the main turn try, so a throw before terminal
    // routing (e.g. a model 429 mid-loop) skips every one of them and strands the
    // queued show_to_user files in the module-level per-agent buffer. Nothing
    // clears it, so on the NEXT turn (possibly a different conversation) those
    // files would drain onto an unrelated reply. Drain-and-flush here, on EVERY
    // exit path, scoped to THIS turn: surface the files to their own conversation
    // now, then clear so they can never carry forward.
    //
    // Idempotence vs the normal drains: every drain is a destructive read
    // (buffers.delete in pending-attachments.ts). On a clean turn the safety net
    // above already emptied the buffer, so this reads nothing and is a no-op.
    // Only an error/abort path (where that net was skipped) still has content
    // here, and this is then the SOLE drainer, so no double-surface is possible.
    //
    // Degraded delivery: a thrown turn has no clean reply row to ride on and the
    // channel router never ran, so we attach the files to a minimal assistant
    // message in this turn's OWN conversation (conv_key = chosenConvKey) on the
    // dashboard, using the model's show_to_user caption if it left one. We
    // deliberately do NOT re-push to iMessage/voice from teardown: on a thrown
    // turn the channel context may be half-resolved and a channel send is a
    // non-idempotent side effect we won't risk here. The v2.9.20 requirement
    // (queued files are never silently lost) is met via the dashboard surface
    // plus a loud warning.
    try {
      const { drainPendingAttachmentsWithCaptions } = await import('../pending-attachments.js');
      const leftover = drainPendingAttachmentsWithCaptions(agentId);
      if (leftover.attachments.length > 0 && counterparty.kind !== 'agent') {
        const caption = leftover.captions.length > 0
          ? leftover.captions.join('\n\n')
          : 'Here are the files I prepared (the turn ended early).';
        const leftoverId = uuidv4();
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, conv_key, turn_number, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, ?, datetime('now'))
        `).run(leftoverId, agentId, caption, JSON.stringify(leftover.attachments), chosenConvKey, turnNumber);
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: leftoverId, agentId, role: 'assistant' as Message['role'],
            content: caption,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
            attachments: leftover.attachments,
          },
        });
        logger.warn('FA-TS4: flushed stranded show_to_user attachments in turn teardown', {
          agentId, fileCount: leftover.attachments.length, turnNumber,
        }, agentId);
      }
    } catch (err) {
      logger.warn('FA-TS4: teardown attachment flush failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }
}
