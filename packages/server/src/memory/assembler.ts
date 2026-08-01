import type Anthropic from '@anthropic-ai/sdk';
import { renderTaskStamps, renderStepFacts, type TaskStampFields } from '../tracker/task-stamps.js';
import { getDb as getStampDb } from '../db/connection.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { taskScope, msToText, revertCountExpr, stampColumns } from '../work/tracker-view.js';
import { type PromptTurnContext } from '../prompt/assembler.js';
import { conversationKey, type TurnCounterparty } from '../agent/v2/counterparty.js';
import { getContextWindow } from '../agent/model.js';
import { getRecentMessages } from './store.js';
import { estimateTokens, contextWindowPolicy, assertSystemPromptFits, SUMMARY_SHARE } from './budget.js';
import { getContextSummaries } from './dag.js';
import { getLatestBriefing } from './briefing.js';
import { retrieveForContext } from '../vault/retrieval.js';
import { isPMAgent } from '../config/platform.js';
import { buildAssemblyContext, assembleSystemFromRegistry } from '../prompt/registry/assembler.js';
import type { AssemblyTurnState } from '../prompt/registry/types.js';
// (getRuntimeVersion import removed in Phase 9 Stage 2, single-track v2)
import { turnBoundary, currentTurnConversationId } from '../agent/turn-state.js';
import type { Summary } from './dag.js';
import type { Message } from '@dojo/shared';
import { parseDivider, NEW_SESSION_DIVIDER_LABEL } from '@dojo/shared';

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
const TECHNIQUE_FRESH_SENTINEL = '══ TECHNIQUE FRESH READ ══';

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
      // wrapTechniqueResult emits exactly:
      //   `══ TECHNIQUE FRESH READ ══ <name> (<timestamp>)\n...`
      const m2 = b.content.match(/^══ TECHNIQUE FRESH READ ══ (.+?) \(/);
      if (m2) names.add(m2[1]);
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
  let merged = mergeConsecutiveRoles(messages);

  // Self-heal: drop orphaned tool blocks so a broken tool_use/tool_result
  // invariant doesn't cause provider errors. Loud warning if >half is dropped.
  const preSanitizeCount = merged.length;
  merged = sanitizeToolBlocks(merged, agentId);
  if (merged.length < preSanitizeCount / 2 && preSanitizeCount > 4) {
    logger.error('sanitizeToolBlocks dropped over half the context, possible bug', {
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
    merged.push({
      role: 'user',
      content:
        '[Engine: end of recorded history. Everything above, including your own final ' +
        'replies, was already delivered to its recipients. Continue from the newest ' +
        'event of THIS turn; do not re-send or re-answer anything above.]',
    });
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
  const { messages, freshTailDropped } = await assembleMessageContext(agentId, modelId, systemPrompt, turnContext);
  // systemVolatile is empty after P-1 (all per-turn volatile content moved to the
  // msg.turn-context tail); the field is the reserved system-side lane (P-2).
  return { systemPrompt, systemVolatile: '', messages, systemEntryIds: sys.entryIds, freshTailDropped };
}

/**
 * Prose fallback for identifying an inbound A2A row when its structured origin is
 * missing (legacy/un-classified rows). The PRIMARY signal is the structured
 * `origin.kind === 'agent'` (derived from the source_agent_id / a2a_thread_id
 * columns); this regex is only the backup so a row without origin can't slip through.
 */
const A2A_INBOUND_RE = /^\s*(\[A2A:|\[SOURCE: AGENT MESSAGE FROM|\[SOURCE: GROUP BROADCAST FROM|\[SOURCE: PM AGENT POKE FROM)/;

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

async function assembleMessageContext(
  agentId: string,
  modelId: string,
  systemPrompt: string,
  turnContext?: PromptTurnContext,
): Promise<AssembledContext> {
  const contextWindow = getContextWindow(modelId);
  // ONE budget (PHASE-3 T2): threshold, reserve and ceiling from `memory/budget.ts`.
  const policy = contextWindowPolicy(contextWindow);
  const maxTokens = policy.assemblyBudgetTokens;

  // Budget the message array against the registry-produced system prompt's size.
  let usedTokens = estimateTokens(systemPrompt);
  // Fail loud rather than assemble a lie: a negative budget used to produce a
  // single-message context silently (budgetFreshTail's last-group safety, nothing logged).
  assertSystemPromptFits(usedTokens, policy);

  const messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }> = [];

  // PM agent gets a lightweight context: system prompt + recent messages only.
  // No briefing, no vault, no summaries. The tracker is its memory.
  if (isPMAgent(agentId)) {
    const freshTail = getRecentMessages(agentId, 10);
    const tailMessages = budgetFreshTail(freshTail, maxTokens - usedTokens);
    const sanitized = sanitizeToolPairs(tailMessages);

    for (const msg of sanitized) {
      const parsed = parseMessageContent(msg);
      if (msg.role === 'tool') {
        messages.push({ role: 'user', content: parsed as Anthropic.ContentBlockParam[] });
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: parsed });
      }
    }

    // Ensure starts with user role
    while (messages.length > 0 && messages[0].role !== 'user') messages.shift();

    logger.debug('PM agent context assembled (lightweight)', {
      agentId,
      systemTokens: usedTokens,
      messageCount: messages.length,
    }, agentId);

    return { systemPrompt, systemVolatile: "", messages };
  }

  // Track whether any scaffolding section was injected so we can push a
  // single combined ack at the end (instead of one ack per section).
  let injectedAnyScaffolding = false;

  // ── v2 scaffolding gating (Part V + Part XVIII §C; v2.9.20 post-
  // compaction re-fire) ──
  //
  // In v1, scaffolding (briefing/vault/tracker/continuity) injects every
  // turn, costing 5–10K tokens per turn even when nothing is new. In v2,
  // scaffolding injects ONLY on session-start turns (first turn after a
  // session reset, or first turn ever for an agent). Mid-session turns
  // skip scaffolding entirely. The agent retrieves anything they need
  // on demand via vault_search / work_update(action="get") / etc.
  //
  // v2.9.20: that original design assumed the agent would *know* to
  // retrieve. After compaction, the live tail can lose enough
  // procedural context that the agent doesn't realize it should
  // re-establish, Mike's 2026-06-06 photo-album incident showed the
  // agent literally "felt like a brand new session" when scaffolding
  // had last fired 30 turns earlier despite multiple compactions in
  // between. So now we ALSO fire scaffolding for a window after each
  // compaction. The window expires (we don't pay v1's per-turn cost
  // forever) but covers enough turns for the agent to re-internalise
  // its project context.
  const isSessionStartTurn = isV2SessionStart(agentId);
  const isWithinPostCompactionScaffoldingWindow = (() => {
    try {
      const configRow = getDb().prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
      if (!configRow?.config) return false;
      const cfg = JSON.parse(configRow.config) as Record<string, unknown>;
      const validUntil = cfg.continuityBriefValidUntilTurn as number | undefined;
      if (typeof validUntil !== 'number' || validUntil <= 0) return false;
      const turnRow = getDb()
        .prepare('SELECT MAX(turn_number) AS max_turn FROM messages WHERE agent_id = ?')
        .get(agentId) as { max_turn: number | null } | undefined;
      const currentTurn = (turnRow?.max_turn ?? 0) + 1;
      // Brief itself injects through turn `validUntil` (3 turns by
      // default). We re-fire the wider scaffolding for an additional
      // 5 turns past that, giving the agent ~8 turns of full context
      // post-compaction to re-establish.
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

  // 2. Morning briefing, session-start only
  if (shouldFireScaffolding) {
    const briefing = getLatestBriefing(agentId);
    if (briefing) {
      const briefingText = `<briefing generated="${new Date().toISOString().split('T')[0]}">\n${briefing.content}\n</briefing>`;
      const briefingTokens = estimateTokens(briefingText);

      if (usedTokens + briefingTokens < maxTokens) {
        messages.push({ role: 'user', content: briefingText });
        usedTokens += briefingTokens;
        injectedAnyScaffolding = true;
      }
    }
  }

  // 2.5. Vault entries, v1: always; v2: session start only (Part XVIII §C)
  // In v2 the vault is treated as long-term memory injected once at session
  // start, like Claude Code's CLAUDE.md. Per-turn vault retrieval moves to
  // the agent's explicit vault_search calls.
  //
  // Session-start vault content is the union of:
  //   1. Pinned entries (always-load, handled by retrieveForContext)
  //   2. `session_context`-tagged entries (Phase 4 §C, explicit session load)
  //   3. Relevance-ranked entries for the current conversation topic (legacy)
  //
  // This is additive: existing users get their pinned + relevance behavior;
  // new users can opt into the Claude Code pattern by tagging entries
  // `session_context` and pinning the truly always-load ones.
  if (shouldFireScaffolding) {
    try {
      const recentForQuery = getRecentMessages(agentId, 3);
      let queryText = recentForQuery.map(m => m.content).join(' ').slice(0, 500);
      if (queryText.length <= 10) {
        queryText = 'current projects active tasks recent work status updates decisions';
      }
      const vaultResult = await retrieveForContext(queryText, contextWindow, agentId);
      const sections: string[] = [];
      if (vaultResult.section) sections.push(vaultResult.section);

      // Phase 4 §C, also inject session_context-tagged entries that aren't
      // already in the relevance result. Dedupe by entry ID.
      try {
        const { getSessionContextEntries } = await import('../vault/store.js');
        // W3-4: scoped to this agent's vault (per-agent design).
        const sessionCtx = getSessionContextEntries(agentId);
        const alreadyIncluded = new Set(vaultResult.entryIds);
        const fresh = sessionCtx.filter((e) => !alreadyIncluded.has(e.id));
        if (fresh.length > 0) {
          const lines = fresh.map((e) => `[${e.type}] ${e.content}`);
          const sessionCtxSection =
            `═══ SESSION CONTEXT (vault entries tagged session_context) ═══\n${lines.join('\n\n')}\n═══ END SESSION CONTEXT ═══`;
          sections.push(sessionCtxSection);
        }
      } catch {
        /* best effort */
      }

      if (sections.length > 0) {
        const combined = sections.join('\n\n');
        const vaultTokens = estimateTokens(combined);
        if (usedTokens + vaultTokens < maxTokens) {
          messages.push({ role: 'user', content: combined });
          usedTokens += vaultTokens;
          injectedAnyScaffolding = true;
        }
      }
    } catch (err) {
      logger.warn('Vault context injection failed', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }

  // 3. Summaries from context_items
  const rawSummaries = getContextSummaries(agentId);

  // v2.7.7, scrub summaries that reference techniques the agent has
  // freshly read in the current fresh tail. Pre-existing summaries
  // describe earlier versions of the technique and are the path by
  // which an agent ends up referencing scripts that no longer exist.
  // Cheap recent-window scan: just enough to catch fresh reads.
  let freshlyReadTechniques: Set<string> = new Set();
  try {
    const recentForScrub = getRecentMessages(agentId, 30);
    freshlyReadTechniques = extractFreshlyReadTechniques(recentForScrub);
  } catch { /* best effort, fall back to no scrub */ }
  const summaries = scrubSummariesAgainstFreshTechniques(rawSummaries, freshlyReadTechniques);

  if (summaries.length > 0) {
    // Selection by meaning under a hard cap (budgetSummaries is the internal
    // fallback when relevance scoring can't run, see selectSummariesByRelevance).
    const summariesToInclude = await selectSummariesByRelevance(summaries, maxTokens - usedTokens, agentId);

    if (summariesToInclude.length > 0) {
      const summaryText = summariesToInclude.map(s => formatSummaryXml(s)).join('\n\n');
      const summaryTokens = estimateTokens(summaryText);

      const wrappedText = `═══ COMPRESSED HISTORY (summaries of earlier messages, not live conversation) ═══\nThe following are compressed summaries of older conversation history. These capture key facts and decisions but are NOT live messages. Do not respond to them directly, they are context only. Any "couldn't do X" / "not supported" noted here may be outdated (the platform gains tools over time); check your current tool list before repeating it.\n\n${summaryText}\n\n═══ END COMPRESSED HISTORY ═══`;

      messages.push({ role: 'user', content: wrappedText });
      usedTokens += summaryTokens;
      injectedAnyScaffolding = true;
    }
  }

  // 3.6. Relevant memory (remediation Phase 2, Invariant II): per-turn pull of
  // OLD raw messages by meaning. Summaries cover compacted epochs; this covers
  // facts still in un-compacted history that have fallen out of the fresh
  // tail (told two sessions ago, never compacted, not yet vaulted by the
  // Dreamer). Tight budget, cached per query so per-iteration context
  // rebuilds don't re-run vector search.
  try {
    // D4: include a per-turn vault subsection on non-scaffolding turns (session
    // start already injects the vault via retrieveForContext, so skip there).
    const block = await buildRelevantMemoryBlock(agentId, !shouldFireScaffolding);
    if (block && estimateTokens(block) < maxTokens - usedTokens) {
      messages.push({ role: 'user', content: block });
      usedTokens += estimateTokens(block);
      injectedAnyScaffolding = true;
    }
  } catch (err) {
    logger.debug('relevant-memory block failed', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  // 3.7. Attempt ledger (remediation Phase 2, Invariant II / Cluster C):
  // deterministic task-id join, NOT semantic, the engine knows which task
  // the agent is on. What was already tried is engine fact and belongs in
  // front of the model before it repeats itself ("works in circles"). The
  // durable record (task_log + tasks.revert_count) existed all along; this
  // surfaces it. Tight cap; rejects and recent transitions matter most.
  try {
    const { listTasks } = await import('../tracker/schema.js');
    const { getRecentObservations, getRecentTransitions, formatEntryLine } = await import('../tracker/task-log.js');
    const activeForLedger = listTasks({ status: 'in_progress', assignedTo: agentId }).slice(0, 2);
    const sections: string[] = [];
    for (const task of activeForLedger) {
      const entries = [
        ...getRecentObservations(task.id, 4),
        ...getRecentTransitions(task.id, 4),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-6);
      if (entries.length === 0) continue;
      let revertNote = '';
      try {
        const row = getDb().prepare(`SELECT ${revertCountExpr('w')} AS revert_count FROM work w WHERE w.id = ?`)
          .get(task.id) as { revert_count: number | null } | undefined;
        if (row?.revert_count) revertNote = `, reverted ${row.revert_count}x already`;
      } catch { /* column may not exist on old DBs */ }
      sections.push(`Task "${task.title}"${revertNote}:\n${entries.map((e) => `  ${formatEntryLine(e)}`).join('\n')}`);
    }
    if (sections.length > 0) {
      const ledgerText = `═══ ATTEMPT LEDGER (engine record of work on your active tasks, do not repeat attempts already logged here) ═══\n${sections.join('\n\n')}\n═══ END ATTEMPT LEDGER ═══`;
      const ledgerTokens = estimateTokens(ledgerText);
      if (ledgerTokens < 800 && ledgerTokens < maxTokens - usedTokens) {
        messages.push({ role: 'user', content: ledgerText });
        usedTokens += ledgerTokens;
        injectedAnyScaffolding = true;
      }
    }
  } catch { /* tracker may be empty or absent */ }

  // 3.5. Active task injection, v1: always; v2: session start only AND
  // skip if the last 3 turns already mention any of those task IDs (Part V
  // table). The skip avoids re-injecting the same task block when the agent
  // is already actively discussing those tasks, common right after a
  // session reset where they immediately picked up the work.
  if (shouldFireScaffolding) try {
    const { listTasks } = await import('../tracker/schema.js');
    const activeTasks = listTasks({ status: 'in_progress', assignedTo: agentId });
    if (activeTasks.length > 0) {
      // Skip task scaffolding injection if the last 3 turns already mention
      // these task IDs, no point repeating them in the prompt.
      let allMentionedRecently = false;
      {
        const recent = getRecentMessages(agentId, 6); // ~3 outer turns of msgs
        const recentText = recent.map(m => m.content).join(' ');
        allMentionedRecently = activeTasks.every(t =>
          recentText.includes(t.id) || recentText.includes(t.id.slice(0, 8)),
        );
      }
      if (!allMentionedRecently) {
        // Ticket stamps (2026-07-22): this standing view used to say "work on
        // this" with zero state, steering the model into re-doing delivered
        // work. Each line now carries the engine's stamp (one compact line)
        // plus live step-sequence facts, so the model KNOWS state here.
        const stampStmt = getStampDb().prepare(
          `SELECT w.id AS id, ${stampColumns('w')},
                  w.step_number AS step_number, w.total_steps AS total_steps,
                  w.parent_id AS project_id
             FROM work w WHERE ${taskScope('w')} AND w.id = ?`,
        );
        const taskLines = activeTasks.slice(0, 5).map(t => {
          let line = `• ${t.title} (ID: ${t.id.slice(0, 8)}, priority: ${t.priority})`;
          try {
            const st = stampStmt.get(t.id) as TaskStampFields | undefined;
            if (st) {
              const stamp = renderTaskStamps(st);
              const steps = renderStepFacts(st);
              line += `\n  State: ${stamp}${steps ? ` | ${steps}` : ''}`;
            }
          } catch { /* stamps are best-effort */ }
          if (t.description) line += `\n  Instructions: ${t.description.slice(0, 300)}${t.description.length > 300 ? '...' : ''}`;
          if (t.notes) {
            const lastNote = t.notes.split('\n').filter(Boolean).pop();
            if (lastNote) line += `\n  Last note: ${lastNote.slice(0, 200)}`;
          }
          return line;
        });
        const taskContext = `═══ YOUR ACTIVE TASKS (from tracker, ground truth) ═══\nYou are currently assigned to these in_progress tasks. This is what you should be working on:\n\n${taskLines.join('\n\n')}\n\n═══ END ACTIVE TASKS ═══`;
        const taskTokens = estimateTokens(taskContext);
        if (usedTokens + taskTokens < maxTokens) {
          messages.push({ role: 'user', content: taskContext });
          usedTokens += taskTokens;
          injectedAnyScaffolding = true;
        }
      }
    }
  } catch { /* tracker may not be available */ }

  // 3.7. Continuity brief.
  // v1: inject on every assembly when present.
  // v2 (Phase 4 §C, Part XVIII §C): inject ONLY for the 3 turns after an
  // emergency compaction set continuityBriefValidUntilTurn. After that
  // window the fresh tail is authoritative and the brief falls away.
  // Below, currentTurn = MAX(turn_number)+1, the same number v2/loop.ts
  // uses to label the in-progress turn.
  try {
    const db = getDb();
    const configRow = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
    if (configRow?.config) {
      const agentConfig = JSON.parse(configRow.config) as Record<string, unknown>;
      const continuityBrief = agentConfig.continuityBrief as string | undefined;

      let shouldInjectBrief = false;
      // Inject only if we're inside the validUntilTurn window (set when the
      // brief was generated). Outside that window, the brief is stale and the
      // fresh tail is more authoritative anyway.
      const validUntil = agentConfig.continuityBriefValidUntilTurn as number | undefined;
      if (typeof validUntil === 'number' && validUntil > 0) {
        const turnRow = db
          .prepare('SELECT MAX(turn_number) AS max_turn FROM messages WHERE agent_id = ?')
          .get(agentId) as { max_turn: number | null } | undefined;
        const currentTurn = (turnRow?.max_turn ?? 0) + 1;
        shouldInjectBrief = currentTurn < validUntil;
      }

      if (shouldInjectBrief && continuityBrief && continuityBrief.length > 50) {
        // Wrap with explicit framing so the agent doesn't treat the brief
        // as authoritative when it conflicts with the fresh tail.
        const wrappedBrief = `═══ CONTINUITY BRIEF (snapshot from before the last compaction, the live conversation below is more recent and authoritative when in conflict) ═══\n\n${continuityBrief}\n\n═══ END CONTINUITY BRIEF ═══`;
        const briefTokens = estimateTokens(wrappedBrief);
        if (usedTokens + briefTokens < maxTokens) {
          messages.push({ role: 'user', content: wrappedBrief });
          usedTokens += briefTokens;
          injectedAnyScaffolding = true;
        }
      }
    }
  } catch { /* best effort */ }

  // 3.85. Agent scratchpad, agent-controlled outline / progress / checkpoint
  // surface set via scratchpad_set. Re-injected every turn so the agent's
  // working state survives compaction. Sits just before the ACTIVE USER
  // DIRECTIVE so the directive remains closest to fresh tail.
  try {
    const db = getDb();
    const cfgRow = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
    if (cfgRow?.config) {
      const cfg = JSON.parse(cfgRow.config) as Record<string, unknown>;
      const scratchpad = typeof cfg.scratchpad === 'string' ? cfg.scratchpad.trim() : '';
      if (scratchpad.length > 0) {
        const block =
          `═══ YOUR SCRATCHPAD (agent-maintained outline + progress, survives compaction; update with scratchpad_set) ═══\n` +
          `${scratchpad}\n` +
          `═══ END SCRATCHPAD ═══`;
        const scratchTokens = estimateTokens(block);
        if (usedTokens + scratchTokens < maxTokens) {
          messages.push({ role: 'user', content: block });
          usedTokens += scratchTokens;
          injectedAnyScaffolding = true;
        }
      }
    }
  } catch (err) {
    logger.warn('Scratchpad injection failed', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  // 3.9. Active user directive, pin the user's most recent substantive ask
  // verbatim, right before the fresh tail. Survives compaction (read fresh
  // from messages every turn), so even when the original prompt has been
  // folded into a summary, the agent still sees what's being asked in the
  // user's own words. This is the "don't forget what we're doing" anchor
  //, the single most important piece of context the system can preserve.
  try {
    const { getActiveUserDirective, formatDirectiveBlock } = await import('./directive.js');
    // On a human/A2A turn, the directive must be the human's ask, never a
    // scheduler/reminder event that just fired (OPEN-11). On an engine turn the
    // engine event IS the directive, so keep engine rows eligible there.
    // T-1: on a HUMAN turn, scope the directive to THIS conversation so a different
    // human's task can't be pinned as the active directive (cross-conversation leak).
    // On engine/A2A turns leave it unscoped (the engine event / A2A thread drives those).
    const cp = turnContext?.counterparty;
    // RR#1 (comms-audit): scope to the EXACT conv_key the pickup stamped on the
    // trigger (chosenConversationId, mirrored into currentTurnConversationId), NOT re-derived
    // from the resolved counterparty. resolveTurnCounterparty can downgrade the channel
    // (inboundChannel ?? origin.channel) or substitute the owner name where the pickup
    // used the raw sender, producing a key that does not equal the stamped one, which
    // would empty the ACTIVE USER DIRECTIVE on the very turn meant to answer the user.
    // Fall back to re-derivation only outside a turn (map unset).
    const stampedConversationId = currentTurnConversationId.get(agentId);
    // C16: on an A2A (agent) or engine turn, SUPPRESS the ACTIVE USER DIRECTIVE entirely.
    // Those turns have their OWN directive source, the A2A payload / engine event, already
    // scoped into the tail and rendered by the counterparty/engine header. Passing null here
    // meant "unscoped = pick the newest user row across ALL conversations", which on an A2A
    // turn selected the A2A inbound (role='user', no conversation) and rendered it as
    // "ACTIVE USER DIRECTIVE" while the header said "this is NOT your user", identity
    // conflation on exactly the turns the redesign isolates. The '__none__' sentinel makes
    // getActiveUserDirective return null. Human turns keep their scoped directive.
    // PHASE-2 T10I: there is no re-derivation fallback any more, and that is deliberate.
    // The old `?? conversationKey(...)` could rebuild the STRING outside a turn; a
    // `conversations.id` cannot be computed from a counterparty without a database read, and
    // reading (or worse, minting) one here would put a second conversations writer inside
    // the assembler. Unset map = no scope, which is the same "pick the newest user row" the
    // old code reached when the map was unset. The turn sets the map at pickup.
    const directiveConversationId =
      (turnContext?.isEngineTurn || cp?.kind === 'agent')
        ? '__none__'
        : (cp && cp.kind === 'user' ? (stampedConversationId ?? null) : null);
    const directive = getActiveUserDirective(agentId, {
      excludeEngine: !turnContext?.isEngineTurn,
      conversationId: directiveConversationId,
    });
    if (directive) {
      const block = formatDirectiveBlock(directive);
      const directiveTokens = estimateTokens(block);
      if (usedTokens + directiveTokens < maxTokens) {
        messages.push({ role: 'user', content: block });
        usedTokens += directiveTokens;
        injectedAnyScaffolding = true;
      }
    }
  } catch (err) {
    logger.warn('Active directive injection failed', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  // Single combined ack for ALL scaffolding sections. Pre-2026-05-01 each
  // section pushed its own assistant ack, five separate scaffolding
  // messages. Now one ack closes them all. The ack also names the
  // source-priority hierarchy explicitly so the agent doesn't anchor
  // on a stale brief or vault entry when the live conversation
  // (below) shows different state, a common failure mode that drove
  // verification spirals before this framing was added.
  if (injectedAnyScaffolding) {
    const combinedAck = 'Understood, I have reviewed my background context (briefing, vault, summaries, active tasks, continuity brief, scratchpad, active user directive). Source priority for this turn: active user directive > my scratchpad > live conversation below > active tracker tasks > continuity brief > vault entries > briefing. When sources disagree, trust the most recent and most specific. The active user directive is the WHAT, never lose it. The scratchpad is my own working outline; I maintain it via scratchpad_set as I make progress and read from it when I need to remember where I am.';
    messages.push({ role: 'assistant', content: combinedAck });
    usedTokens += estimateTokens(combinedAck);
  }

  // NOTE: the current clock time is intentionally NOT injected here. It is a
  // volatile, per-call value, and injecting it BEFORE the fresh tail would
  // break prompt caching for the entire conversation history (the cache prefix
  // would diverge at the timestamp every turn). It is instead injected as the
  // LAST engine message in the loop (msg.current-time), after the fresh tail,
  // where its churn costs no cache. See renderCurrentTimeMessage().

  // 4. Fresh tail, exclude user messages that arrived after the current turn
  // started so they get a clean run via the wakeup mechanism instead of being
  // buried mid-context where the LLM might ignore them
  const freshTailCount = policy.freshTailCount;
  const turnCutoff = turnBoundary.get(agentId);
  const freshTailRaw = getRecentMessages(agentId, freshTailCount, turnCutoff);

  // Counterparty scoping (attribution redesign, Phase 4), the live
  // conversation is scoped to the ONE counterparty this turn addresses, so the
  // model can never see two senders' messages mixed together (the root of the
  // "the PM agent is asking me two things" conflation).
  //   • User turn  → the human conversation only (A2A inbound + the agent's own
  //                  send_to_agent activity stripped; engine events stay for now,
  //                  Phase 5 moves them to a dedicated EVENTS lane).
  //   • A2A turn   → ONLY the current A2A thread + the agent's own output. The
  //                  human's live messages are excluded; the agent answers about
  //                  the user's work from MEMORY (vault/summaries/tracker), not
  //                  the raw user tail. This is what the redesign turns on.
  // Messages are untouched on disk, this only shapes what THIS turn's model
  // call sees; memory/dreamer/vault are unaffected.
  const scopedTail = turnContext?.counterparty?.kind === 'agent'
    ? scopeToA2AThread(freshTailRaw, turnContext.counterparty.threadId)
    : turnContext?.isEngineTurn
    ? scopeToEngineTurn(freshTailRaw)
    : scopeToHumanConversation(freshTailRaw, turnContext?.counterparty, currentTurnConversationId.get(agentId) ?? null);

  // ── EVENTS lane (attribution redesign, Phase 5) ──
  // Engine-origin messages (tracker/scheduler/healer/system notices) are events
  // that HAPPENED, not the user or another agent talking. Today they ride in
  // the live tail as role='user' with a [SOURCE: …] marker, so a weak model can
  // mistake an engine notice for a peer message. Pull them OUT of the live
  // conversation and render them as ONE clearly-labeled background block. On a
  // clean turn (no engine events) this is a no-op, the live conversation is
  // unchanged. Actionable engine directives (STOP / gate refusals / nudges)
  // are tool_results or registry injections, not these role='user' notices, so
  // they keep their salience and are unaffected.
  // Only role='user' engine NOTICES (tracker/scheduler/healer/etc. that today
  // masquerade as user messages) go to the EVENTS lane. role='system' engine
  // messages are left in place, the message builder already skips them, and
  // surfacing them here would change long-standing behavior.
  // EVENTS / awareness lane: engine notices AND unauthorized human inbound (mailbox
  // notifications about the owner's inbox, unknown senders), things the agent should
  // be AWARE of but is NOT in conversation with. Authorized human inbound and the
  // current A2A counterparty stay in the live tail. (MESSAGE-ATTRIBUTION-REDESIGN §3, §4.4.)
  // An action-required engine-origin A2A message (Healer QUESTION, PM escalation,
  // destructive-gate approval token) is kept FULL in the live tail on its engine
  // turn instead of being collapsed into the truncated awareness gist, so the
  // receiver sees the whole directive it must act on. Everything else engine-origin
  // still goes to the awareness lane.
  const keepFullId = turnContext?.engineEventKeepFullId ?? null;
  const awarenessEvents = scopedTail.filter((m) =>
    m.role === 'user' &&
    (keepFullId ? m.id !== keepFullId : true) &&
    (m.origin?.kind === 'engine' || (m.origin?.kind === 'user' && m.origin?.authorized === false)),
  );
  const awarenessIds = new Set(awarenessEvents.map((m) => m.id));
  const freshTail = scopedTail.filter((m) => !awarenessIds.has(m.id));
  if (awarenessEvents.length > 0) {
    const eventLines = awarenessEvents.slice(-10).map((m) => {
      const o = m.origin;
      const rawContent = typeof m.content === 'string' ? m.content : '';
      const body = rawContent
        .replace(/^\s*\[[^\]]*\]\s*/, '') // drop the leading [SOURCE: …] marker
        .replace(/\s+/g, ' ')
        .trim();
      // Engine events are labeled by intent. An unauthorized human inbound is a
      // notification ABOUT the owner, label it by channel + sender so the agent
      // knows it is not addressed to it.
      const label = o?.kind === 'user'
        ? `${o.channel ?? 'msg'} notice${o.senderName ? ` from ${o.senderName}` : ''}`
        : (o?.intent ?? 'event');
      // RC-5.4: build the gist from the STRUCTURED inbound_meta fields when present
      // instead of slicing 400 chars of the notification boilerplate. The MAILBOX EVENT
      // preamble alone is ~407 chars, so the raw slice often carried ZERO email metadata
      // (the model woke knowing only "an email arrived" and improvised). For a mailbox
      // notification (user-kind awareness event) surface sender + subject + a short
      // preview; fall back to the raw slice when there is no structured meta.
      const structured = o?.kind === 'user' ? buildAwarenessGist(m.inboundMeta, rawContent) : null;
      const gist = structured ?? body.slice(0, 400);
      // Time-awareness: stamp each event with when it happened so notification
      // staleness ("arrived 3 hours ago" vs "just now") is subtraction, not a
      // guess. Deterministic per row, same cache property as the tail stamps.
      const at = renderMessageTimeStamp(m.createdAt);
      return `• ${at ?? ''}[${label}] ${gist}`;
    });
    messages.push({
      role: 'user',
      content:
        '═══ EVENTS & NOTICES (things that happened, and notifications addressed to the ' +
        'owner that you are AWARE of but are NOT in conversation with, NOT the person ' +
        'you are replying to below. Surface one to the owner only if it genuinely ' +
        'matters; never reply to its sender) ═══\n' +
        eventLines.join('\n'),
    });
  }

  // Pre-cap oversized tool_result content BEFORE budgeting. capLargeToolResultsInPlace
  // runs later (post-parse, on the in-memory message array) but by then it's too
  // late, budgetFreshTail has already used the raw uncapped token counts to decide
  // what fits. Without this pre-cap, a single 5.9MB tool_result would consume the
  // entire context budget and evict everything older, including the user's
  // actual question, leaving the model with no idea what was being asked.
  const cappedFreshTail = capLargeToolResultStrings(freshTail);

  // Budget: only include messages that fit
  const tailMessages = budgetFreshTail(cappedFreshTail, maxTokens - usedTokens);
  // FA-M1: budgetFreshTail drops whole groups oldest-first when the tail can't
  // fit. The output is a suffix of the input, so the length delta is exactly the
  // number of evicted messages. Captured here (before later orphan sanitization,
  // which drops for a different reason) so the loop can surface the live-view loss.
  const freshTailDropped = Math.max(0, cappedFreshTail.length - tailMessages.length);

  // Sanitize fresh tail: drop orphaned tool_result messages whose tool_use
  // was trimmed by budget constraints, and ensure valid pairing
  let sanitized = sanitizeToolPairs(tailMessages);

  // ── v2 stub-and-store (Part XVIII §E) ──
  // After STUB_AFTER_TURNS turns, raw tool_result content gets replaced with
  // a stub. Combined with vault as long-term memory (§C), the agent doesn't
  // need raw results kept around. Without this, even with per-tool result
  // caps and lazy loading, context grows linearly with turn count over a
  // long session. With it, context stays roughly flat, old tool results
  // become stubs and the model uses the vault for findings that matter.
  //
  // NULL turn_number → treated as "very old" (pre-v2 messages), they get
  // stubbed too. v2-persisted messages have turn_number set; the rare gap
  // is user messages (persisted by chat route) which are NULL but never
  // tool_result anyway, so stubOldToolResults skips them.
  sanitized = stubOldToolResults(sanitized, agentId);

  // Auto-load tools that appear in recent assistant tool_use blocks.
  // This handles the case where an agent previously loaded a tool but the
  // server restarted (in-memory session state was lost). Without this,
  // the agent would need to re-call load_tool_docs for tools it's already
  // been using in this conversation.
  try {
    const { markToolsLoaded } = await import('../tools/tool-docs.js');
    const seenToolNames = new Set<string>();
    for (const msg of sanitized) {
      if (msg.role !== 'assistant') continue;
      try {
        const parsed = JSON.parse(msg.content);
        if (Array.isArray(parsed)) {
          for (const block of parsed) {
            if (block?.type === 'tool_use' && typeof block.name === 'string') {
              seenToolNames.add(block.name);
            }
          }
        }
      } catch { /* not JSON, skip */ }
    }
    if (seenToolNames.size > 0) {
      markToolsLoaded(agentId, [...seenToolNames]);
    }
  } catch { /* best effort */ }

  for (const msg of sanitized) {
    const parsed = parseMessageContent(msg);

    if (msg.role === 'tool') {
      // Tool results go as user role with content blocks
      messages.push({ role: 'user', content: parsed as Anthropic.ContentBlockParam[] });
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      // For assistant messages with thinking-mode reasoning_content, carry
      // it through as a sibling field so the model.ts dispatch can echo it
      // back to the provider on the next request. DeepSeek explicitly
      // requires this on tool-call follow-up turns; other providers
      // ignore the field harmlessly.
      const out: { role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[]; reasoningContent?: string } = {
        role: msg.role,
        // Time-awareness: text rows carry their recorded time so the model can
        // subtract against the current-time footer (see the stamp helpers above).
        content: stampTextContent(parsed, msg.createdAt),
      };
      if (msg.role === 'assistant' && msg.reasoningContent) {
        out.reasoningContent = msg.reasoningContent;
      }
      messages.push(out as { role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] });
    }
    // Skip system messages in history
  }

  // ── Prune old image / document blocks from tool_result history ──
  // file_read on an image returns the image as a base64 content block
  // inside the tool_result. Each ~647KB PNG ≈ 250K tokens base64. After
  // 4 file_reads on slide PNGs, the fresh tail can exceed the model's
  // context window before any text is even considered (user reported
  // inputEstimate=777K with messageCount=3, caused entirely by stacked
  // image blocks). Only the MOST RECENT image is needed for vision; older
  // ones can be replaced with a text stub. The agent can re-call
  // file_read on the path if it genuinely needs to re-examine.
  // ── Integrity pass (R6), post-combine repairs, one named stage ──
  // prune old images, cap large tool results, strip leading orphans, merge
  // consecutive roles, sanitize orphaned tool blocks, strip a leading
  // tool_result, pop a trailing assistant. See applyIntegrityPass.
  let merged = applyIntegrityPass(messages, agentId);

  // Guard: if we have zero messages after all filtering, pull the last user message
  // directly from DB so the agent at least sees what it's supposed to respond to.
  //
  // CRITICAL: respect session_started_at. After a reset_session call, the
  // assembler is asked to build context for the post-reset turn. If we
  // recover a user message from BEFORE the reset boundary, the model
  // re-processes "Reset your session" (or any natural phrasing of it) and
  // calls reset_session again → loop. The earlier `NOT LIKE '%reset_session%'`
  // filter only caught the snake_case tool name; real users say "reset" or
  // "fresh start" or "wipe your context", none of which match.
  //
  // Post-reset behavior: when session_started_at is set and no user message
  // exists after that boundary, return an empty messages array. The v2 loop's
  // empty-messages guard (loop.ts:459) will exit cleanly to idle. A generic
  // "Continue with your current task" fallback would conflict with FRESH_START's
  // "wait for the user's next message" instruction and trigger the agent to
  // spam-poll the tracker looking for work.
  if (merged.length === 0) {
    try {
      const db = getDb();
      const sessionRow = db.prepare(
        'SELECT session_started_at FROM agents WHERE id = ?'
      ).get(agentId) as { session_started_at: string | null } | undefined;
      const sessionBoundary = sessionRow?.session_started_at ?? null;

      const baseConditions = [
        "agent_id = ?",
        "role = 'user'",
        "content NOT LIKE '[System:%'",
        // Belt + suspenders: still skip messages that literally name the tool.
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
        merged.push({ role: 'user', content: lastUserMsg.content });
      } else if (sessionBoundary) {
        // Fresh post-reset session with nothing to process, let the loop's
        // empty-messages guard idle the agent. No fallback message.
        logger.info('Context assembly: post-reset with no user message after boundary, returning empty for clean idle', {
          sessionBoundary,
          agentId,
        }, agentId);
      } else {
        // No session boundary set and no recoverable message, preserve
        // legacy fallback so the agent has something to respond to.
        logger.error('Context assembly produced 0 messages after filtering and no recoverable user message', {
          agentId,
        }, agentId);
        merged.push({ role: 'user', content: 'Continue with your current task.' });
      }
    } catch {
      merged.push({ role: 'user', content: 'Continue with your current task.' });
    }
  }

  // If this is a new session, inject a brief context note into the first user message
  // so the agent understands the conversation was intentionally reset.
  // This only fires once, after the agent responds, there will be assistant messages
  // in the session and this won't trigger again.
  try {
    const db = getDb();
    const sessionRow = db.prepare('SELECT session_started_at FROM agents WHERE id = ?').get(agentId) as { session_started_at: string | null } | undefined;
    if (sessionRow?.session_started_at) {
      const assistantInSession = db.prepare(
        "SELECT COUNT(*) as cnt FROM messages WHERE agent_id = ? AND role = 'assistant' AND created_at >= (unixepoch(?) * 1000)"
      ).get(agentId, sessionRow.session_started_at) as { cnt: number };
      if (assistantInSession.cnt === 0 && merged.length > 0 && merged[merged.length - 1].role === 'user') {
        const lastMsg = merged[merged.length - 1];
        if (typeof lastMsg.content === 'string') {
          lastMsg.content = `[New Session] Your previous conversation history has been archived. You still have access to your long-term memory via vault_search. You DO NOT have the detailed conversation from before, only summaries. If the user references something specific from before, use vault_search to find it.\n\n${lastMsg.content}`;
        }
      }
    }
  } catch { /* session_started_at column may not exist yet */ }

  // If the user pressed Stop since the last turn, inject a stop marker into
  // the last user message telling the model to abandon its prior plan. The
  // flag is set by stopAgent() in runtime.ts and cleared here after we've
  // applied it. The marker exists only in the model's in-memory context, 
  // it is never persisted to the messages table, so the dashboard chat feed
  // does not show it to the user.
  try {
    const db = getDb();
    const row = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
    if (row?.config) {
      const config = JSON.parse(row.config) as Record<string, unknown>;
      // ── A2A preempt marker (v2.5.38) ──
      // When another agent's wake-intent A2A delivery preempted this
      // agent's mid-flight turn, the transport set a2aPreemptPending in
      // this agent's config. Inject a context note on the next assembly
      // explaining what happened, encouraging a response, warning about
      // possible orphan tool_use, and surfacing the recent preempt
      // count so the agent can self-throttle if pinged repeatedly.
      // Prepend to the LAST user message (the inbound A2A) so the
      // model reads the framing immediately before the message itself.
      if (config.a2aPreemptPending && typeof config.a2aPreemptPending === 'object') {
        const p = config.a2aPreemptPending as {
          fromName?: string;
          intent?: string;
          threadShort?: string;
          recentCount?: number;
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
        }
        // Clear the pending flag so the marker fires exactly once.
        delete config.a2aPreemptPending;
        db.prepare("UPDATE agents SET config = ? WHERE id = ?").run(JSON.stringify(config), agentId);
      }

      if (config.stopMarkerPending === true) {
        // v2.5.35, Wording fix. Pre-fix the marker said "Read the next
        // user message as a fresh request", but the marker is PREPENDED
        // to that user message, not placed before a separate one. Models
        // (especially weaker ones) read "the next user message" as "wait
        // for the message that comes after this one to arrive" and just
        // sit idle, producing no response. Then the user re-sends the
        // same prompt, the flag has been cleared, no marker fires, and
        // the second send goes through normally, that's the "first
        // prompt after Stop gets ignored" symptom reported in v2.5.34
        // and earlier.
        const STOP_MARKER = '[Context note: the user just hit the Stop button on your previous turn. Your previous plan is CANCELLED. Do NOT continue the tool loop you were executing. Do NOT retry the last action with a different approach. Do NOT resume your prior work. The user\'s new request follows IMMEDIATELY BELOW, respond to that message as a fresh ask, not whatever you were doing before.]';
        if (merged.length > 0 && merged[merged.length - 1].role === 'user') {
          const lastMsg = merged[merged.length - 1];
          if (typeof lastMsg.content === 'string') {
            lastMsg.content = `${STOP_MARKER}\n\n${lastMsg.content}`;
          } else if (Array.isArray(lastMsg.content)) {
            // Content blocks (e.g. tool_result), prepend a text block
            lastMsg.content = [
              { type: 'text', text: STOP_MARKER } as Anthropic.TextBlockParam,
              ...(lastMsg.content as Anthropic.ContentBlockParam[]),
            ];
          }
        }
        // Clear the flag so the marker fires exactly once.
        config.stopMarkerPending = false;
        db.prepare("UPDATE agents SET config = ? WHERE id = ?").run(JSON.stringify(config), agentId);
      }
    }
  } catch { /* config may not exist or be malformed */ }

  // ── A2A reply salience (v3.1.10) ──
  // On a dedicated A2A turn the inbound A2A must be the SALIENT, actionable
  // item, exactly as it is on a natural (just-arrived / preempt) turn, where
  // the model reliably replies via send_to_agent. On a FORCED A2A turn (a
  // still-unreplied A2A that a prior user turn deferred) the A2A is buried
  // behind the already-answered user exchange, so a weak model never realizes
  // it owes a reply and writes suppressed chat text instead. Fix: move the
  // most-recent inbound A2A to the tail and prepend a reply directive, so the
  // forced turn looks like a natural one. Only runs on A2A turns; on user turns
  // the A2A was already stripped from the tail, so this is a no-op there.
  if (turnContext?.isA2ATurn && merged.length > 0) {
    // Threads this agent has ALREADY replied to (durable, survives across the
    // tool-iterations of a single turn). Once the agent replies mid-turn, the
    // a2a_replies row appears here, so we stop re-surfacing that A2A and remove
    // it, otherwise the directive would re-fire each iteration and the model
    // would send the same reply again and again.
    const repliedShorts = new Set<string>();
    try {
      const rows = getDb().prepare(
        "SELECT DISTINCT substr(thread_id,1,8) AS s FROM a2a_replies WHERE agent_id = ?",
      ).all(agentId) as Array<{ s: string }>;
      for (const r of rows) repliedShorts.add(r.s);
    } catch { /* table may not exist yet */ }
    const threadShortOf = (c: string): string | null => {
      const m = c.match(/thread:([0-9a-f]{8})/);
      return m ? m[1] : null;
    };
    const isA2AMsg = (m: { role: string; content: string | Anthropic.ContentBlockParam[] }) =>
      m.role === 'user' && typeof m.content === 'string' && A2A_INBOUND_RE.test(m.content);
    // Drop already-replied A2As so the agent doesn't re-engage them.
    merged = merged.filter((m) => {
      if (!isA2AMsg(m)) return true;
      const short = threadShortOf(m.content as string);
      return !(short && repliedShorts.has(short));
    });
    // Surface the most-recent still-unreplied A2A at the tail with a reply
    // directive, so a forced turn looks like a natural (just-arrived) one.
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
      }
    }
  }

  logger.info('Context assembled', {
    systemPromptTokens: estimateTokens(systemPrompt),
    summaryCount: summaries.length,
    freshTailCount: tailMessages.length,
    totalMessages: merged.length,
    estimatedTokens: usedTokens,
  }, agentId);

  return { systemPrompt, systemVolatile: "", messages: merged, freshTailDropped };
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

const SUMMARY_RELEVANCE_BUDGET_TOKENS = 6000;
const SUMMARY_RECENCY_FLOOR = 2;

async function selectSummariesByRelevance(
  summaries: Summary[],
  availableTokens: number,
  agentId: string,
): Promise<Summary[]> {
  const budget = Math.min(Math.floor(availableTokens * SUMMARY_SHARE), SUMMARY_RELEVANCE_BUDGET_TOKENS);

  // Continuity floor: the newest summaries are the compressed tail of the
  // live thread and always ride along.
  const floor = summaries.slice(-SUMMARY_RECENCY_FLOOR);
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
        limit: 12,
        minSimilarity: 0.3,
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

const RELEVANT_MEMORY_BUDGET_TOKENS = 1200;
const RELEVANT_MEMORY_VAULT_BUDGET_TOKENS = 2000; // D4: per-turn vault subsection
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
function buildPerTurnRecallQuery(agentId: string): string {
  let recent: ReturnType<typeof getRecentMessages> = [];
  try { recent = getRecentMessages(agentId, 10); } catch { return ''; }
  const humanUser = recent
    .filter((m) => m.role === 'user' && typeof m.content === 'string' && !isSyntheticRow(m.content))
    .map((m) => m.content as string);
  const q = humanUser.join('\n').slice(-500);
  if (q.trim().length > 10) return q;
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = recent[i]?.content;
    if (typeof c !== 'string') continue;
    const stripped = stripRecallEnvelope(c).replace(/\s+/g, ' ').trim();
    if (stripped.length > 10) return stripped.slice(-500);
  }
  return '';
}

// D4: FTS degrade for message recall when the query embedding is unavailable.
function ftsMessageHits(query: string, agentId: string, limit: number): Array<{ sourceId: string }> {
  try {
    const db = getDb();
    const safe = query.replace(/["']/g, ' ').split(/\s+/).filter((w) => w.length > 2).slice(0, 8).join(' ');
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

async function buildRelevantMemoryBlock(agentId: string, includeVault: boolean): Promise<string | null> {
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
    const tailIds = new Set(getRecentMessages(agentId, 80).map((m) => m.id));

    // --- older raw messages by meaning ---
    let msgHits: Array<{ sourceId: string }>;
    if (queryEmbedding) {
      const { vectorSearch } = await import('./vector-search.js');
      msgHits = await vectorSearch(queryText, agentId, {
        sourceType: 'message', limit: 8, minSimilarity: 0.35, queryEmbedding,
      });
    } else {
      msgHits = ftsMessageHits(queryText, agentId, 8);
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
      const snippet = row.content.replace(/\s+/g, ' ').slice(0, 300);
      const line = `- [${row.created_at}] ${row.role}: ${snippet}`;
      const lineTokens = estimateTokens(line);
      if (usedMsg + lineTokens > RELEVANT_MEMORY_BUDGET_TOKENS) break;
      msgCandidates.push({ createdAt: row.created_at, line });
      usedMsg += lineTokens;
      if (msgCandidates.length >= 5) break;
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
        vhits = await semanticSearch(queryText, { limit: 6, minSimilarity: 0.45, queryEmbedding, agentId, personalOnly: true });
      } else {
        vhits = listEntries({ search: queryText, limit: 6, agentId, includeOwnerScope: true });
      }
      let usedVault = 0;
      for (const e of vhits) {
        if (pinnedIds.has(e.id)) continue;
        const snippet = e.content.replace(/\s+/g, ' ').slice(0, 300);
        const line = `- [vault:${e.type}] ${snippet}`;
        const lineTokens = estimateTokens(line);
        if (usedVault + lineTokens > RELEVANT_MEMORY_VAULT_BUDGET_TOKENS) break;
        vaultLines.push(line);
        usedVault += lineTokens;
        if (vaultLines.length >= 5) break;
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
  const db = getDb();
  // currentTurn = highest turn_number ever persisted for this agent + 1.
  // Same logic v2/loop.ts uses to compute its own turn number.
  const row = db
    .prepare('SELECT MAX(turn_number) AS max_turn FROM messages WHERE agent_id = ?')
    .get(agentId) as { max_turn: number | null } | undefined;
  const currentTurn = (row?.max_turn ?? 0) + 1;

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
    const tokens = msg.tokenCount ?? estimateTokens(msg.content);

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
      const nextTokens = nextMsg.tokenCount ?? estimateTokens(nextMsg.content);
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

/**
 * Drop tool blocks that break the conversation invariant so the next
 * provider call does not fail with a "tool id not found" error.
 *
 * The invariant every chat API enforces:
 *   - Every `tool_use` block on an assistant message must have a matching
 *     `tool_result` block in a following user message (same id).
 *   - Every `tool_result` block on a user message must reference a
 *     `tool_use_id` that appears on a preceding assistant message.
 *
 * This function does two passes:
 *   1. Collect the set of tool_use ids that exist in assistant messages
 *      and the set of tool_result ids that exist in user messages.
 *   2. Filter each message's content blocks:
 *      - On assistant messages, drop tool_use blocks whose id has no
 *        matching tool_result anywhere in the history.
 *      - On user messages, drop tool_result blocks whose tool_use_id
 *        has no matching tool_use.
 *      - Text blocks are always kept.
 *   3. Any message that becomes empty after filtering is dropped
 *      entirely.
 *
 * The function is non-destructive, it returns a sanitized copy and
 * does not touch the messages table. The DB still holds the orphaned
 * rows so history stays intact; the invariant is only enforced on the
 * in-memory list that goes to the provider.
 */
function sanitizeToolBlocks(
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
  agentId: string,
): Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }> {
  // Build POSITIONAL pairs: a tool_use is valid only if the NEXT message
  // (which must be a user message) contains a matching tool_result, and
  // a tool_result is valid only if the PRECEDING message (which must be
  // an assistant message) contains a matching tool_use.
  const validToolUseIds = new Set<string>();
  const validToolResultIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;
    const blocks = msg.content as unknown as Array<Record<string, unknown>>;

    if (msg.role === 'assistant') {
      // Collect tool_use IDs from this assistant message
      const useIds = blocks.filter(b => b.type === 'tool_use' && typeof b.id === 'string').map(b => b.id as string);
      if (useIds.length === 0) continue;

      // Check if the NEXT message is a user message with matching tool_results
      const next = i + 1 < messages.length ? messages[i + 1] : null;
      if (next && next.role === 'user' && Array.isArray(next.content)) {
        const nextBlocks = next.content as unknown as Array<Record<string, unknown>>;
        const resultIds = new Set(nextBlocks.filter(b => b.type === 'tool_result' && typeof b.tool_use_id === 'string').map(b => b.tool_use_id as string));
        for (const uid of useIds) {
          if (resultIds.has(uid)) {
            validToolUseIds.add(uid);
            validToolResultIds.add(uid);
          }
        }
      }
    }
  }

  // Pass 2: filter blocks that don't have a matching partner
  let droppedToolUse = 0;
  let droppedToolResult = 0;
  let droppedMessages = 0;
  const sanitized: typeof messages = [];

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      sanitized.push(msg);
      continue;
    }
    const blocks = msg.content as unknown as Array<Record<string, unknown>>;

    const kept = blocks.filter(b => {
      if (msg.role === 'assistant' && b.type === 'tool_use') {
        if (typeof b.id === 'string' && validToolResultIds.has(b.id)) return true;
        droppedToolUse++;
        return false;
      }
      if (msg.role === 'user' && b.type === 'tool_result') {
        if (typeof b.tool_use_id === 'string' && validToolUseIds.has(b.tool_use_id)) return true;
        droppedToolResult++;
        return false;
      }
      return true; // text blocks and anything else pass through
    });

    if (kept.length === 0) {
      droppedMessages++;
      continue;
    }
    sanitized.push({ ...msg, content: kept as unknown as Anthropic.ContentBlockParam[] });
  }

  if (droppedToolUse > 0 || droppedToolResult > 0 || droppedMessages > 0) {
    logger.warn('Sanitized orphaned tool blocks from context', {
      droppedToolUse,
      droppedToolResult,
      droppedMessages,
      validToolUseIds: validToolUseIds.size,
      validToolResultIds: validToolResultIds.size,
    }, agentId);
  }

  return sanitized;
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
