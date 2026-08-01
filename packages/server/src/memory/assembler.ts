import type Anthropic from '@anthropic-ai/sdk';
import { renderTaskStamps, renderStepFacts, type TaskStampFields } from '../tracker/task-stamps.js';
import { getDb as getStampDb } from '../db/connection.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { taskScope, msToText, revertCountExpr, stampColumns } from '../work/tracker-view.js';
import { type PromptTurnContext } from '../prompt/assembler.js';
import { conversationKey, type TurnCounterparty } from '../agent/v2/counterparty.js';
import { getContextWindow, getModelOutputCap } from '../agent/model.js';
// PHASE-3 T9: the ONE tool_use ⇄ tool_result pairing repair. The assembler's own second
// copy is deleted; see the call site and `__tests__/one-pairing-repair.test.ts`.
import { repairToolPairing, type PairedMessage } from '../agent/tool-pairing.js';
import { measureAgentToolPayloadTokens } from '../tools/tool-docs.js';
import { getRecentMessages } from './store.js';
import { estimateTokens, contextWindowPolicy, assertSystemPromptFits, SUMMARY_SHARE } from './budget.js';
import {
  fitLanes,
  laneLimit,
  renderScaffoldingAck,
  renderTokens,
  truncateTextLane,
  LANE_PRIORITY,
  POST_BUDGET_LANES,
  POST_BUDGET_RESERVE_TOKENS,
  SCAFFOLDING_ACK_RESERVE_TOKENS,
  type AllocationReport,
  type Lane,
  type LaneCandidate,
  type LaneMessage,
  type LaneRender,
} from './lanes.js';
import { tagMessageLane, tagMessageLanes, collectMessageLaneIds } from './message-lane-tag.js';
import { getContextSummaries } from './dag.js';
import { getLatestBriefing } from './briefing.js';
import { retrieveForContext } from '../vault/retrieval.js';
import { isPMAgent } from '../config/platform.js';
import { buildAssemblyContext, assembleSystemFromRegistry } from '../prompt/registry/assembler.js';
import { MessageSlot, type AssemblyTurnState } from '../prompt/registry/types.js';
// (getRuntimeVersion import removed in Phase 9 Stage 2, single-track v2)
import { turnBoundary, currentTurnConversationId } from '../agent/turn-state.js';
import { currentTurnNumber, readStoredTurnThreshold, CONTINUITY_BRIEF_HORIZON_TURNS } from '../agent/v2/turn-record.js';   // G24
import type { Summary } from './dag.js';
import type { Message } from '@dojo/shared';
// PHASE-3 T5 — the marker taxonomy. Four shapes this file used to spell itself.
import { parseDivider, NEW_SESSION_DIVIDER_LABEL, A2A_INBOUND_RE, TECHNIQUE_FRESH_SENTINEL,
  parseA2AThreadShort, parseTechniqueFreshRead } from '@dojo/shared';

const logger = createLogger('memory-assembler');

// STRIP (PHASE-3 T2): `DEFAULTS.contextThreshold = 0.75`, one of five declarations of one
// number (§T0-C) and the one that disagreed. Requirement preserved: ONE threshold, in
// `memory/budget.ts`, decided by the owner at T0b — 0.96.

// ── Per-tool-result cap (Part V + Part XVIII §A) ──
// Raw tool results stay capped at assembly time so a single oversized
// tool result can't dominate context. Always enforced, the runtime
// version flag was removed in Phase 9 Stage 2.
//
// v2.7.3, raised from 3000 → 15000 tokens. The v2.7.2 release bumped
// file_read's execution cap from 8K → 60K tokens, but the assembler
// re-truncated tool_result blocks back down to 3K (~12K chars, roughly
// "8000 characters" by the user's eyeball estimate) on every subsequent
// turn, so the bigger read at execution time was invisible from turn 2
// onward, defeating the bump. 15K tokens (~60K chars, ~30 pages) lets a
// typical document the agent just read stay intact through the rest of
// the session, while still preventing one runaway result from blowing
// the entire context budget on a 200K-window model.
const V2_MAX_TOOL_RESULT_TOKENS = 15000;

// ── v2 stub-and-store age (Part XVIII §E) ──
// After this many turns, a tool_result message in the assembled context
// gets replaced by a stub. Combined with the vault as long-term memory
// (§C), the agent doesn't need the raw result kept around.
//
// v2.7.3, raised from 5 → 12. Paired with the V2_MAX_TOOL_RESULT_TOKENS
// bump above: lifting the per-result cap didn't help if the result was
// stubbed out 5 turns later. A "read doc → think → make changes" cycle
// routinely spans 6-10 turns; under the old threshold the source doc
// was already gone by the time the agent was acting on it, forcing a
// re-read (and burning the assembler-cap retruncate cycle again). 12
// covers the typical workflow without letting tool results accumulate
// indefinitely on long-running agents. The fresh-tail count (80 on a
// 200K model, 64 on 128K, 40 on 32K) still bounds how many turns are
// ever visible to the assembler, so this number caps "alive within the
// visible window" rather than total memory growth.
export const V2_STUB_AFTER_TURNS = 12;

// v2.7.6, the v2.7.4 1-turn override for technique tool results
// has been REMOVED. It tried to enforce freshness by stubbing
// technique reads on the next turn so the agent would have to
// re-call to access the content. With v2.7.6's technique-ack gate
// (loop.ts: pendingTechniqueAck), every fresh load now forces an
// explicit acknowledgement before any other tool can run, that's
// the engagement enforcement.
//
// Keeping both produced a loop: agent reads → gate engages → agent
// acks → next turn the read is stubbed → agent re-reads → gate
// re-engages → agent re-acks → ... forever. The gate is the
// stronger and correct mechanism; stubbing was a weaker indirect
// attempt at the same goal. Technique reads now use the generic
// V2_STUB_AFTER_TURNS like every other tool result.

// ── Stale-summary scrub against fresh technique reads (v2.7.7) ──
//
// reset_session deliberately preserves summaries to keep project
// context across resets, but pre-existing summaries describe the
// PRIOR version of any technique the agent has freshly re-read this
// session. Real failure mode reported on prod: agent reads the
// current "M365 Campaign Demo Builder" technique, but its summaries
// from the prior session still describe an OLD workflow with a
// `campaign_runner.py` script that no longer exists in the current
// technique. The agent reads the fresh technique correctly, but then
// references the old script because the summary says they used it
// "last time."
//
// Fix: at assembly time, find techniques that have been freshly read
// recently (sentinel-bearing tool_results in the fresh tail). For
// each such technique, replace any summary whose content mentions
// the technique name with a stub. The fresh read is the source of
// truth; summaries describing earlier versions are noise at best
// and contradictions at worst.


function extractFreshlyReadTechniques(messages: Message[]): Set<string> {
  const names = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    let blocks: unknown;
    try {
      blocks = JSON.parse(m.content);
    } catch {
      continue;
    }
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      const b = block as { type?: string; content?: unknown };
      if (b.type !== 'tool_result' || typeof b.content !== 'string') continue;
      // PHASE-3 T5 (E19): this regex was byte-duplicated in agent/v2/loop.ts. ONE extractor.
      const name = parseTechniqueFreshRead(b.content);
      if (name) names.add(name);
    }
  }
  return names;
}

interface SummaryLike { id: string; content: string; tokenCount: number; }

function scrubSummariesAgainstFreshTechniques<S extends SummaryLike>(
  summaries: S[],
  freshTechniqueNames: Set<string>,
): S[] {
  if (freshTechniqueNames.size === 0) return summaries;
  const lowered = [...freshTechniqueNames].map((n) => n.toLowerCase());
  return summaries.map((s) => {
    const contentLower = s.content.toLowerCase();
    const mentionedNames = lowered.filter((n) => contentLower.includes(n));
    if (mentionedNames.length === 0) return s;
    // Restore display-case version of the names for the stub message.
    const displayNames = [...freshTechniqueNames].filter((n) =>
      mentionedNames.includes(n.toLowerCase()),
    );
    const stub =
      `[STALE SUMMARY CLEARED by engine], this summary referenced technique${displayNames.length === 1 ? '' : 's'} ` +
      `"${displayNames.join('", "')}" which you have just read freshly in this session. ` +
      `Summaries describe a PRIOR version of the technique and may reference scripts, workflows, or steps ` +
      `that no longer exist on disk. Use the current technique_read result as the source of truth, do NOT ` +
      `paraphrase from this summary or assume "last time we did X" still applies. If you need detail from ` +
      `the technique, call technique_read again. Original summary was ${s.content.length} chars.`;
    return { ...s, content: stub, tokenCount: estimateTokens(stub) };
  });
}

// Model-aware tail sizing (getFreshTailCount) is imported from store.js: the
// SINGLE source of truth shared with compaction (FA-M3), so the tail count the
// assembler SHOWS always equals the count compaction treats as inside-tail.

// ── Context Assembly ──

type LoopMsg = { role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] };

// ── Per-message time stamps (time-awareness, owner ruled 2026-07-16) ──
//
// The model receives exactly one time datum per call: the current-time line at
// the END of the volatile lane. Every conversation message renders bare, so the
// model cannot compute elapsed time ("how long have I been at this") and
// confabulates durations ("working for hours" two minutes in). Fix: prefix each
// TEXT message in the assembled view with the message's own recorded time, so
// duration questions become subtraction against the current-time footer.
//
// Cache safety, the load-bearing property: a message's created_at never changes
// and the box timezone is stable, so a given row renders BYTE-IDENTICAL on
// every future call. The message lane stays append-only and incremental prompt
// caching is unaffected (unlike relative forms, "2 min ago", which would churn
// every message every turn). Date and year are ALWAYS included: any "today"/
// "yesterday" relativity would mutate a rendered row at midnight and break the
// append-only property. A box timezone change re-forms the cache once, which is
// correct and acceptable.
//
// Scope: plain-text user/assistant rows only. Tool-call/tool-result rows and
// attachment (array-content) rows are NOT stamped: inserting text blocks into
// provider-structured content risks breaking tool_use/tool_result pairing, and
// tool activity's timing is visible from the surrounding stamped turns.

/** SQLite stores "YYYY-MM-DD HH:MM:SS" (UTC, no marker); ISO rows carry T/Z; and from
 *  migration 131 `messages.created_at` is epoch-ms INTEGER, so a NUMBER arrives too.
 *  Normalize all three to an ISO-UTC string Date can parse unambiguously, or null.
 *
 *  T6b, on the number arm: every SQL read that hands a row to TypeScript projects the
 *  column back through `datetime(created_at/1000,'unixepoch')`, so the string form still
 *  arrives here in practice — but the declared type is `string`, typecheck cannot see a
 *  number slipping through, and before this arm a missed projection was a thrown
 *  TypeError inside the assembler (i.e. every turn dying). Now it is the same stamp,
 *  byte-identical, pinned in `__tests__/message-time-stamps.test.ts`. The floor is
 *  `sent_at`'s own CHECK from migration 127 — same quantity, same rejections — so epoch
 *  SECONDS, 0 and negatives render unstamped instead of as a confident wrong date. */
function normalizeCreatedAtUtc(createdAt: string | number): string | null {
  if (typeof createdAt === 'number') {
    return Number.isFinite(createdAt) && createdAt >= 1600000000000
      ? new Date(createdAt).toISOString() : null;
  }
  let s = createdAt.trim();
  if (!s.includes('T')) s = s.replace(' ', 'T');
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
  return s;
}

/**
 * Render a message's recorded time as a compact, deterministic stamp in the
 * box's local timezone: `[Jul 16, 2026, 11:41 AM]`. Same en-US 12-hour family
 * as renderCurrentTimeMessage so the model compares like with like. Returns
 * null for missing/unparseable timestamps (row renders unstamped, never throws).
 */
export function renderMessageTimeStamp(createdAt: string | number | null | undefined): string | null {
  if (!createdAt) return null;
  const iso = normalizeCreatedAtUtc(createdAt);
  if (iso === null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localStr = d.toLocaleString('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return `[${localStr}]`;
}

/**
 * Prefix a plain-text message body with its time stamp. Array content
 * (tool blocks, attachments) and empty/missing stamps pass through untouched.
 */
export function stampTextContent(
  content: string | Anthropic.ContentBlockParam[],
  createdAt: string | number | null | undefined,
): string | Anthropic.ContentBlockParam[] {
  if (typeof content !== 'string' || content.length === 0) return content;
  const stamp = renderMessageTimeStamp(createdAt);
  if (!stamp) return content;
  return `${stamp} ${content}`;
}

/**
 * Integrity pass (R6), the post-combine repairs that make the message array a
 * valid provider request, by construction. Run as one named stage after the
 * scaffolding + fresh tail are combined: prune old images, cap large tool
 * results, strip leading orphans, merge consecutive roles, sanitize orphaned
 * tool blocks, strip a leading tool_result, and pop a trailing assistant.
 *
 * Scope note (mutation ledger B-rows): the PRE-combine cap/budget (B1/B2, "cap
 * BEFORE fit") stays in tail construction by design, and the DELIVERY markers
 * (B12 [New Session] / B13 stop / B14 a2a-preempt) + the empty-context fallback
 * (B11) stay after this pass because they depend on session/config state. This
 * pass is the INTEGRITY core (B3-B10). Byte-equivalent extraction.
 */
function applyIntegrityPass(messages: LoopMsg[], agentId: string): LoopMsg[] {
  pruneOldImageBlocksInPlace(messages, /* maxKeepImages */ 1);
  capLargeToolResultsInPlace(messages);

  // Ensure messages start with user role (Anthropic API requirement). Drop
  // leading assistant messages and pure tool_result messages that reference
  // tool_use IDs no longer in context. Stop at the first real user message.
  while (messages.length > 0) {
    const first = messages[0];
    if (first.role === 'assistant') {
      messages.shift();
      continue;
    }
    if (first.role === 'user' && Array.isArray(first.content)) {
      const blocks = first.content as Array<{ type?: string }>;
      const allToolResults = blocks.length > 0 && blocks.every(b => b.type === 'tool_result');
      if (allToolResults) {
        messages.shift();
        continue;
      }
    }
    break;
  }

  // Ensure alternating roles.
  const merged = mergeConsecutiveRoles(messages);

  // Self-heal: drop orphaned tool blocks so a broken tool_use/tool_result
  // invariant doesn't cause provider errors. Loud warning if >half is dropped.
  //
  // PHASE-3 T9 — STRIP, one owner per job. This used to call the assembler's OWN
  // `sanitizeToolBlocks`, a SECOND implementation of the pairing invariant that T6
  // enumerated for this task. It validated a `tool_use` only against the SINGLE
  // immediately-next message, so N parallel calls answered across TWO consecutive
  // carriers cost a VALID pair — and the only thing that kept that unreachable was
  // `mergeConsecutiveRoles` running one line above, an UNDECLARED coupling that any
  // reorder or second caller would have re-opened in silence.
  // requirement preserved: "no array reaches a provider carrying a `tool_use` nothing
  // answered or a `tool_result` nothing asked for" — now held once, by
  // `agent/tool-pairing.ts:repairToolPairing`, which closes BOTH directions and is the
  // same repair the provider boundary runs. Shown over the divergent input in
  // `memory/__tests__/one-pairing-repair.test.ts`.
  const preSanitizeCount = merged.length;
  const pairingRepair = repairToolPairing(merged as unknown as PairedMessage[]);
  if (pairingRepair.strippedToolUse > 0 || pairingRepair.strippedToolResult > 0) {
    logger.warn('Sanitized orphaned tool blocks from context', {
      droppedToolUse: pairingRepair.strippedToolUse,
      droppedToolResult: pairingRepair.strippedToolResult,
      droppedMessages: pairingRepair.droppedMessages,
    }, agentId);
  }
  if (merged.length < preSanitizeCount / 2 && preSanitizeCount > 4) {
    logger.error('tool-pairing repair dropped over half the context, possible bug', {
      before: preSanitizeCount,
      after: merged.length,
      agentId,
    }, agentId);
  }

  // Final safety: strip any remaining tool_result blocks from the first message.
  if (merged.length > 0 && merged[0].role === 'user' && Array.isArray(merged[0].content)) {
    const firstBlocks = merged[0].content as unknown as Array<Record<string, unknown>>;
    const filtered = firstBlocks.filter(b => b.type !== 'tool_result');
    if (filtered.length < firstBlocks.length) {
      logger.warn('Stripped tool_result blocks from first context message', {
        droppedCount: firstBlocks.length - filtered.length,
      }, agentId);
      if (filtered.length === 0) {
        merged.shift();
      } else {
        merged[0] = { ...merged[0], content: filtered as unknown as Anthropic.ContentBlockParam[] };
      }
    }
  }

  // Ensure the conversation ends with a user message (providers reject a
  // trailing assistant message as prefill). HOW matters enormously: this used
  // to POP trailing assistant messages, which deleted the agent's own newest
  // delivered answer from context on every wake turn, because the awareness
  // lift had just removed the (newer) notification row that followed it. The
  // model then saw its last turn as promised-and-computed-but-never-delivered,
  // and dutifully re-delivered, the months-long re-answer ghost (owner
  // transcripts 2026-07-07/09/10, reproduced live on dev). Append a neutral
  // engine line instead: the API constraint is satisfied, nothing is deleted.
  if (merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
    merged.push(tagMessageLane({
      role: 'user',
      content:
        '[Engine: end of recorded history. Everything above, including your own final ' +
        'replies, was already delivered to its recipients. Continue from the newest ' +
        'event of THIS turn; do not re-send or re-answer anything above.]',
    }, 'lane.engine-end-of-history'));
  }

  return merged;
}

export interface AssembledContext {
  systemPrompt: string;
  // C28 Part 1 (P-2, defense-in-depth): a system-side lane for any content that
  // must live in the system role yet is volatile per turn. It renders AFTER the
  // cached stable system block (Anthropic: a second uncached text block;
  // OpenRouter: a second unmarked system message), so it can never invalidate the
  // cached prefix. EMPTY after P-1 (all volatile content moved to msg.turn-context);
  // the Part 3 determinism check asserts it stays empty.
  systemVolatile: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>;
  /**
   * Registry path only: the entry id that produced each system-prompt part
   * (aligned to parts) / each message. Fed to the context receipt so it shows
   * which registered injections fired. Undefined on the legacy path.
   */
  systemEntryIds?: (string | null)[];
  messageEntryIds?: (string | null)[];
  /**
   * FA-M1: how many fresh-tail messages budgetFreshTail dropped to fit the window
   * on this assembly (oldest-first, whole groups). >0 means the model lost recent
   * turns from its live view; the loop surfaces this as a warning. The dropped rows
   * are persisted and later summarized, so it is live-view loss, not data loss.
   */
  freshTailDropped?: number;
  /**
   * PHASE-3 T4: what this assembly set aside for tool schemas + output, MEASURED — the
   * tools payload this agent's transport will serialise plus the derived output allowance.
   * The loop reads it to size the compaction gate's compressible budget; before T4 it
   * imported a 15,000 constant that was smaller than the primary's tool schemas alone.
   */
  reserveTokens?: number;
  /**
   * PHASE-3 T3: the allocator's own record — one grant per lane, INCLUDING the rejected and
   * the truncated ones, plus every recorded over-budget event. Before this, a section the
   * budget dropped produced a byte-identical context to a section that never existed
   * (research 06 §8). Undefined on the PM path until T6 gives it the same shape (F22).
   */
  allocation?: AllocationReport;
  /**
   * PHASE-3 T3 / S3 — ASSEMBLY IS PURE. The one-shot engine markers (A2A preempt, Stop) are
   * READ here and CLEARED by the turn that owns them (`agent/v2/loop.ts`). Assembly used to
   * `UPDATE agents SET config` from its own read path, so any probe, retry or dry-run
   * silently consumed a marker the user had earned.
   */
  consumedOneShotFlags?: ConsumedOneShotFlags;
}

/** One-shot agent-config markers an assembly consumed; the turn clears them (S3). */
export interface ConsumedOneShotFlags {
  a2aPreemptPending?: boolean;
  stopMarkerPending?: boolean;
}

/**
 * Assemble the full per-turn context (system prompt + message array). The
 * declarative registry is the sole assembler: the registry walker produces the
 * system prompt and the message-context builder produces the messages. The
 * `prompt_assembler_mode` flag, the parallel legacy system-prompt builder, and
 * the shadow guard were all removed once the registry was verified byte-identical
 * to legacy for every agent type. See DOJO-PROMPT-REGISTRY-PLAN.md.
 */
export async function assembleContext(
  agentId: string,
  modelId: string,
  turnContext?: PromptTurnContext,
  turnState?: AssemblyTurnState,
): Promise<AssembledContext> {
  return assembleContextViaRegistry(agentId, modelId, turnContext, turnState);
}

/**
 * The assembler. The registry walker produces the system prompt; the message-
 * context builder produces the message array, budgeted against that system
 * prompt's size, and threads the per-slot entry ids to the receipt.
 *
 * Through R7 this ran a shadow comparison against a parallel legacy system-
 * prompt build and shipped legacy on any drift. Once the registry was verified
 * byte-identical to legacy for every agent type, the legacy system build and
 * the shadow guard were deleted; the registry is now the sole source.
 */
async function assembleContextViaRegistry(
  agentId: string,
  modelId: string,
  turnContext?: PromptTurnContext,
  turnState?: AssemblyTurnState,
): Promise<AssembledContext> {
  const ctx = buildAssemblyContext(agentId, modelId, turnContext, turnState);
  const sys = assembleSystemFromRegistry(ctx);
  // C28 Part 1: the counterparty header, the othersWaiting head-of-line hint, and
  // the conversational-turn hint used to be appended to the system string HERE
  // (small but volatile, they broke prompt caching on every counterparty / waiting
  // / turn-type change). They now render inside the msg.turn-context near-tail
  // engine message (prompt/registry/entries.ts renderTurnContext), so the system
  // prefix stays byte-stable and cacheable across those changes.
  const systemPrompt = sys.text;
  const built = await assembleMessageContext(agentId, modelId, systemPrompt, turnContext);
  // systemVolatile is empty after P-1 (all per-turn volatile content moved to the
  // msg.turn-context tail); the field is the reserved system-side lane (P-2).
  //
  // SPREAD, not a hand-listed set of fields. This wrapper used to destructure
  // `{ messages, freshTailDropped }` and rebuild the object, which silently DROPPED
  // PHASE-3 T3's `allocation` and `consumedOneShotFlags` on their first live run — the
  // second would have left every one-shot A2A-preempt / Stop marker uncleared forever.
  // A re-listing wrapper is a place for a field to die quietly; the spread cannot do that.
  return { ...built, systemPrompt, systemVolatile: '', systemEntryIds: sys.entryIds };
}

// PHASE-3 T5: `A2A_INBOUND_RE` is IMPORTED. It was declared here WITHOUT `/i` and again in
// compaction.ts WITH it — research 06 §5's seed pair. Still only the prose FALLBACK; the
// primary signal remains the structured `origin.kind === 'agent'`.

/**
 * RC-5.4: build a compact awareness-lane gist for a mailbox/channel notification from
 * its STRUCTURED inbound_meta (sender + subject) plus a short preview lifted from the
 * notification body, instead of slicing 400 chars of boilerplate (the MAILBOX EVENT
 * preamble alone is ~407 chars, so the raw slice often carried no actual email
 * metadata). Returns null when no structured meta is present, so the caller falls back
 * to the raw slice. Pure.
 */
function buildAwarenessGist(inboundMetaRaw: string | null | undefined, rawContent: string): string | null {
  if (!inboundMetaRaw) return null;
  let meta: { sender?: string | null; emailSubject?: string | null } | null = null;
  try {
    meta = JSON.parse(inboundMetaRaw) as { sender?: string | null; emailSubject?: string | null };
  } catch {
    return null;
  }
  const sender = (meta?.sender ?? '').toString().trim();
  const subject = (meta?.emailSubject ?? '').toString().trim();
  // Nothing structured to lean on, let the caller use its raw-slice fallback.
  if (!sender && !subject) return null;
  // The mailbox watchers include a "Preview: <snippet>" line in the body; lift it as a
  // short preview (subject is the headline; preview is the flavor).
  const previewMatch = /(?:^|\n)\s*Preview:\s*([^\n]+)/i.exec(rawContent);
  const preview = previewMatch ? previewMatch[1].replace(/\s+/g, ' ').trim() : '';
  const parts: string[] = [];
  if (sender) parts.push(`from ${sender}`);
  if (subject) parts.push(`subject: "${subject.slice(0, 140)}"`);
  if (preview) parts.push(preview.slice(0, 160));
  return parts.join(' | ');
}

/**
 * Remove inter-agent traffic from a fresh tail for a normal/user turn:
 *   (a) inbound A2A messages (role='user' with origin.kind==='agent'),
 *   (b) the agent's own send_to_agent / broadcast_to_group tool calls,
 *   (c) the tool_results paired to those calls (matched by tool_use_id).
 * This is what keeps inter-agent traffic OUT of the primary's HUMAN conversation so
 * it isn't confused about who it's talking to, the a2a message still exists in the
 * store (dashboard wordy mode shows it) and is seen by the receiver on its own A2A
 * turn; it just doesn't bleed into a human turn. Keys on STRUCTURED origin, not prose
 * (the marker regex is only a fallback for rows lacking origin). Pure, no DB writes.
 */
function stripA2AFromTail(tail: Message[]): Message[] {
  const a2aToolIds = new Set<string>();
  for (const m of tail) {
    if (m.role !== 'assistant') continue;
    try {
      const blocks = JSON.parse(m.content);
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b && b.type === 'tool_use' && (b.name === 'send_to_agent' || b.name === 'broadcast_to_group') && b.id) {
            a2aToolIds.add(b.id);
          }
        }
      }
    } catch { /* non-JSON assistant text, nothing to scan */ }
  }
  const isA2AAssistant = (content: string): boolean => {
    try {
      const blocks = JSON.parse(content);
      return Array.isArray(blocks) && blocks.some((b) => b && b.type === 'tool_use' && (b.name === 'send_to_agent' || b.name === 'broadcast_to_group'));
    } catch { return false; }
  };
  const isA2AToolResult = (content: string): boolean => {
    try {
      const blocks = JSON.parse(content);
      return Array.isArray(blocks) && blocks.some((b) => b && b.type === 'tool_result' && a2aToolIds.has(b.tool_use_id));
    } catch { return false; }
  };
  return tail.filter((m) => {
    // Structural first: an inbound A2A row is origin.kind==='agent' (from the a2a
    // columns). Fall back to the prose marker only when origin is absent (legacy rows).
    if (m.role === 'user' && (m.origin?.kind === 'agent' || A2A_INBOUND_RE.test(m.content ?? ''))) return false;
    if (m.role === 'assistant' && isA2AAssistant(m.content ?? '')) return false;
    if (m.role === 'tool' && isA2AToolResult(m.content ?? '')) return false;
    return true;
  });
}

/**
 * Scope a fresh tail to a single A2A thread (attribution redesign, Phase 4).
 * On a dedicated A2A turn the live conversation is JUST that thread plus the
 * agent's own output, the human's inbound messages, other A2A threads, and
 * engine events are excluded so the agent never conflates the user with the
 * agent it's replying to. The agent answers questions about the user's work
 * from MEMORY (vault/summaries/tracker), which is assembled separately. Uses
 * structured origin (deriveOrigin), no marker regex.
 */
function scopeToA2AThread(tail: Message[], threadId: string | null): Message[] {
  // The message's origin.threadId is the FULL a2a_thread_id (36-char UUID from
  // the column). The turn's counterparty.threadId (passed here as `threadId`) is
  // the 8-char SHORT id parsed from the "[A2A:… thread:xxxxxxxx …]" marker
  // (resolveTurnCounterparty → a2aThreadShort). C-2 hardened this to a FULL-id
  // equality to stop two prefix-sharing threads bleeding, but exact-equality
  // then NEVER matched short-vs-full, so scopeToA2AThread dropped THIS thread's
  // own inbound task from every A2A turn. That left a tool-only tail the
  // integrity pass consumed to zero, starving worker agents mid-delegation
  // (behav-sig:ca67b479). Compare canonically: exact match stays the primary
  // case (full==full / short==short, C-2's determinism preserved); otherwise
  // treat the shorter id as an ≥8-char prefix of the longer (the short IS the
  // full UUID's first 8 hex). Two genuinely distinct threads for one agent's
  // live work colliding on 8 hex chars is the negligible case C-2 guarded, and
  // exact-equality still wins whenever both ids are full.
  const sameThread = (t?: string | null): boolean => {
    if (!t || !threadId) return false;
    if (t === threadId) return true;
    const short = t.length <= threadId.length ? t : threadId;
    const long = t.length <= threadId.length ? threadId : t;
    return short.length >= 8 && long.startsWith(short);
  };
  return tail.filter((m) => {
    const o = m.origin;
    if (!o) return true;                                  // unclassified, keep
    if (o.kind === 'agent') return sameThread(o.threadId); // only THIS thread's A2A
    if (o.kind === 'self') {
      // Keep the agent's tool activity (JSON content blocks) and its A2A sends;
      // drop standalone user-facing reply TEXT (and engine acks) so the user
      // conversation doesn't bleed into the A2A turn even via the agent's own
      // prior lines. (m.content for tool_use/tool_result is a JSON array.)
      // Tool activity STAMPED FOR A HUMAN CONVERSATION is dropped too: a served
      // human turn's leftover tool debris (minus its conv-stamped answer, which
      // the text rule above already drops) otherwise reads as an unfinished job
      // and the agent re-does settled work at its A2A counterparty (the
      // re-answer ghost, same root as the human/engine scopers).
      //
      // PHASE-2 T10I: "is this a HUMAN stamp" used to be spelled by EXCLUDING two sentinel
      // shapes from the key (`!== 'a2a'`, `!startsWith('engine')`) — a test that depended on
      // the engine writing a fake key and on that list staying in step with ten writers of it.
      // requirement preserved exactly: an own-output row belonging to a human conversation is
      // dropped from an A2A turn's tail.
      const isToolActivity = typeof m.content === 'string' && m.content.trimStart().startsWith('[{');
      // `Message` carries no `lane` (it is a row column, not part of the assembler's view),
      // so "not an a2a stamp" is read off the origin's channel — the same fact, from the
      // signal this function is already branching on.
      const humanStamped = !!m.conversationId && o.channel !== 'a2a';
      return (isToolActivity && !humanStamped) || o.channel === 'a2a';
    }
    return false;                                          // exclude human + engine
  });
}

/**
 * Scope a fresh tail for an ENGINE turn (a scheduler task / reminder firing).
 * (OPEN-11.) An engine turn is the engine asking the agent to execute a
 * specific task, it is NOT a conversation with the owner, even though the
 * trigger row is stored as role='user'. Before this, an engine turn synthesized
 * an owner/dashboard counterparty and took scopeToHumanConversation, which kept
 * the owner's whole recent tail live, so an hour-old, already-answered request
 * (e.g. "give me a RAM rundown") sat at full salience and the model ran THAT
 * instead of the scheduled task (the gastro-digest hijack). Here we drop the
 * human conversation entirely: the task lives in the ACTIVE USER DIRECTIVE (the
 * engine event) and the EVENTS lane, and the agent works it from there + memory,
 * exactly the way an A2A turn answers from memory rather than the raw user tail.
 * Keeps: the agent's own current-turn work (untagged / tool activity) and engine
 * events (the caller lifts those into the EVENTS lane). Drops: all human inbound
 * and all A2A.
 */
function scopeToEngineTurn(tail: Message[]): Message[] {
  return tail.filter((m) => {
    const o = m.origin;
    // Unclassified rows (tool-role rows have no derivable origin) follow the
    // same rule as classified self output below: a conv-stamped row belongs to
    // a prior conversation's turn and is dropped; only untagged (current-turn
    // in-flight / legacy) rows keep the old safe default. Without this, a
    // settled turn's tool debris leaked into engine turns even after the
    // haiku-failure fix dropped the conv-stamped SELF rows.
    if (!o) return !m.conversationId;
    if (o.kind === 'engine') return true;      // kept; EVENTS lane lifts it out
    if (o.kind === 'self') {
      // Keep ONLY the current turn's own work (untagged — `conversation_id` is stamped at
      // turn END on own output, deliberately). Any self message stamped with a PRIOR
      // conversation, including its tool RESULTS, is dropped. This is stricter than the A2A
      // scoper on purpose: the bug it fixes is the engine turn regenerating a
      // stale human request's answer from that request's leftover tool results
      // (a scheduled haiku task re-emitted the previous "memory rundown" because
      // the rundown's exec results, tagged for the human conversation, were tool
      // activity and survived). A scheduled task works from its directive + fresh
      // tools, never a prior conversation's loaded data.
      return !m.conversationId;
    }
    return false;                              // drop human + agent inbound
  });
}

/**
 * Scope a fresh tail to the ONE human conversation this turn addresses
 * (attribution redesign, Phase 4, human side). The A2A-turn path has its own
 * scoper above; this is the human-turn equivalent and closes the gap that let
 * a DIFFERENT human's inbound (e.g. a friend on iMessage) sit in, and then
 * get merged with, the owner's dashboard turn. Without it the model saw
 * "[SOURCE: IMESSAGE FROM a contact] dinner? <the owner's question>" as one message
 * and could not tell who asked what, the exact conflation this redesign kills.
 *
 * Keeps: messages whose origin resolves to the SAME conversation as the
 * counterparty (same channel + sender, via conversationKey), the agent's own
 * output (A2A sends already stripped), and engine events (which the caller then
 * lifts into the EVENTS lane). Drops: every other human's inbound and all A2A.
 * Falls back to the A2A-only strip when there's no counterparty (legacy path).
 *
 * Exported for the RC-1 no-bleed regression tests (memory/__tests__): the dual-home
 * echo row must land in the RECIPIENT's scoped tail and NOWHERE else, and no other
 * conversation's user rows may ever cross into a turn's scoped tail.
 */
export function scopeToHumanConversation(
  tail: Message[],
  cp: TurnCounterparty | undefined,
  /** PHASE-2 T10I: the counterparty's conversation as `conversations.id`, resolved once by the
   *  turn at pickup and handed down. The INBOUND half below still matches on
   *  `conversationKey()` — a human row's membership is decided from its ORIGIN, which the row
   *  carries in full, and that function is the one matcher for the question. The OWN-OUTPUT
   *  half needs the FK: a self row has no origin to key on, so its membership IS the stamp.
   *  Null = no resolved conversation, and own output falls back to "is it unstamped". */
  cpConversationId?: string | null,
): Message[] {
  const a2aStripped = stripA2AFromTail(tail);
  if (!cp) return a2aStripped;
  const cpKey = conversationKey(cp.channel, cp.senderId, cp.name, cp.threadId);
  return a2aStripped.filter((m) => {
    const o = m.origin;
    if (o?.kind === 'user') {
      // Unauthorized human inbound (a mailbox notification about the owner's inbox,
      // an unknown sender) is NOT a conversation. Keep it so the caller can lift it
      // into the EVENTS/awareness lane (surfaced to the owner, never answered as
      // chat). Authorized human inbound stays in the live tail only if it's THIS
      // counterparty's conversation; other humans get their own turn.
      if (!o.authorized) return true;
      return conversationKey(o.channel, o.senderId, o.senderName, o.threadId) === cpKey;
    }
    // engine → EVENTS lane (handled by the caller); keep here.
    if (o?.kind === 'engine') return true;
    // EVERYTHING ELSE is the agent's own turn output: final reply text, engine
    // acks, tool calls, and tool RESULTS, however deriveOrigin classified them
    // (tool-role rows come through unclassified). A turn's output belongs to
    // its conversation AS A UNIT: `conversation_id` is that stamp, and it must gate the
    // debris exactly like the answer. The old shape kept unclassified rows
    // unconditionally while dropping the conv-stamped final reply, so a turn
    // scoped elsewhere saw a settled turn's promise + tool math WITHOUT its
    // delivered answer, an apparently unfinished job the model then dutifully
    // finished, re-answering the user (the months-long re-answer ghost; owner
    // transcripts 2026-07-07 and 2026-07-09, reproduced on dev 2026-07-10).
    // Same rule the engine scoper adopted for the identical bug (the re-emitted
    // memory-rundown haiku failure), now applied symmetrically. Untagged rows
    // (current-turn in-flight work, legacy pre-076 history) are kept.
    return !m.conversationId || m.conversationId === cpConversationId;
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════
// THE MESSAGE CONTEXT, BUILT FROM THE LANE TABLE (PHASE-3 T3, requirements B4–B8).
//
// What stood here before, measured by reading at `8f36cdb` (§T0-B): twelve independent
// admission gates in build order, two adds with no gate at all, an EVENTS push with neither
// gate nor add, 41 bare numeric literals, and a hardcoded ack that told the model the
// priority order was the exact reverse of the one the budget spent. `usedTokens` was
// write-only past the gates.
//
// Now: every section is a LANE (`memory/lanes.ts`) that declares its id, its priority, its
// floor, its ceiling, its position and its own `truncate()`. The lanes render, the two-pass
// fit decides, and every decision — including every rejection — lands in an
// `AllocationReport` that also GENERATES the ack, so the array can no longer claim a
// section the budget dropped.
// ════════════════════════════════════════════════════════════════════════════════════════

/** The bundle every lane render reads. Built once per assembly; the expensive parts lazily. */
interface LaneRenderCtx {
  agentId: string;
  modelId: string;
  contextWindow: number;
  policy: ReturnType<typeof contextWindowPolicy>;
  turnContext?: PromptTurnContext;
  shouldFireScaffolding: boolean;
  /** Scoped live tail + the awareness rows lifted out of it. Computed once. */
  tail: () => { freshTail: Message[]; awarenessEvents: Message[] };
  /** Scrubbed context summaries. Computed once. */
  summaries: () => Summary[];
}

/** Every lane declares a floor of at least this — a header and a sentence still say something. */
const MIN_LANE_FLOOR_TOKENS = 64;

type TailPayload = { rows: Message[]; agentId: string; dropped: number };

/**
 * COST OF CARRYING ONE STORED ROW. One owner for the expression `budgetFreshTail` and the
 * fresh-tail lane both spend, with the floor the write path has always applied.
 *
 * PHASE-3 T3, found by the allocator on its first live run: the expression was
 * `msg.tokenCount ?? estimateTokens(msg.content)`, and `0 ?? x` is **0** — so a row whose
 * stored `token_count` is 0 was FREE TO CARRY. `memory/budget.ts:estimateStoredTokens`
 * already carries the floor ("a row that costs nothing to carry does not exist") and the
 * READ side never applied it. §T0-D measured 116 such rows on this body before T2's
 * migration `150` re-computed every row to `MAX(1, …)`; the defect is latent on a migrated
 * body and immediate for any writer that bypasses `memory/message-store.ts` — the kit's own
 * golden fixture is one, and it is how this surfaced (six rows, all `token_count = 0`, a
 * whole fresh tail costed at zero).
 *
 * `||` not `??`, deliberately: a stored 0 is not a measurement, it is a missing one.
 */
function storedRowCost(m: Message): number {
  return Math.max(1, m.tokenCount || estimateTokens(m.content));
}

/** Cost of carrying stored rows, the unit `budgetFreshTail` spends (canonical since T2). */
function rowTokens(rows: Message[]): number {
  return rows.reduce((t, m) => t + storedRowCost(m), 0);
}

function textRender(content: string | null): LaneRender | null {
  if (!content) return null;
  const messages: LaneMessage[] = [{ role: 'user', content }];
  return { messages, tokens: renderTokens(messages) };
}

/**
 * THE LANE TABLE. Priority is data here and nowhere else; `slot` is position and is
 * independent of it (the briefing is emitted FIRST and drops FIRST — see `lanes.ts`).
 * Every entry carries a `truncate`, so a lane under pressure is shortened, not deleted.
 */
function buildContentLanes(contentBudget: number): Array<Lane<LaneRenderCtx, unknown>> {
  const lim = (id: string, g: 'rows' | 'chars' | 'tokens' | 'retrieval', k: string) => laneLimit(id, g, k);
  // §T0-B E `:1595` — `min(available * 0.7, 6000)`. The SHARE survives as this lane's
  // ceiling (it is the same 0.7 `memory/budget.ts` hands the compaction gate, so the gate's
  // model of the assembler cannot drift from it again); the "available" it multiplies is now
  // the declared content budget rather than "whatever two earlier gates happened to leave".
  const summariesCeiling = Math.min(
    Math.floor(contentBudget * SUMMARY_SHARE),
    laneLimit('lane.summaries', 'tokens', 'relevanceBudget'),
  );
  return [
    {
      id: 'lane.briefing',
      slot: MessageSlot.MorningBriefing,
      priority: LANE_PRIORITY['lane.briefing'],
      minTokens: 0,
      maxTokens: Infinity,
      truncate: truncateTextLane,
      render: (ctx) => {
        if (!ctx.shouldFireScaffolding) return null;
        const briefing = getLatestBriefing(ctx.agentId);
        if (!briefing) return null;
        return textRender(
          `<briefing generated="${new Date().toISOString().split('T')[0]}">\n${briefing.content}\n</briefing>`,
        );
      },
    },
    {
      id: 'lane.vault',
      slot: MessageSlot.VaultPull,
      priority: LANE_PRIORITY['lane.vault'],
      minTokens: 0,
      maxTokens: Infinity,
      truncate: truncateTextLane,
      render: async (ctx) => {
        if (!ctx.shouldFireScaffolding) return null;
        try {
          const recentForQuery = getRecentMessages(ctx.agentId, lim('lane.vault', 'rows', 'queryMessages'));
          let queryText = recentForQuery.map((m) => m.content).join(' ').slice(0, lim('lane.vault', 'chars', 'query'));
          if (queryText.length <= 10) {
            queryText = 'current projects active tasks recent work status updates decisions';
          }
          const vaultResult = await retrieveForContext(queryText, ctx.contextWindow, ctx.agentId);
          const sections: string[] = [];
          if (vaultResult.section) sections.push(vaultResult.section);
          try {
            const { getSessionContextEntries } = await import('../vault/store.js');
            const sessionCtx = getSessionContextEntries(ctx.agentId);
            const alreadyIncluded = new Set(vaultResult.entryIds);
            const fresh = sessionCtx.filter((e) => !alreadyIncluded.has(e.id));
            if (fresh.length > 0) {
              const lines = fresh.map((e) => `[${e.type}] ${e.content}`);
              sections.push(
                `═══ SESSION CONTEXT (vault entries tagged session_context) ═══\n${lines.join('\n\n')}\n═══ END SESSION CONTEXT ═══`,
              );
            }
          } catch { /* best effort */ }
          return sections.length > 0 ? textRender(sections.join('\n\n')) : null;
        } catch (err) {
          logger.warn('Vault context injection failed', {
            error: err instanceof Error ? err.message : String(err),
          }, ctx.agentId);
          return null;
        }
      },
    },
    {
      id: 'lane.summaries',
      slot: MessageSlot.Summaries,
      priority: LANE_PRIORITY['lane.summaries'],
      minTokens: 0,
      maxTokens: summariesCeiling,
      truncate: truncateTextLane,
      render: async (ctx) => {
        const summaries = ctx.summaries();
        if (summaries.length === 0) return null;
        const chosen = await selectSummariesByRelevance(summaries, summariesCeiling, ctx.agentId);
        if (chosen.length === 0) return null;
        const summaryText = chosen.map((s) => formatSummaryXml(s)).join('\n\n');
        return textRender(
          `═══ COMPRESSED HISTORY (summaries of earlier messages, not live conversation) ═══\nThe following are compressed summaries of older conversation history. These capture key facts and decisions but are NOT live messages. Do not respond to them directly, they are context only. Any "couldn't do X" / "not supported" noted here may be outdated (the platform gains tools over time); check your current tool list before repeating it.\n\n${summaryText}\n\n═══ END COMPRESSED HISTORY ═══`,
        );
      },
    },
    {
      id: 'lane.relevant-memory',
      slot: MessageSlot.RelevantMemory,
      priority: LANE_PRIORITY['lane.relevant-memory'],
      minTokens: 0,
      maxTokens:
        laneLimit('lane.relevant-memory', 'tokens', 'messageBudget') +
        laneLimit('lane.relevant-memory', 'tokens', 'vaultBudget'),
      truncate: truncateTextLane,
      render: async (ctx) => {
        try {
          return textRender(await buildRelevantMemoryBlock(ctx.agentId, !ctx.shouldFireScaffolding, ctx.policy));
        } catch (err) {
          logger.debug('relevant-memory block failed', {
            error: err instanceof Error ? err.message : String(err),
          }, ctx.agentId);
          return null;
        }
      },
    },
    {
      id: 'lane.attempt-ledger',
      slot: MessageSlot.AttemptLedger,
      priority: LANE_PRIORITY['lane.attempt-ledger'],
      minTokens: 0,
      // §T0-B B `:914` was a DOUBLE gate — `< 800` AND `< remaining`. The 800 is a lane
      // ceiling and the remaining-check is the allocator's job; one number, one owner.
      maxTokens: laneLimit('lane.attempt-ledger', 'tokens', 'cap'),
      truncate: truncateTextLane,
      render: async (ctx) => {
        try {
          const { listTasks } = await import('../tracker/schema.js');
          const { getRecentObservations, getRecentTransitions, formatEntryLine } = await import('../tracker/task-log.js');
          const activeForLedger = listTasks({ status: 'in_progress', assignedTo: ctx.agentId })
            .slice(0, lim('lane.attempt-ledger', 'rows', 'tasks'));
          const sections: string[] = [];
          for (const task of activeForLedger) {
            const entries = [
              ...getRecentObservations(task.id, lim('lane.attempt-ledger', 'rows', 'observations')),
              ...getRecentTransitions(task.id, lim('lane.attempt-ledger', 'rows', 'transitions')),
            ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .slice(-lim('lane.attempt-ledger', 'rows', 'entries'));
            if (entries.length === 0) continue;
            let revertNote = '';
            try {
              const row = getDb().prepare(`SELECT ${revertCountExpr('w')} AS revert_count FROM work w WHERE w.id = ?`)
                .get(task.id) as { revert_count: number | null } | undefined;
              if (row?.revert_count) revertNote = `, reverted ${row.revert_count}x already`;
            } catch { /* column may not exist on old DBs */ }
            sections.push(`Task "${task.title}"${revertNote}:\n${entries.map((e) => `  ${formatEntryLine(e)}`).join('\n')}`);
          }
          if (sections.length === 0) return null;
          return textRender(
            `═══ ATTEMPT LEDGER (engine record of work on your active tasks, do not repeat attempts already logged here) ═══\n${sections.join('\n\n')}\n═══ END ATTEMPT LEDGER ═══`,
          );
        } catch { return null; /* tracker may be empty or absent */ }
      },
    },
    {
      id: 'lane.active-tasks',
      slot: MessageSlot.ActiveTasks,
      priority: LANE_PRIORITY['lane.active-tasks'],
      minTokens: 0,
      maxTokens: Infinity,
      truncate: truncateTextLane,
      render: async (ctx) => {
        if (!ctx.shouldFireScaffolding) return null;
        try {
          const { listTasks } = await import('../tracker/schema.js');
          const activeTasks = listTasks({ status: 'in_progress', assignedTo: ctx.agentId });
          if (activeTasks.length === 0) return null;
          // Skip if the last few turns already mention these task IDs.
          const recent = getRecentMessages(ctx.agentId, lim('lane.active-tasks', 'rows', 'recentMentionWindow'));
          const recentText = recent.map((m) => m.content).join(' ');
          const allMentionedRecently = activeTasks.every((t) =>
            recentText.includes(t.id) || recentText.includes(t.id.slice(0, 8)),
          );
          if (allMentionedRecently) return null;
          const stampStmt = getStampDb().prepare(
            `SELECT w.id AS id, ${stampColumns('w')},
                    w.step_number AS step_number, w.total_steps AS total_steps,
                    w.parent_id AS project_id
               FROM work w WHERE ${taskScope('w')} AND w.id = ?`,
          );
          const descCap = lim('lane.active-tasks', 'chars', 'description');
          const noteCap = lim('lane.active-tasks', 'chars', 'lastNote');
          const taskLines = activeTasks.slice(0, lim('lane.active-tasks', 'rows', 'tasks')).map((t) => {
            let line = `• ${t.title} (ID: ${t.id.slice(0, 8)}, priority: ${t.priority})`;
            try {
              const st = stampStmt.get(t.id) as TaskStampFields | undefined;
              if (st) {
                const stamp = renderTaskStamps(st);
                const steps = renderStepFacts(st);
                line += `\n  State: ${stamp}${steps ? ` | ${steps}` : ''}`;
              }
            } catch { /* stamps are best-effort */ }
            if (t.description) line += `\n  Instructions: ${t.description.slice(0, descCap)}${t.description.length > descCap ? '...' : ''}`;
            if (t.notes) {
              const lastNote = t.notes.split('\n').filter(Boolean).pop();
              if (lastNote) line += `\n  Last note: ${lastNote.slice(0, noteCap)}`;
            }
            return line;
          });
          return textRender(
            `═══ YOUR ACTIVE TASKS (from tracker, ground truth) ═══\nYou are currently assigned to these in_progress tasks. This is what you should be working on:\n\n${taskLines.join('\n\n')}\n\n═══ END ACTIVE TASKS ═══`,
          );
        } catch { return null; /* tracker may not be available */ }
      },
    },
    {
      id: 'lane.continuity',
      slot: MessageSlot.CompactionContinuity,
      priority: LANE_PRIORITY['lane.continuity'],
      minTokens: 0,
      maxTokens: Infinity,
      truncate: truncateTextLane,
      render: (ctx) => {
        try {
          const db = getDb();
          const configRow = db.prepare('SELECT config FROM agents WHERE id = ?').get(ctx.agentId) as { config: string } | undefined;
          if (!configRow?.config) return null;
          const agentConfig = JSON.parse(configRow.config) as Record<string, unknown>;
          const continuityBrief = agentConfig.continuityBrief as string | undefined;
          const currentTurn = currentTurnNumber(ctx.agentId);   // G24: the turns record, not a MAX over messages
          // T6: bounded ABOVE by the writer's own horizon — a threshold from an older
          // numbering era is permanently in the future and never expires on its own.
          const validUntil = readStoredTurnThreshold(
            agentConfig.continuityBriefValidUntilTurn, currentTurn, CONTINUITY_BRIEF_HORIZON_TURNS,
          );
          if (validUntil === null || !(currentTurn < validUntil)) return null;
          if (!continuityBrief || continuityBrief.length <= 50) return null;
          return textRender(
            `═══ CONTINUITY BRIEF (snapshot from before the last compaction, the live conversation below is more recent and authoritative when in conflict) ═══\n\n${continuityBrief}\n\n═══ END CONTINUITY BRIEF ═══`,
          );
        } catch { return null; /* best effort */ }
      },
    },
    {
      id: 'lane.scratchpad',
      slot: MessageSlot.Scratchpad,
      priority: LANE_PRIORITY['lane.scratchpad'],
      minTokens: 0,
      maxTokens: Infinity,
      truncate: truncateTextLane,
      render: (ctx) => {
        try {
          const db = getDb();
          const cfgRow = db.prepare('SELECT config FROM agents WHERE id = ?').get(ctx.agentId) as { config: string } | undefined;
          if (!cfgRow?.config) return null;
          const cfg = JSON.parse(cfgRow.config) as Record<string, unknown>;
          const scratchpad = typeof cfg.scratchpad === 'string' ? cfg.scratchpad.trim() : '';
          if (scratchpad.length === 0) return null;
          return textRender(
            `═══ YOUR SCRATCHPAD (agent-maintained outline + progress, survives compaction; update with scratchpad_set) ═══\n` +
            `${scratchpad}\n` +
            `═══ END SCRATCHPAD ═══`,
          );
        } catch (err) {
          logger.warn('Scratchpad injection failed', {
            error: err instanceof Error ? err.message : String(err),
          }, ctx.agentId);
          return null;
        }
      },
    },
    {
      id: 'lane.directive',
      slot: MessageSlot.ActiveDirective,
      priority: LANE_PRIORITY['lane.directive'],
      // THE INVERSION, in one field. This lane used to be tested LAST against a budget nine
      // sections had already eaten (`:1098`). It is priority 10 and it reserves a floor.
      minTokens: MIN_LANE_FLOOR_TOKENS,
      maxTokens: Infinity,
      truncate: truncateTextLane,
      render: async (ctx) => {
        try {
          const { getActiveUserDirective, formatDirectiveBlock } = await import('./directive.js');
          const cp = ctx.turnContext?.counterparty;
          const stampedConversationId = currentTurnConversationId.get(ctx.agentId);
          const directiveConversationId =
            (ctx.turnContext?.isEngineTurn || cp?.kind === 'agent')
              ? '__none__'
              : (cp && cp.kind === 'user' ? (stampedConversationId ?? null) : null);
          const directive = getActiveUserDirective(ctx.agentId, {
            excludeEngine: !ctx.turnContext?.isEngineTurn,
            conversationId: directiveConversationId,
          });
          return directive ? textRender(formatDirectiveBlock(directive)) : null;
        } catch (err) {
          logger.warn('Active directive injection failed', {
            error: err instanceof Error ? err.message : String(err),
          }, ctx.agentId);
          return null;
        }
      },
    },
    {
      id: 'lane.events',
      slot: MessageSlot.Events,
      priority: LANE_PRIORITY['lane.events'],
      minTokens: 0,
      maxTokens: Infinity,
      truncate: truncateTextLane,
      render: (ctx) => {
        const { awarenessEvents } = ctx.tail();
        if (awarenessEvents.length === 0) return null;
        const gistCap = lim('lane.events', 'chars', 'gist');
        const eventLines = awarenessEvents.slice(-lim('lane.events', 'rows', 'events')).map((m) => {
          const o = m.origin;
          const rawContent = typeof m.content === 'string' ? m.content : '';
          const body = rawContent
            .replace(/^\s*\[[^\]]*\]\s*/, '')
            .replace(/\s+/g, ' ')
            .trim();
          const label = o?.kind === 'user'
            ? `${o.channel ?? 'msg'} notice${o.senderName ? ` from ${o.senderName}` : ''}`
            : (o?.intent ?? 'event');
          const structured = o?.kind === 'user' ? buildAwarenessGist(m.inboundMeta, rawContent) : null;
          const gist = structured ?? body.slice(0, gistCap);
          const at = renderMessageTimeStamp(m.createdAt);
          return `• ${at ?? ''}[${label}] ${gist}`;
        });
        return textRender(
          '═══ EVENTS & NOTICES (things that happened, and notifications addressed to the ' +
          'owner that you are AWARE of but are NOT in conversation with, NOT the person ' +
          'you are replying to below. Surface one to the owner only if it genuinely ' +
          'matters; never reply to its sender) ═══\n' +
          eventLines.join('\n'),
        );
      },
    },
    {
      id: 'lane.fresh-tail',
      slot: MessageSlot.FreshTail,
      priority: LANE_PRIORITY['lane.fresh-tail'],
      // B8: the ONE mandatory floor. A context with no live conversation is worse than one
      // slightly over budget — `budgetFreshTail`'s last-group safety, made a declaration.
      minTokens: MIN_LANE_FLOOR_TOKENS,
      mandatoryFloor: true,
      maxTokens: Infinity,
      truncate: (render, maxTokens) => {
        const p = render.payload as TailPayload;
        const kept = budgetFreshTail(p.rows, maxTokens);
        const dropped = Math.max(0, p.rows.length - kept.length);
        return tailRender({ rows: kept, agentId: p.agentId, dropped: p.dropped + dropped });
      },
      render: (ctx) => {
        const { freshTail } = ctx.tail();
        if (freshTail.length === 0) return null;
        // Pre-cap oversized tool_result content BEFORE budgeting: without it a single
        // 5.9MB tool_result consumes the whole budget and evicts the user's question.
        return tailRender({ rows: capLargeToolResultStrings(freshTail), agentId: ctx.agentId, dropped: 0 });
      },
    },
  ];
}

/**
 * Convert stored rows into the emitted messages. The lane's COST is the row cost — the unit
 * `budgetFreshTail` spends and the one migration `150` made canonical — so the allocator and
 * the truncator speak one language. The stamp/parse difference between a stored row and its
 * emitted form rides inside the declared post-budget reserve.
 */
function tailRender(payload: TailPayload): LaneRender<TailPayload> {
  let rows = sanitizeToolPairs(payload.rows);
  rows = stubOldToolResults(rows, payload.agentId);
  const messages: LaneMessage[] = [];
  for (const msg of rows) {
    const parsed = parseMessageContent(msg);
    if (msg.role === 'tool') {
      messages.push({ role: 'user', content: parsed as Anthropic.ContentBlockParam[] });
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      const out: LaneMessage = { role: msg.role, content: stampTextContent(parsed, msg.createdAt) };
      if (msg.role === 'assistant' && msg.reasoningContent) out.reasoningContent = msg.reasoningContent;
      messages.push(out);
    }
  }
  return { messages, tokens: rowTokens(payload.rows), payload };
}

async function assembleMessageContext(
  agentId: string,
  modelId: string,
  systemPrompt: string,
  turnContext?: PromptTurnContext,
): Promise<AssembledContext> {
  const contextWindow = getContextWindow(modelId);
  // ONE budget (PHASE-3 T2): threshold, reserve and ceiling from `memory/budget.ts`.
  // PHASE-3 T4: the reserve is MEASURED, not a constant — the tools payload this agent's
  // transport will actually serialise, plus the derived output allowance. The old 15,000
  // literal was smaller than the primary's tool schemas alone, so the assembler's ceiling
  // sat ABOVE the window and the provider front-trimmers were doing the real work.
  const policy = contextWindowPolicy(contextWindow, {
    toolPayloadTokens: await measureAgentToolPayloadTokens(agentId),
    maxOutputTokens: getModelOutputCap(modelId),
  });
  const maxTokens = policy.assemblyBudgetTokens;

  // Budget the message array against the registry-produced system prompt's size.
  const systemTokens = estimateTokens(systemPrompt);
  // Fail loud rather than assemble a lie: a negative budget used to produce a
  // single-message context silently (budgetFreshTail's last-group safety, nothing logged).
  assertSystemPromptFits(systemTokens, policy);

  // PM agent gets a lightweight context: system prompt + recent messages only.
  // No briefing, no vault, no summaries. The tracker is its memory. Its row cap is a lane
  // declaration like every other (§T0-B C `:681`).
  if (isPMAgent(agentId)) {
    const freshTail = getRecentMessages(agentId, laneLimit('lane.pm-tail', 'rows', 'tail'));
    const budgeted = budgetFreshTail(freshTail, maxTokens - systemTokens);
    const pm = tailRender({ rows: budgeted, agentId, dropped: 0 });
    tagMessageLanes(pm.messages, 'lane.pm-tail');
    // ── F22 + T4's day-0 defect (ii): THE PM PATH RETURNS THE SAME SHAPE. ──
    // It used to end at `while (messages[0].role !== 'user') shift()` and return — role
    // normalisation WITHOUT the rest of the integrity pass. A first message that is a user
    // message whose blocks are all `tool_result` satisfies that loop and is exactly what
    // Anthropic rejects, which is 3 of the detect window's 17 day-0 divergences, all on
    // `kelly`. `applyIntegrityPass` does the role normalisation AND strips the leading
    // tool_result AND repairs the pairing AND refuses a trailing assistant — the loop it
    // replaces was a strictly weaker copy of its first clause, so it is DELETED, not kept
    // beside it. Requirement C9's "no PM bypass" is now true of the assembler as well as
    // of the validator.
    const messages = applyIntegrityPass([...pm.messages], agentId);
    const freshTailDropped = Math.max(0, freshTail.length - budgeted.length);
    // The report the PM path never produced. One lane, its real grant, its reason in words:
    // a receipt that simply lacked the PM's assembly could not tell "the PM has no lanes"
    // from "nobody wrote this down" (research 06 §8's own complaint about this return).
    const report: AllocationReport = {
      budgetTokens: Math.max(0, maxTokens - systemTokens),
      reservedTokens: 0,
      spentTokens: renderTokens(messages),
      offTheTopTokens: 0,
      grants: [{
        id: 'lane.pm-tail',
        slot: MessageSlot.FreshTail,
        priority: LANE_PRIORITY['lane.fresh-tail'],
        requested: pm.tokens,
        granted: renderTokens(messages),
        status: messages.length > 0 ? 'admitted' : 'empty',
        reason: `PM lightweight context: the tracker is its memory, so the tail is its only ` +
          `lane (row cap ${laneLimit('lane.pm-tail', 'rows', 'tail')}, ` +
          `${freshTailDropped} row(s) dropped to fit)`,
      }],
      admittedIds: messages.length > 0 ? ['lane.pm-tail'] : [],
      overBudget: [],
    };
    logger.debug('PM agent context assembled (lightweight)', {
      agentId, systemTokens, messageCount: messages.length,
    }, agentId);
    return {
      systemPrompt,
      systemVolatile: '',
      messages,
      messageEntryIds: collectMessageLaneIds(messages),
      freshTailDropped,
      reserveTokens: policy.toolAndOutputReserve,
      allocation: report,
      consumedOneShotFlags: {},
    };
  }

  // ── v2 scaffolding gating (Part V + Part XVIII §C; v2.9.20 post-compaction re-fire) ──
  // Scaffolding injects on session-start turns and for a window after each compaction; the
  // agent retrieves anything else on demand. (Mike's 2026-06-06 photo-album incident: after
  // compaction the live tail can lose enough procedural context that the agent does not
  // realise it should re-establish.)
  const isSessionStartTurn = isV2SessionStart(agentId);
  const isWithinPostCompactionScaffoldingWindow = (() => {
    try {
      const configRow = getDb().prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
      if (!configRow?.config) return false;
      const cfg = JSON.parse(configRow.config) as Record<string, unknown>;
      const currentTurn = currentTurnNumber(agentId);   // G24
      const validUntil = readStoredTurnThreshold(   // T6: same upper bound as the brief lane
        cfg.continuityBriefValidUntilTurn, currentTurn, CONTINUITY_BRIEF_HORIZON_TURNS,
      );
      if (validUntil === null) return false;
      // The brief itself injects through `validUntil`; the wider scaffolding re-fires for
      // 5 turns past that, giving ~8 turns of full context to re-establish.
      const SCAFFOLDING_EXTRA_TURNS = 5;
      return currentTurn < validUntil + SCAFFOLDING_EXTRA_TURNS;
    } catch {
      return false;
    }
  })();
  const shouldFireScaffolding = isSessionStartTurn || isWithinPostCompactionScaffoldingWindow;
  if (isWithinPostCompactionScaffoldingWindow && !isSessionStartTurn) {
    logger.info('Re-firing scaffolding within post-compaction window', { agentId }, agentId);
  }

  // ── The lane render context ──
  let tailCache: { freshTail: Message[]; awarenessEvents: Message[] } | null = null;
  let summaryCache: Summary[] | null = null;
  const laneCtx: LaneRenderCtx = {
    agentId,
    modelId,
    contextWindow,
    policy,
    turnContext,
    shouldFireScaffolding,
    summaries: () => {
      if (summaryCache) return summaryCache;
      const rawSummaries = getContextSummaries(agentId);
      // v2.7.7: scrub summaries that describe an EARLIER version of a technique the agent
      // has freshly re-read this session — the path by which an agent references a script
      // that no longer exists.
      let freshlyReadTechniques: Set<string> = new Set();
      try {
        const recentForScrub = getRecentMessages(agentId, laneLimit('lane.summaries', 'rows', 'scrubWindow'));
        freshlyReadTechniques = extractFreshlyReadTechniques(recentForScrub);
      } catch { /* best effort, fall back to no scrub */ }
      summaryCache = scrubSummariesAgainstFreshTechniques(rawSummaries, freshlyReadTechniques);
      return summaryCache;
    },
    tail: () => {
      if (tailCache) return tailCache;
      // Exclude user messages that arrived after the current turn started so they get a
      // clean run via the wakeup mechanism instead of being buried mid-context.
      const turnCutoff = turnBoundary.get(agentId);
      const freshTailRaw = getRecentMessages(agentId, policy.freshTailCount, turnCutoff);
      // Counterparty scoping (attribution redesign): the live conversation is scoped to the
      // ONE counterparty this turn addresses, so the model can never see two senders mixed.
      const scopedTail = turnContext?.counterparty?.kind === 'agent'
        ? scopeToA2AThread(freshTailRaw, turnContext.counterparty.threadId)
        : turnContext?.isEngineTurn
        ? scopeToEngineTurn(freshTailRaw)
        : scopeToHumanConversation(freshTailRaw, turnContext?.counterparty, currentTurnConversationId.get(agentId) ?? null);
      // EVENTS / awareness lane: engine notices AND unauthorized human inbound — things the
      // agent should be AWARE of but is NOT in conversation with. An action-required
      // engine-origin A2A stays FULL in the live tail on its engine turn.
      const keepFullId = turnContext?.engineEventKeepFullId ?? null;
      const awarenessEvents = scopedTail.filter((m) =>
        m.role === 'user' &&
        (keepFullId ? m.id !== keepFullId : true) &&
        (m.origin?.kind === 'engine' || (m.origin?.kind === 'user' && m.origin?.authorized === false)),
      );
      const awarenessIds = new Set(awarenessEvents.map((m) => m.id));
      tailCache = { freshTail: scopedTail.filter((m) => !awarenessIds.has(m.id)), awarenessEvents };
      return tailCache;
    },
  };

  // Reservations taken off the top: the generated ack (slot 1000) and the post-budget lanes
  // (B7 — the seven appends plus the loop's own tail-append). Before this they were spent
  // after `usedTokens` stopped being consulted (research 06's write-only finding).
  const offTheTop = SCAFFOLDING_ACK_RESERVE_TOKENS + POST_BUDGET_RESERVE_TOKENS;
  const contentBudget = Math.max(0, maxTokens - systemTokens - offTheTop);

  // ── Render every lane, then let the two-pass fit decide ──
  const lanes = buildContentLanes(contentBudget);
  const candidates: LaneCandidate[] = [];
  for (const lane of lanes) {
    let render: LaneRender | null = null;
    try {
      render = (await lane.render(laneCtx)) as LaneRender | null;
    } catch (err) {
      // One bad lane may not fail the whole assembly, and a swallowed failure may not read
      // as "the lane had nothing" — it is recorded as empty with the error in the log.
      logger.warn('lane render failed', {
        lane: lane.id, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
    candidates.push({ lane: lane as Lane, render });
  }

  const { emitted, report } = fitLanes(candidates, contentBudget, { offTheTopTokens: offTheTop });

  // ── Emit in SLOT order, with the generated ack at its declared position ──
  const ackText = renderScaffoldingAck(report.admittedIds);
  const messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }> = [];
  let ackEmitted = false;
  const pushAck = () => {
    if (ackEmitted || !ackText) return;
    ackEmitted = true;
    // The ack is generated from the admitted lane ids and NOTHING else — no clock, no
    // counts, no ids. It sits AHEAD of the tail boundary, so a single volatile byte here
    // re-bills every message after it on every turn (research 25 H2; `lanes.test.ts` pins
    // the purity, the assembled-array golden pins the bytes).
    messages.push(tagMessageLane({ role: 'assistant', content: ackText }, 'lane.scaffolding-ack'));
    report.grants.push({
      id: 'lane.scaffolding-ack',
      slot: MessageSlot.ScaffoldingAck,
      priority: LANE_PRIORITY['lane.scaffolding-ack'],
      requested: estimateTokens(ackText),
      granted: estimateTokens(ackText),
      status: 'admitted',
      reason: `generated from ${report.admittedIds.length} admitted lane(s); reserved off the top`,
    });
  };
  for (const e of emitted) {
    if (e.slot > MessageSlot.ScaffoldingAck) pushAck();
    // F21/F23: TAGGED AT EMISSION, at the one place every lane's output passes through.
    // Tagging here rather than inside each lane's `render` is what makes it impossible for
    // a new lane to arrive untagged — there is no second door into the array.
    tagMessageLanes(e.messages, e.id);
    messages.push(...e.messages);
  }
  pushAck();

  // NOTE: the current clock time is intentionally NOT injected here. It is volatile per
  // call, and injecting it BEFORE the fresh tail would break prompt caching for the entire
  // history. It is the LAST engine message in the loop (msg.current-time), after the tail.

  const tailGrant = report.grants.find((g) => g.id === 'lane.fresh-tail');
  const tailPayload = (candidates.find((c) => c.lane.id === 'lane.fresh-tail')?.render?.payload ?? null) as TailPayload | null;
  // FA-M1: >0 means the model lost recent turns from its live view. The dropped rows are
  // persisted and later summarized, so it is live-view loss, not data loss.
  const freshTailDropped = tailPayload?.dropped ?? 0;

  // ── Integrity pass (R6): post-combine repairs, one named stage ──
  let merged = applyIntegrityPass(messages, agentId);

  // ── Post-budget lanes (B7). Each is DECLARED in `lanes.ts` with a reserved allowance, so
  // the fit above already set their tokens aside instead of spending them after the fact. ──
  const postBudget: string[] = [];
  const consumedOneShotFlags: ConsumedOneShotFlags = {};

  // Guard: if we have zero messages after all filtering, pull the last user message
  // directly from DB so the agent at least sees what it's supposed to respond to.
  // CRITICAL: respect session_started_at — recovering a pre-reset message makes the model
  // re-process "reset your session" and call reset_session again → loop.
  if (merged.length === 0) {
    postBudget.push('lane.empty-context-fallback');
    try {
      const db = getDb();
      const sessionRow = db.prepare(
        'SELECT session_started_at FROM agents WHERE id = ?',
      ).get(agentId) as { session_started_at: string | null } | undefined;
      const sessionBoundary = sessionRow?.session_started_at ?? null;

      const baseConditions = [
        'agent_id = ?',
        "role = 'user'",
        "content NOT LIKE '[System:%'",
        "content NOT LIKE '%reset_session%'",
      ];
      const params: unknown[] = [agentId];
      if (sessionBoundary) {
        baseConditions.push('created_at >= (unixepoch(?) * 1000)');
        params.push(sessionBoundary);
      }
      const sql = `SELECT content FROM messages WHERE ${baseConditions.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT 1`;
      const lastUserMsg = db.prepare(sql).get(...params) as { content: string } | undefined;

      if (lastUserMsg) {
        logger.error('Context assembly produced 0 messages after filtering, recovering last user message', {
          agentId,
        }, agentId);
        merged.push(tagMessageLane({ role: 'user', content: lastUserMsg.content }, 'lane.empty-context-fallback'));
      } else if (sessionBoundary) {
        logger.info('Context assembly: post-reset with no user message after boundary, returning empty for clean idle', {
          sessionBoundary, agentId,
        }, agentId);
      } else {
        logger.error('Context assembly produced 0 messages after filtering and no recoverable user message', {
          agentId,
        }, agentId);
        merged.push(tagMessageLane({ role: 'user', content: 'Continue with your current task.' }, 'lane.empty-context-fallback'));
      }
    } catch {
      merged.push({ role: 'user', content: 'Continue with your current task.' });
    }
  }

  // If this is a new session, prepend a context note to the first user message so the agent
  // understands the conversation was intentionally reset.
  try {
    const db = getDb();
    const sessionRow = db.prepare('SELECT session_started_at FROM agents WHERE id = ?').get(agentId) as { session_started_at: string | null } | undefined;
    if (sessionRow?.session_started_at) {
      const assistantInSession = db.prepare(
        "SELECT COUNT(*) as cnt FROM messages WHERE agent_id = ? AND role = 'assistant' AND created_at >= (unixepoch(?) * 1000)",
      ).get(agentId, sessionRow.session_started_at) as { cnt: number };
      if (assistantInSession.cnt === 0 && merged.length > 0 && merged[merged.length - 1].role === 'user') {
        const lastMsg = merged[merged.length - 1];
        if (typeof lastMsg.content === 'string') {
          postBudget.push('lane.new-session');
          lastMsg.content = `[New Session] Your previous conversation history has been archived. You still have access to your long-term memory via vault_search. You DO NOT have the detailed conversation from before, only summaries. If the user references something specific from before, use vault_search to find it.\n\n${lastMsg.content}`;
        }
      }
    }
  } catch { /* session_started_at column may not exist yet */ }

  // ── One-shot engine markers (A2A preempt, Stop). PURE READ (S3): the flags are READ here
  // and CLEARED by the turn that owns them. Assembly used to `UPDATE agents SET config` from
  // the read path, so a probe, a retry or a dry-run silently consumed a one-shot marker. ──
  try {
    const db = getDb();
    const row = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
    if (row?.config) {
      const config = JSON.parse(row.config) as Record<string, unknown>;

      if (config.a2aPreemptPending && typeof config.a2aPreemptPending === 'object') {
        const p = config.a2aPreemptPending as {
          fromName?: string; intent?: string; threadShort?: string; recentCount?: number;
        };
        const fromName = p.fromName ?? 'another agent';
        const intent = p.intent ?? 'message';
        const threadShort = p.threadShort ?? '';
        const recentCount = typeof p.recentCount === 'number' ? p.recentCount : 1;

        const stormHint = recentCount >= 3
          ? ` ${fromName} has interrupted you ${recentCount}x in the last 5 minutes, if this looks like ping-pong (you keep responding, they keep asking), KEEP YOUR REPLY EXTREMELY TERSE (one sentence max) so the back-and-forth burns out and you can return to the original work.`
          : '';

        const PREEMPT_MARKER = (
          `[Context note: ${fromName} interrupted your turn with a [A2A:${intent}] message on thread ${threadShort}, that's the message right below this note. ` +
          `Handle it now: respond via send_to_agent on the same thread (or take whatever action they're asking for). ` +
          `Your prior tool work was aborted mid-flight, so the most recent tool_use in your fresh tail may NOT have a matching tool_result yet, if you need that result to continue, re-call the tool. ` +
          `After dealing with this interruption, resume the work you were on before.${stormHint}]`
        );

        if (merged.length > 0 && merged[merged.length - 1].role === 'user') {
          const lastMsg = merged[merged.length - 1];
          if (typeof lastMsg.content === 'string') {
            lastMsg.content = `${PREEMPT_MARKER}\n\n${lastMsg.content}`;
          } else if (Array.isArray(lastMsg.content)) {
            lastMsg.content = [
              { type: 'text', text: PREEMPT_MARKER } as Anthropic.TextBlockParam,
              ...(lastMsg.content as Anthropic.ContentBlockParam[]),
            ];
          }
          postBudget.push('lane.a2a-preempt');
          consumedOneShotFlags.a2aPreemptPending = true;
        }
      }

      if (config.stopMarkerPending === true) {
        // v2.5.35 wording: the marker is PREPENDED to the user's new message, so it must not
        // say "the next user message" — weaker models read that as "wait for one to arrive".
        const STOP_MARKER = '[Context note: the user just hit the Stop button on your previous turn. Your previous plan is CANCELLED. Do NOT continue the tool loop you were executing. Do NOT retry the last action with a different approach. Do NOT resume your prior work. The user\'s new request follows IMMEDIATELY BELOW, respond to that message as a fresh ask, not whatever you were doing before.]';
        if (merged.length > 0 && merged[merged.length - 1].role === 'user') {
          const lastMsg = merged[merged.length - 1];
          if (typeof lastMsg.content === 'string') {
            lastMsg.content = `${STOP_MARKER}\n\n${lastMsg.content}`;
          } else if (Array.isArray(lastMsg.content)) {
            lastMsg.content = [
              { type: 'text', text: STOP_MARKER } as Anthropic.TextBlockParam,
              ...(lastMsg.content as Anthropic.ContentBlockParam[]),
            ];
          }
          postBudget.push('lane.stop-marker');
          consumedOneShotFlags.stopMarkerPending = true;
        }
      }
    }
  } catch { /* config may not exist or be malformed */ }

  // ── A2A reply salience (v3.1.10) ──
  // On a FORCED A2A turn the inbound A2A is buried behind an already-answered user exchange,
  // so a weak model never realizes it owes a reply. Move the most-recent unreplied A2A to
  // the tail with a reply directive, so the forced turn looks like a natural one.
  if (turnContext?.isA2ATurn && merged.length > 0) {
    const repliedShorts = new Set<string>();
    try {
      const rows = getDb().prepare(
        'SELECT DISTINCT substr(thread_id,1,8) AS s FROM a2a_replies WHERE agent_id = ?',
      ).all(agentId) as Array<{ s: string }>;
      for (const r of rows) repliedShorts.add(r.s);
    } catch { /* table may not exist yet */ }
    // PHASE-3 T5: was hex-only, so it returned null for every NAMED thread id and skipped
    // the dedupe. Measured live: 70 of 250 `thread:` tokens (28%) are not hex.
    const threadShortOf = (c: string): string | null => parseA2AThreadShort(c);
    const isA2AMsg = (m: { role: string; content: string | Anthropic.ContentBlockParam[] }) =>
      m.role === 'user' && typeof m.content === 'string' && A2A_INBOUND_RE.test(m.content);
    merged = merged.filter((m) => {
      if (!isA2AMsg(m)) return true;
      const short = threadShortOf(m.content as string);
      return !(short && repliedShorts.has(short));
    });
    if (merged.length > 0 && !isA2AMsg(merged[merged.length - 1])) {
      let idx = -1;
      for (let i = merged.length - 1; i >= 0; i--) {
        if (isA2AMsg(merged[i])) {
          const short = threadShortOf(merged[i].content as string);
          if (!short || !repliedShorts.has(short)) { idx = i; break; }
        }
      }
      if (idx >= 0) {
        const [a2aMsg] = merged.splice(idx, 1);
        if (typeof a2aMsg.content === 'string') {
          a2aMsg.content =
            `[Engine: inter-agent reply turn. The message below is still awaiting your reply. ` +
            `Make exactly ONE send_to_agent call on the SAME thread_id (intent ANSWER for a QUESTION, ` +
            `COMPLETE/STATUS/FAIL for an ASSIGN), then end your turn. Your chat text is invisible to ` +
            `the sender and is suppressed, send_to_agent is the only way to reply. Any user messages ` +
            `above were already handled; do not re-answer them.]\n\n${a2aMsg.content}`;
        }
        merged.push(a2aMsg);
        postBudget.push('lane.a2a-salience');
      }
    }
  }

  // Record the post-budget lanes that actually fired, against their declared reserves.
  for (const l of POST_BUDGET_LANES) {
    const fired = postBudget.includes(l.id);
    report.grants.push({
      id: l.id,
      slot: l.slot,
      priority: Number.MAX_SAFE_INTEGER,
      requested: fired ? l.reserveTokens : 0,
      granted: fired ? l.reserveTokens : 0,
      status: fired ? 'admitted' : 'empty',
      reason: fired
        ? `post-budget lane fired; ${l.reserveTokens} tokens reserved off the top (${l.measured})`
        : 'post-budget lane did not fire on this turn',
    });
  }
  report.grants.sort((a, b) => a.slot - b.slot);

  logger.info('Context assembled', {
    systemPromptTokens: systemTokens,
    contentBudget,
    reservedOffTheTop: offTheTop,
    spentTokens: report.spentTokens,
    admittedLanes: report.admittedIds.length,
    rejectedLanes: report.grants.filter((g) => g.status === 'rejected').length,
    truncatedLanes: report.grants.filter((g) => g.status === 'truncated').length,
    overBudgetEvents: report.overBudget.length,
    freshTailCount: tailGrant?.granted ?? 0,
    totalMessages: merged.length,
  }, agentId);

  return {
    systemPrompt,
    systemVolatile: '',
    messages: merged,
    // F21: the dead plumbing ends here. Read OFF the array it describes, after every
    // mutation above, so it is aligned by construction rather than by maintenance.
    messageEntryIds: collectMessageLaneIds(merged),
    freshTailDropped,
    reserveTokens: policy.toolAndOutputReserve,
    allocation: report,
    consumedOneShotFlags,
  };
}

// ── Helpers ──

function formatSummaryXml(summary: Summary): string {
  return `<summary id="${summary.id}" depth="${summary.depth}" kind="${summary.kind}" tokens="${summary.tokenCount}" earliest="${summary.earliestAt}" latest="${summary.latestAt}">
${summary.content}
</summary>`;
}

// ── Summary selection (remediation Phase 2, Invariant II) ──
// Summaries are selected by MEANING under a hard cap, not packed to fill the
// window. The old recency packer loaded ~50K tokens of mostly-irrelevant
// history on every turn of a large-window model; relevance preserves the
// reasons recency encoded, continuity (the newest summaries always ride
// along) and window safety (hard budget), without the bloat. budgetSummaries
// survives as the internal fallback when relevance scoring can't run (see
// selectSummariesByRelevance), never as a window-filling default.

// PHASE-3 T3: `SUMMARY_RELEVANCE_BUDGET_TOKENS = 6000` and `SUMMARY_RECENCY_FLOOR = 2`
// (§T0-B E `:1587`/`:1588`) are lane declarations now — `LANE_LIMITS['lane.summaries']` —
// and the caller passes the lane's own granted ceiling instead of this function re-deriving
// a share of a budget the gates had already eaten.

async function selectSummariesByRelevance(
  summaries: Summary[],
  budget: number,
  agentId: string,
): Promise<Summary[]> {
  // Continuity floor: the newest summaries are the compressed tail of the
  // live thread and always ride along.
  const floor = summaries.slice(-laneLimit('lane.summaries', 'tokens', 'recencyFloor'));
  const picked = new Set(floor.map((s) => s.id));
  let used = floor.reduce((t, s) => t + s.tokenCount, 0);

  // Rank the remainder by similarity to the live ask. D4: use the unified
  // per-turn recall query so this also works on A2A/engine turns and survives
  // mid-tool-iteration rebuilds (the old last-3-user-rows derivation went empty
  // on those and gave zero relevance ranking).
  const queryText = buildPerTurnRecallQuery(agentId);

  if (queryText.trim().length > 10) {
    try {
      const { vectorSearch } = await import('./vector-search.js');
      const hits = await vectorSearch(queryText, agentId, {
        sourceType: 'summary',
        limit: laneLimit('lane.summaries', 'retrieval', 'limit'),
        minSimilarity: laneLimit('lane.summaries', 'retrieval', 'minSimilarity'),
      });
      const byId = new Map(summaries.map((s) => [s.id, s]));
      for (const hit of hits) {
        if (picked.has(hit.sourceId)) continue;
        const s = byId.get(hit.sourceId);
        if (!s) continue;
        if (used + s.tokenCount > budget) continue;
        picked.add(s.id);
        used += s.tokenCount;
      }
    } catch (err) {
      logger.debug('relevance summary selection failed; using floor only', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }

  // If even the floor overflows the budget (oversized summaries), fall back
  // to the recency packer under the SAME tight budget, never the full window.
  if (used > budget) {
    return budgetSummaries(summaries, Math.floor(budget / SUMMARY_SHARE));
  }

  // Chronological order in output, same as the recency path.
  return summaries.filter((s) => picked.has(s.id));
}

// ── Relevant memory block (per-turn, relevance mode only) ──

// PHASE-3 T3: the two budgets (§T0-B E `:1646`/`:1647`), the four retrieval knobs
// (F `:1755`/`:1758`/`:1805`/`:1807`), the row caps (C `:1748`/`:1777`/`:1818`/`:1684`) and
// the char slices (D `:1688`/`:1694`/`:1703`/`:1771`/`:1812`) are all
// `LANE_LIMITS['lane.relevant-memory']` declarations now.
const RELEVANT_MEMORY_CACHE_MS = 60_000;
// Derived-data cache only (loss = recompute); keyed by (agent, includeVault),
// validated by query text, so N tool iterations of one turn run vector search
// (and one query embed) at most once.
const relevantMemoryCache = new Map<string, { at: number; queryText: string; block: string | null }>();

// D4: warn at most once per outage window when the query embedding is
// unavailable and we degrade to FTS, so a chronic embed outage is visible
// without spamming every turn.
let lastEmbedDegradeWarnAt = 0;

function isSyntheticRow(content: string): boolean {
  return content.startsWith('[SOURCE:') || content.startsWith('[A2A:')
    || content.startsWith('[Engine') || content.startsWith('[ENGINE')
    || content.startsWith('[System') || content.startsWith('[DOJO:')
    // PHASE-1 T8: the divider's shape is @dojo/shared's, not a literal re-typed here.
    || parseDivider(content)?.label.startsWith(NEW_SESSION_DIVIDER_LABEL) === true;
}

// D4: strip a leading engine/A2A envelope so the recall query is the actual
// content. "[A2A:QUESTION thread:ab from:PM] can you ship X?" -> "can you ship X?"
// "[SOURCE:scheduler] remind the owner about Y" -> "remind the owner about Y".
function stripRecallEnvelope(content: string): string {
  const m = content.match(/^\[[^\]]*\]\s*/);
  return m ? content.slice(m[0].length) : content;
}

// D4: ONE per-turn recall query, used by both summary-relevance and the
// relevant-memory block. Preference: the newest genuine human user rows
// (non-synthetic); else, on A2A/engine turns or mid-tool-iteration when no
// human row is in the recent window, the newest substantive row with its
// envelope stripped. The old derivation read only the last 3 user rows and went
// EMPTY on A2A/engine turns (zero semantic recall) and whenever tool iterations
// pushed the user row out of the 3-row window.
// ── THE PER-TURN RECALL QUERY IS ACTUALLY PER-TURN NOW (PHASE-3 T3) ─────────────────────
//
// FOUND BY MEASUREMENT, not by reading: with the generated ack proven byte-stable across
// four consecutive iterations of one turn (receipts t1607 i2..i5, ack sha `dd83e8ed…`
// identical throughout), the remaining message-array churn was ISOLATED to message 0 — the
// summaries lane — changing size mid-turn (20,324 -> 19,914 chars between i4 and i5).
//
// The mechanism: this function reads the last N rows and prefers the genuine human user
// rows among them. Mid-turn, each tool iteration appends an assistant row and a tool row,
// so the human row is PUSHED OUT of that window and the function falls through to its
// second branch — "the newest substantive row, envelope-stripped" — which is a DIFFERENT
// row on every iteration. Both relevance-selected lanes (summaries, relevant-memory) then
// re-select against a different query, and both sit AHEAD of the tail boundary, so the
// whole array behind them is re-read. That is the K10 defect `check-message-prefix` was
// red on from 2026-07-27.
//
// ── TWO CORRECTIONS TO THE PARAGRAPH ABOVE (PHASE-3 KITFIX-PREFIX, 2026-08-01, P3-R4) ───
// It said "re-BILLED", and three later documents inherited a "~23KB re-billed every turn"
// figure from that word. Measured through the provider's own prompt-cache counters on
// matched arms: DeepSeek matches at 128-token block granularity inside the byte stream, so
// on the turns the check called fully broken it still CACHE-READ 91–93% of the prompt. The
// marginal cost of an across-turn re-selection is ≈1,186 tokens/turn (a floor — the cache
// frontier keeps walking forward while the block stays still), not ~23KB. And the check is
// not red any more: it was judging whichever two receipt files were newest on disk, a
// measured 41.9% coin flip; it drives its own fixed-ask pair now and this memo is what
// makes that pair hold. `overhaul-research/25-cache-preservation.md` is the evidence base.
//
// This function's own name and its D4 docstring already say "ONE per-turn recall query".
// It was one per ASSEMBLY. Memoising it against `turnBoundary` — the timestamp the turn
// stamps at pickup and clears at idle — makes the claim true: iteration 1 computes exactly
// what it computed before (no semantic change to what is recalled), and iterations 2..N
// reuse it instead of re-deriving a different one. Outside a turn there is no boundary and
// no memo, which is correct: there is no turn to be stable within.
//
// It also makes `relevantMemoryCache` below actually hold across a turn — it is keyed by
// query text, so a query that changed every iteration invalidated it every iteration and
// each one paid for a fresh vector search and a fresh embed.
const perTurnRecallQuery = new Map<string, { boundary: string; query: string }>();

function buildPerTurnRecallQuery(agentId: string): string {
  const boundary = turnBoundary.get(agentId);
  if (boundary) {
    const memo = perTurnRecallQuery.get(agentId);
    if (memo && memo.boundary === boundary) return memo.query;
  }
  const query = deriveRecallQuery(agentId);
  if (boundary) perTurnRecallQuery.set(agentId, { boundary, query });
  return query;
}

function deriveRecallQuery(agentId: string): string {
  let recent: ReturnType<typeof getRecentMessages> = [];
  try { recent = getRecentMessages(agentId, laneLimit('lane.relevant-memory', 'rows', 'recallWindow')); } catch { return ''; }
  const humanUser = recent
    .filter((m) => m.role === 'user' && typeof m.content === 'string' && !isSyntheticRow(m.content))
    .map((m) => m.content as string);
  const q = humanUser.join('\n').slice(-laneLimit('lane.relevant-memory', 'chars', 'recallHead'));
  if (q.trim().length > 10) return q;
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = recent[i]?.content;
    if (typeof c !== 'string') continue;
    const stripped = stripRecallEnvelope(c).replace(/\s+/g, ' ').trim();
    if (stripped.length > 10) return stripped.slice(-laneLimit('lane.relevant-memory', 'chars', 'recallTail'));
  }
  return '';
}

// D4: FTS degrade for message recall when the query embedding is unavailable.
function ftsMessageHits(query: string, agentId: string, limit: number): Array<{ sourceId: string }> {
  try {
    const db = getDb();
    const safe = query.replace(/["']/g, ' ').split(/\s+/).filter((w) => w.length > 2)
      .slice(0, laneLimit('lane.relevant-memory', 'chars', 'queryWords')).join(' ');
    if (!safe) return [];
    const rows = db.prepare(
      `SELECT m.id FROM messages_fts fts JOIN messages m ON m.rowid = fts.rowid
        WHERE messages_fts MATCH ? AND m.agent_id = ? ORDER BY rank LIMIT ?`,
    ).all(safe, agentId, limit) as Array<{ id: string }>;
    return rows.map((r) => ({ sourceId: r.id }));
  } catch {
    return [];
  }
}

async function buildRelevantMemoryBlock(
  agentId: string,
  includeVault: boolean,
  policy: ReturnType<typeof contextWindowPolicy>,
): Promise<string | null> {
  const queryText = buildPerTurnRecallQuery(agentId);
  if (queryText.trim().length <= 10) return null;

  const cacheKey = `${agentId}::${includeVault ? 'v' : 'm'}`;
  const cached = relevantMemoryCache.get(cacheKey);
  if (cached && cached.queryText === queryText && Date.now() - cached.at < RELEVANT_MEMORY_CACHE_MS) {
    return cached.block;
  }

  // D4 step 2: embed the recall query ONCE; share it across the message + vault
  // lanes so a single turn embeds at most once. On failure, degrade to FTS/LIKE
  // (step 5) so recall still returns something.
  let queryEmbedding: Float32Array | null = null;
  try {
    const { generateEmbedding } = await import('./embeddings.js');
    queryEmbedding = await generateEmbedding(queryText);
  } catch (err) {
    if (Date.now() - lastEmbedDegradeWarnAt > 300_000) {
      lastEmbedDegradeWarnAt = Date.now();
      logger.warn('per-turn recall: query embed unavailable, degrading to FTS', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }

  const msgLines: string[] = [];
  const vaultLines: string[] = [];
  try {
    const db = getDb();
    // The fresh tail already includes these; this block is only for what fell
    // out. getRecentMessages is session-aware, so a fact taught just before a
    // reset stays ELIGIBLE (it is outside the new session's tail).
    // REQUIREMENT B6, THE RECONCILE. This read was `getRecentMessages(agentId, 80)` — a
    // literal copy of `getFreshTailCount`'s 200K-window answer. On a 32K model the tail
    // showed 40 rows while this exclusion window claimed 80, so 40 rows were excluded from
    // recall that were NOT in the tail: they were unreachable by either path. One number,
    // one owner (`memory/budget.ts`), read off the policy this assembly is already using.
    const tailIds = new Set(getRecentMessages(agentId, policy.freshTailCount).map((m) => m.id));

    // --- older raw messages by meaning ---
    let msgHits: Array<{ sourceId: string }>;
    if (queryEmbedding) {
      const { vectorSearch } = await import('./vector-search.js');
      msgHits = await vectorSearch(queryText, agentId, {
        sourceType: 'message',
        limit: laneLimit('lane.relevant-memory', 'retrieval', 'messageLimit'),
        minSimilarity: laneLimit('lane.relevant-memory', 'retrieval', 'messageMinSimilarity'),
        queryEmbedding,
      });
    } else {
      msgHits = ftsMessageHits(queryText, agentId, laneLimit('lane.relevant-memory', 'retrieval', 'ftsLimit'));
    }
    let usedMsg = 0;
    // Selection stays similarity-ranked (best hits win the budget), but
    // presentation is CHRONOLOGICAL, see the sort below.
    const msgCandidates: Array<{ createdAt: string; line: string }> = [];
    for (const hit of msgHits) {
      if (tailIds.has(hit.sourceId)) continue;
      const row = db.prepare(`SELECT role, content, datetime(created_at/1000,'unixepoch') AS created_at FROM messages WHERE id = ?`)
        .get(hit.sourceId) as { role: string; content: string; created_at: string } | undefined;
      if (!row || typeof row.content !== 'string') continue;
      if (row.content.trim().startsWith('[') && row.content.includes('"type"')) continue; // tool JSON rows
      if (isSyntheticRow(row.content)) continue;
      const snippet = row.content.replace(/\s+/g, ' ').slice(0, laneLimit('lane.relevant-memory', 'chars', 'hitPreview'));
      const line = `- [${row.created_at}] ${row.role}: ${snippet}`;
      const lineTokens = estimateTokens(line);
      if (usedMsg + lineTokens > laneLimit('lane.relevant-memory', 'tokens', 'messageBudget')) break;
      msgCandidates.push({ createdAt: row.created_at, line });
      usedMsg += lineTokens;
      if (msgCandidates.length >= laneLimit('lane.relevant-memory', 'rows', 'minTailForRecall')) break;
    }
    // 2026-07-03: present recalled lines oldest → newest, newest LAST (the
    // recency-salient slot for LLMs). Similarity ordering put a stale
    // statement of a since-corrected fact FIRST and the weakest floor model
    // echoed it (observed live: an old membership code recited over the
    // corrected one told minutes before). Conflict arbitration is the
    // engine's job, not the model's (correctness-floor rule).
    msgCandidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    msgLines.push(...msgCandidates.map((c) => c.line));

    // --- long-term vault by meaning (D4 step 3) ---
    // Only on non-scaffolding turns; scaffolding (session-start / post-compaction)
    // turns already inject the vault via retrieveForContext, so skip to avoid
    // double-injection. Dedupe against pinned entries (always injected).
    if (includeVault) {
      // W3-4: all three lookups scoped to THIS agent's vault. Unscoped, every
      // agent's assembled context could recall other agents' private entries.
      const { semanticSearch, getPinnedEntries, listEntries } = await import('../vault/store.js');
      const pinnedIds = new Set(getPinnedEntries(agentId).map((e) => e.id));
      let vhits: Array<{ id: string; type: string; content: string }>;
      if (queryEmbedding) {
        // FA-V6: personalOnly:true so this auto-recall path matches its own
        // listEntries fallback below (which defaults to namespace IS NULL) and
        // exact mode's contract. Squad-namespaced entries stay out of PERSONAL
        // recall; squad recall flows via squad_recall. Correct under D-A (squad
        // namespaces stay opt-in). Filter-only change: no effect on the cache
        // prefix ordering (results are still deterministic by similarity).
        vhits = await semanticSearch(queryText, {
          limit: laneLimit('lane.relevant-memory', 'retrieval', 'vaultLimit'),
          minSimilarity: laneLimit('lane.relevant-memory', 'retrieval', 'vaultMinSimilarity'),
          queryEmbedding, agentId, personalOnly: true,
        });
      } else {
        vhits = listEntries({
          search: queryText,
          limit: laneLimit('lane.relevant-memory', 'retrieval', 'vaultEntryLimit'),
          agentId, includeOwnerScope: true,
        });
      }
      let usedVault = 0;
      for (const e of vhits) {
        if (pinnedIds.has(e.id)) continue;
        const snippet = e.content.replace(/\s+/g, ' ').slice(0, laneLimit('lane.relevant-memory', 'chars', 'vaultPreview'));
        const line = `- [vault:${e.type}] ${snippet}`;
        const lineTokens = estimateTokens(line);
        if (usedVault + lineTokens > laneLimit('lane.relevant-memory', 'tokens', 'vaultBudget')) break;
        vaultLines.push(line);
        usedVault += lineTokens;
        if (vaultLines.length >= laneLimit('lane.relevant-memory', 'rows', 'minTailForVault')) break;
      }
    }
  } catch (err) {
    logger.debug('relevant-memory retrieval failed', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  let block: string | null = null;
  if (msgLines.length > 0 || vaultLines.length > 0) {
    const parts: string[] = [];
    // Framing states the precedence deterministically: entries are dated and
    // ordered, and the newest statement supersedes older ones on conflict.
    if (msgLines.length > 0) parts.push(`Older messages retrieved by meaning (ordered oldest → newest; when they conflict, the NEWEST line supersedes the older ones):\n${msgLines.join('\n')}`);
    if (vaultLines.length > 0) parts.push(`From your long-term vault (retrieved by meaning):\n${vaultLines.join('\n')}`);
    block = `═══ RELEVANT MEMORY (retrieved by meaning, context only, not live conversation) ═══\n${parts.join('\n\n')}\n═══ END RELEVANT MEMORY ═══`;
  }

  relevantMemoryCache.set(cacheKey, { at: Date.now(), queryText, block });
  return block;
}

function budgetSummaries(summaries: Summary[], availableTokens: number): Summary[] {
  // Reserve at least 30% of available tokens for fresh tail
  const summaryBudget = Math.floor(availableTokens * SUMMARY_SHARE);
  let usedTokens = 0;

  // Include from newest to oldest (reverse), since newest summaries are most relevant
  // But we want chronological order in output, so collect indices
  const included: Summary[] = [];

  // First pass: try to include all
  for (const summary of summaries) {
    if (usedTokens + summary.tokenCount <= summaryBudget) {
      included.push(summary);
      usedTokens += summary.tokenCount;
    }
  }

  // If all fit, return them all (already in chronological order)
  if (included.length === summaries.length) {
    return included;
  }

  // Otherwise, drop oldest first until we fit
  const reversed = [...summaries].reverse();
  const keptFromNewest: Summary[] = [];
  usedTokens = 0;

  for (const summary of reversed) {
    if (usedTokens + summary.tokenCount <= summaryBudget) {
      keptFromNewest.push(summary);
      usedTokens += summary.tokenCount;
    }
  }

  // Return in chronological order
  return keptFromNewest.reverse();
}

/**
 * Walk the assembled messages newest-first and replace image / document
 * blocks beyond the keep limit with text placeholders. The model only
 * needs to "see" the most recent image; older ones blow context budget
 * for no semantic gain. Mutates messages in place.
 *
 * Specifically prunes:
 *   - tool_result blocks whose content array contains image / document blocks
 *   - top-level image / document blocks (rare, but possible)
 *
 * Keeps:
 *   - The MOST RECENT N images (default 1)
 *   - All text blocks
 *   - All tool_use blocks (those are tiny)
 */
/**
 * v2, Detect "session start" turns: turns where scaffolding (briefing,
 * vault, active tasks, continuity brief) should be re-injected.
 *
 * Definition: an agent is at session-start if either:
 *   1. session_started_at is set AND no assistant message exists since then
 *      (true first turn after a session reset / new session), OR
 *   2. there are zero assistant messages for the agent at all (brand new agent).
 *
 * This matches the existing "── New Session ──" detection at the bottom
 * of assembleContext for v1, just lifted into a reusable helper.
 *
 * Mid-session turns return false → no scaffolding cost.
 */
/**
 * Stub-and-store (Part XVIII §E). Replace tool_result content older than
 * V2_STUB_AFTER_TURNS turns with a short stub so context stays roughly
 * flat as the agent works.
 *
 * Operates on Message[] (the DB-shaped objects), not on the
 * Anthropic-format ContentBlockParam arrays, turn_number is only available
 * on the DB row.
 *
 * NULL turn_number (v1-era messages, user messages from chat route) is
 * treated as "very old" and stubbed if it's a tool_result. In practice
 * user messages are never tool_result, so this only affects pre-v2 tool
 * results, the intended behavior per spec.
 */
export function stubOldToolResults(messages: Message[], agentId: string): Message[] {
  // G24: the turn the agent is ON, read from the `turns` record. The comment that used to
  // stand here — "same logic v2/loop.ts uses" — stopped being true at PHASE-2 T2, when the
  // loop moved onto the allocator; it is deleted with the query it described.
  const currentTurn = currentTurnNumber(agentId);

  let stubbedCount = 0;

  const stubbed = messages.map((msg) => {
    if (msg.role !== 'tool') return msg;
    // turn_number can be NULL for very old / non-v2-written messages.
    // Treat NULL as -infinity so it's always older than the threshold.
    const msgTurn = msg.turnNumber ?? -Infinity;
    const turnAge = currentTurn - msgTurn;
    if (turnAge < V2_STUB_AFTER_TURNS) return msg;

    let blocks: unknown;
    try {
      blocks = JSON.parse(msg.content);
    } catch {
      return msg;
    }
    if (!Array.isArray(blocks)) return msg;

    let messageChanged = false;
    const newBlocks = blocks.map((b: { type?: string; content?: unknown; tool_use_id?: string }) => {
      if (b.type !== 'tool_result') return b;
      const contentStr = typeof b.content === 'string' ? b.content : '';
      const len = contentStr.length;
      const turnLabel = msg.turnNumber !== null && msg.turnNumber !== undefined ? `turn ${msg.turnNumber}` : 'pre-v2 history';
      messageChanged = true;
      return {
        ...b,
        content: `[Tool result from ${turnLabel}, ${len} chars, cleared from context. Re-call the tool or check vault for findings.]`,
      };
    });

    if (!messageChanged) return msg;
    stubbedCount++;
    return { ...msg, content: JSON.stringify(newBlocks) };
  });

  if (stubbedCount > 0) {
    logger.debug('v2 stubOldToolResults: stubbed old tool results', {
      agentId,
      stubbedCount,
      currentTurn,
      stubAfterTurns: V2_STUB_AFTER_TURNS,
    }, agentId);
  }

  return stubbed;
}

function isV2SessionStart(agentId: string): boolean {
  try {
    const db = getDb();
    const sessionRow = db.prepare(
      'SELECT session_started_at FROM agents WHERE id = ?',
    ).get(agentId) as { session_started_at: string | null } | undefined;
    const sessionStarted = sessionRow?.session_started_at ?? null;
    let cnt: number;
    if (sessionStarted) {
      cnt = (db.prepare(
        "SELECT COUNT(*) as cnt FROM messages WHERE agent_id = ? AND role = 'assistant' AND created_at >= (unixepoch(?) * 1000)",
      ).get(agentId, sessionStarted) as { cnt: number }).cnt;
    } else {
      cnt = (db.prepare(
        "SELECT COUNT(*) as cnt FROM messages WHERE agent_id = ? AND role = 'assistant'",
      ).get(agentId) as { cnt: number }).cnt;
    }
    return cnt === 0;
  } catch {
    // If detection fails, default to NOT-session-start so we don't burn
    // tokens on scaffolding mid-conversation. Better to undershoot scaffolding
    // than overshoot.
    return false;
  }
}

/**
 * v2, Cap the text content of tool_result blocks at V2_MAX_TOOL_RESULT_TOKENS.
 * Mutates messages in place. Each oversized result is truncated with a stub
 * that tells the agent how to retrieve more.
 *
 * Per Part V, without this, a single file_read of a 50K-token file dominates
 * the context budget and triggers the 90% WARN within a few turns.
 */
/**
 * Pre-budget cap for raw tool messages (content is still a JSON string at
 * this point). Walks any tool-role message, parses its tool_result blocks,
 * truncates each block's text content to V2_MAX_TOOL_RESULT_TOKENS, and
 * re-serializes. Mirrors capLargeToolResultsInPlace but operates BEFORE
 * budgetFreshTail so the budget sees realistic token counts.
 *
 * Without this, a single oversized tool_result could consume the entire
 * fresh-tail budget and force older messages, including the user's
 * question, out of context.
 */
function capLargeToolResultStrings(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.role !== 'tool') return msg;
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      return msg;
    }
    if (!Array.isArray(parsed)) return msg;

    let mutated = false;
    const newBlocks = parsed.map((block: unknown) => {
      const blk = block as Record<string, unknown>;
      if (blk.type !== 'tool_result') return block;
      const c = blk.content;
      if (typeof c !== 'string') return block;
      const tokens = estimateTokens(c);
      if (tokens <= V2_MAX_TOOL_RESULT_TOKENS) return block;
      const keepChars = Math.max(
        500,
        Math.floor(c.length * (V2_MAX_TOOL_RESULT_TOKENS / tokens)),
      );
      const truncated =
        c.slice(0, keepChars) +
        `\n\n[... ${tokens - V2_MAX_TOOL_RESULT_TOKENS} tokens truncated. Call the same tool again with narrower arguments (e.g. file_read with offset/limit) to see more.]`;
      mutated = true;
      return { ...blk, content: truncated };
    });
    if (!mutated) return msg;
    return { ...msg, content: JSON.stringify(newBlocks), tokenCount: null };
  });
}

function capLargeToolResultsInPlace(
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
): void {
  let cappedCount = 0;
  let tokensSaved = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (typeof msg.content === 'string') continue;
    if (!Array.isArray(msg.content)) continue;

    const newContent = msg.content.map((block) => {
      const blk = block as unknown as Record<string, unknown>;
      if (blk.type !== 'tool_result') return block;

      // tool_result.content can be either a string or an array of content blocks
      // (e.g., text + image when file_read returns an image). We only cap the
      // string variant, image/document blocks are handled by pruneOldImageBlocksInPlace.
      const content = blk.content;
      if (typeof content !== 'string') return block;

      const tokens = estimateTokens(content);
      if (tokens <= V2_MAX_TOOL_RESULT_TOKENS) return block;

      const keepChars = Math.max(
        500,
        Math.floor(content.length * (V2_MAX_TOOL_RESULT_TOKENS / tokens)),
      );
      const truncated =
        content.slice(0, keepChars) +
        `\n\n[... ${tokens - V2_MAX_TOOL_RESULT_TOKENS} tokens truncated. Call the same tool again with narrower arguments (e.g. file_read with offset/limit, or grep with a more specific pattern) to see more.]`;

      cappedCount++;
      tokensSaved += tokens - estimateTokens(truncated);
      return { ...blk, content: truncated } as unknown as Anthropic.ContentBlockParam;
    });

    messages[i] = { ...msg, content: newContent };
  }

  if (cappedCount > 0) {
    logger.debug('v2 capLargeToolResultsInPlace: capped tool results', {
      cappedCount,
      tokensSaved,
    });
  }
}

function pruneOldImageBlocksInPlace(
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
  maxKeepImages: number,
): void {
  let imagesKept = 0;
  let prunedCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg.content === 'string') continue;
    if (!Array.isArray(msg.content)) continue;

    const newContent: Anthropic.ContentBlockParam[] = msg.content.map(block => {
      const blk = block as unknown as Record<string, unknown>;

      // tool_result blocks: walk their nested content array
      if (blk.type === 'tool_result' && Array.isArray(blk.content)) {
        const nestedContent = blk.content as Array<Record<string, unknown>>;
        const newNested = nestedContent.map(nested => {
          if (nested.type === 'image') {
            if (imagesKept < maxKeepImages) {
              imagesKept++;
              return nested;
            }
            prunedCount++;
            return { type: 'text', text: '[image previously loaded, call file_read again on the same path if you need to re-examine it]' };
          }
          if (nested.type === 'document') {
            prunedCount++;
            return { type: 'text', text: '[document previously loaded, call file_read again if you need to re-examine it]' };
          }
          return nested;
        });
        return { ...blk, content: newNested } as unknown as Anthropic.ContentBlockParam;
      }

      // Top-level image (e.g., user attachment), same rules.
      if (blk.type === 'image') {
        if (imagesKept < maxKeepImages) {
          imagesKept++;
          return block;
        }
        prunedCount++;
        return { type: 'text', text: '[image previously loaded]' } as Anthropic.ContentBlockParam;
      }

      if (blk.type === 'document') {
        prunedCount++;
        return { type: 'text', text: '[document previously loaded]' } as Anthropic.ContentBlockParam;
      }

      return block;
    });

    messages[i] = { ...msg, content: newContent };
  }

  if (prunedCount > 0) {
    logger.debug('Pruned old image/document blocks from context', { prunedCount, imagesKept });
  }
}

function budgetFreshTail(messages: Message[], availableTokens: number): Message[] {
  // Group messages into atomic units: tool_use + tool_result pairs must stay together.
  // A "group" is either a standalone message or an [assistant(tool_use), tool(tool_result)] pair.
  interface Group {
    messages: Message[];
    tokens: number;
  }

  const groups: Group[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    const tokens = storedRowCost(msg);

    // Check if this assistant message has tool_use and is followed by a tool message
    let hasToolUse = false;
    try {
      const parsed = JSON.parse(msg.content);
      if (Array.isArray(parsed)) {
        hasToolUse = parsed.some((b: { type?: string }) => b.type === 'tool_use');
      }
    } catch {}

    if (hasToolUse && msg.role === 'assistant' && i + 1 < messages.length && messages[i + 1].role === 'tool') {
      const nextMsg = messages[i + 1];
      const nextTokens = storedRowCost(nextMsg);
      groups.push({ messages: [msg, nextMsg], tokens: tokens + nextTokens });
      i += 2;
    } else {
      groups.push({ messages: [msg], tokens });
      i++;
    }
  }

  // Work backwards, include groups that fit the budget.
  // ALWAYS include at least the most recent group so the agent can see
  // what it's supposed to respond to, even if it exceeds the budget.
  let usedTokens = 0;
  const includedGroups: Group[] = [];

  for (let g = groups.length - 1; g >= 0; g--) {
    if (usedTokens + groups[g].tokens > availableTokens && includedGroups.length > 0) {
      break;
    }
    includedGroups.push(groups[g]);
    usedTokens += groups[g].tokens;
  }

  // Safety: if nothing was included (all groups exceed budget), include the last one anyway.
  // An over-budget context is better than no context at all.
  if (includedGroups.length === 0 && groups.length > 0) {
    includedGroups.push(groups[groups.length - 1]);
    logger.warn('budgetFreshTail: all groups exceed budget, forcing last group inclusion', {
      groupCount: groups.length,
      lastGroupTokens: groups[groups.length - 1].tokens,
      availableTokens,
    });
  }

  // Flatten and return in chronological order
  return includedGroups.reverse().flatMap(g => g.messages);
}

/**
 * Ensure tool_use / tool_result pairs are always complete.
 * Every tool_use in an assistant message must have a matching tool_result in the
 * immediately following user/tool message, and vice versa.
 */
function sanitizeToolPairs(messages: Message[]): Message[] {
  // Build list with parsed tool IDs for each message.
  interface Annotated {
    msg: Message;
    toolUseIds: string[];   // IDs from tool_use blocks (assistant messages)
    toolResultIds: string[]; // IDs from tool_result blocks (tool messages)
  }

  const annotated: Annotated[] = messages.map((msg) => {
    const toolUseIds: string[] = [];
    const toolResultIds: string[] = [];

    try {
      const parsed = JSON.parse(msg.content);
      if (Array.isArray(parsed)) {
        for (const block of parsed) {
          if (block.type === 'tool_use' && block.id) {
            toolUseIds.push(block.id);
          }
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolResultIds.push(block.tool_use_id);
          }
        }
      }
    } catch {
      // Plain text, no tool blocks
    }

    return { msg, toolUseIds, toolResultIds };
  });

  // Bug history: the old version of this function required the tool_use
  // message to be IMMEDIATELY followed by its tool_result message
  // (next.role === 'tool', next.toolResultIds matches). Any intruder
  // in between (an engine ack, a tool's synthetic-delivery assistant
  // message, a mid-turn system note) caused BOTH the valid tool_use
  // AND its tool_result to be dropped, the model lost all record of
  // having called the tool, and naturally called it again on the next
  // iteration. Every subsequent loop appended another broken pair,
  // producing the "agent repeats itself" behavior seen on image_create,
  // transcribe_audio, and any other tool that delivers mid-turn.
  //
  // The new behavior: instead of dropping the pair, drop the
  // intruders between them. We walk forward from each unmatched
  // tool_use, search for the first tool message whose resultIds
  // satisfy the use, and mark any non-tool messages we pass through
  // for removal. This preserves the model's tool-call context while
  // still producing API-valid adjacency.

  // Bug history, part two (2026-07-10, the months-long re-answer ghost): the
  // "drop the intruders" behavior above turned out to be the root cause of the
  // agent re-answering settled questions. In a tail where several turns and
  // conversations interleave by created_at, the walk from a tool_use to its
  // result passes over ORDINARY CONVERSATION, the agent's delivered answers,
  // acks, other turns' text, and deleted it all as intruders. The model then
  // saw a promise and tool math with no delivered answer (an apparently
  // unfinished job) and dutifully finished it, re-answering the user on every
  // wake. 54 messages went into this function on the diagnosed box; 14 came
  // out. The tool-repeat disease this function's LAST fix addressed was the
  // same disease one level down; deletion just moved the damage.
  //
  // The invariant actually required is ADJACENCY, not absence: REORDER instead
  // of remove. A valid pair emits use-then-result back to back; the messages
  // that sat between them emit immediately AFTER the pair, in their original
  // relative order. Chronology bends slightly at the seam; nothing is lost.
  // Tool_use messages encountered while deferring stay unconsumed so the outer
  // walk gives each its own pairing pass. All the genuine-brokenness drops are
  // preserved exactly: an unmatched tool_use is dropped, a partial parallel
  // match drops the pair, an orphaned tool_result is dropped in pass two.
  const consumed = new Array<boolean>(annotated.length).fill(false);
  const dropped = new Array<boolean>(annotated.length).fill(false);
  const outOrder: number[] = [];

  for (let i = 0; i < annotated.length; i++) {
    if (consumed[i] || dropped[i]) continue;
    const entry = annotated[i];
    if (entry.toolUseIds.length === 0) {
      outOrder.push(i);
      consumed[i] = true;
      continue;
    }

    const useIdSet = new Set(entry.toolUseIds);

    // Walk forward looking for the matching tool_result, collecting what sits
    // in between for deferral (NOT deletion).
    let resultIdx = -1;
    const betweenIdx: number[] = [];
    for (let j = i + 1; j < annotated.length; j++) {
      if (consumed[j] || dropped[j]) continue;
      const cand = annotated[j];
      if (cand.msg.role === 'tool' && cand.toolResultIds.length > 0) {
        const matched = cand.toolResultIds.some((id) => useIdSet.has(id));
        if (matched) {
          resultIdx = j;
          break;
        }
        // An orphaned tool_result for some other use; defer past it, pass two
        // decides its fate.
        betweenIdx.push(j);
        continue;
      }
      betweenIdx.push(j);
    }

    if (resultIdx === -1) {
      // No matching tool_result anywhere ahead. The tool_use is genuinely
      // unanswered (in-progress turn that hasn't reached tool execution yet,
      // or a real broken state). Drop the tool_use itself; everything deferred
      // stays for the outer walk.
      dropped[i] = true;
      continue;
    }

    // Verify EVERY use_id has a matching result_id in the chosen tool message.
    // Partial matches mean the model expected N parallel results but only got
    // M; treating that as a mismatch is the conservative choice.
    const resultIdSet = new Set(annotated[resultIdx].toolResultIds);
    const allMatched = entry.toolUseIds.every((id) => resultIdSet.has(id));
    if (!allMatched) {
      dropped[i] = true;
      dropped[resultIdx] = true;
      continue;
    }

    // Pair valid: emit adjacently, then the deferred conversation in order.
    // Deferred tool_use messages (and stray tool messages) stay unconsumed so
    // the outer walk pairs them on its own pass.
    outOrder.push(i);
    consumed[i] = true;
    outOrder.push(resultIdx);
    consumed[resultIdx] = true;
    for (const k of betweenIdx) {
      if (consumed[k] || dropped[k]) continue;
      const deferredEntry = annotated[k];
      if (deferredEntry.toolUseIds.length > 0) continue;                       // its own pairing pass
      if (deferredEntry.msg.role === 'tool' && deferredEntry.toolResultIds.length > 0) continue; // pass two
      outOrder.push(k);
      consumed[k] = true;
    }
  }

  // Anything never consumed nor dropped (trailing orphan tool messages the
  // deferral skipped) joins the tail in original order for pass two to judge.
  for (let i = 0; i < annotated.length; i++) {
    if (!consumed[i] && !dropped[i]) {
      outOrder.push(i);
      consumed[i] = true;
    }
  }

  // Second pass (unchanged semantics, applied over the EMITTED order): drop
  // orphaned tool_result messages that never sit adjacent to their kept
  // tool_use. With pairs emitted adjacently, the nearest preceding
  // tool_use-bearing kept message must match.
  const keepOut = new Array<boolean>(outOrder.length).fill(true);
  for (let oi = 0; oi < outOrder.length; oi++) {
    const entry = annotated[outOrder[oi]];
    if (entry.msg.role !== 'tool' || entry.toolResultIds.length === 0) continue;
    let matchedToKeptUse = false;
    for (let oj = oi - 1; oj >= 0; oj--) {
      if (!keepOut[oj]) continue;
      const prev = annotated[outOrder[oj]];
      if (prev.toolUseIds.length === 0) continue;
      const useIdSet = new Set(prev.toolUseIds);
      if (entry.toolResultIds.some((id) => useIdSet.has(id))) {
        matchedToKeptUse = true;
      }
      break;
    }
    if (!matchedToKeptUse) keepOut[oi] = false;
  }

  const result = outOrder.filter((_, oi) => keepOut[oi]).map((oi) => annotated[oi].msg);

  const droppedCount = annotated.length - result.length;
  if (droppedCount > 0) {
    // Only genuinely broken tool messages are dropped now (unmatched tool_use,
    // partial parallel match, orphaned tool_result); conversation is never
    // dropped, it is deferred past the pair instead.
    const droppedDetails = annotated
      .map((a, i) => (dropped[i] || !consumed[i]) ? `[${i}] role=${a.msg.role} useIds=${a.toolUseIds.join(',')} resultIds=${a.toolResultIds.join(',')}` : null)
      .filter(Boolean);
    logger.warn(`Dropped ${droppedCount} genuinely broken tool message(s) while sanitizing tool pairs`, {
      details: droppedDetails.slice(0, 10),
    });
  }

  return result;
}

function parseMessageContent(
  msg: Message,
): string | Anthropic.ContentBlockParam[] {
  try {
    const parsed = JSON.parse(msg.content);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return msg.content;
  } catch {
    return msg.content;
  }
}

function mergeConsecutiveRoles(
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
): Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }> {
  const merged: typeof messages = [];

  for (const msg of messages) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      const prev = merged[merged.length - 1];
      if (typeof prev.content === 'string' && typeof msg.content === 'string') {
        prev.content = prev.content + '\n\n' + msg.content;
      } else {
        const prevArr = typeof prev.content === 'string'
          ? [{ type: 'text' as const, text: prev.content }]
          : prev.content;
        const msgArr = typeof msg.content === 'string'
          ? [{ type: 'text' as const, text: msg.content }]
          : msg.content;
        // Deduplicate tool_result blocks by tool_use_id
        const combined = [...prevArr, ...msgArr];
        const seenToolResultIds = new Set<string>();
        const deduped = combined.filter((block) => {
          const b = block as unknown as Record<string, unknown>;
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            if (seenToolResultIds.has(b.tool_use_id)) return false;
            seenToolResultIds.add(b.tool_use_id);
          }
          return true;
        });
        prev.content = deduped;
      }
    } else {
      merged.push({ ...msg });
    }
  }

  return merged;
}
