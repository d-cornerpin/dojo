import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { withLock } from '../db/with-lock.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
// (getRuntimeVersion import removed in Phase 9 Stage 2, single-track v2)
import { getMessagesOutsideFreshTail, getRecentMessages } from './store.js';
import { estimateTokens, getFreshTailCount, contextWindowPolicy, CONTEXT_THRESHOLD, CONTEXT_WARN_THRESHOLD } from './budget.js';
import { insertMessageIfAbsent } from './message-store.js';
import {
  createLeafSummary,
  createCondensedSummary,
  getLeafSummariesNotCondensed,
  getCompactedMessageIds,
  getContextSummaries,
  replaceContextItems,
} from './dag.js';
import { generateSummary } from './summarize.js';
import { archiveMessagesBeforeCompaction, isDreamerIgnored, getArchiveHighWaterMark } from '../vault/archive.js';
import { isSystemServiceAgent } from '../config/platform.js';
import { lastCompactionDividerAt } from '../agent/shared-state.js';
import { summaryPartyTag } from './party-label.js';
import { isPlatformNoise } from './platform-noise.js';
import type { Message } from '@dojo/shared';
import { formatDivider } from '@dojo/shared';

// Inbound A2A, a peer agent's message TO this agent. For the primary's own context
// summary this is inter-agent traffic, not the user's conversation, so it is excluded
// from summary input. Must match the SAME marker set the assembler strips from a human
// turn (assembler.ts A2A_INBOUND_RE): the modern [A2A: …] envelope plus the legacy
// agent-message / group-broadcast / PM-poke source markers, otherwise a legacy variant
// would be stripped from live turns but still bleed into the persistent summary.
const A2A_INBOUND_MARKER_RE = /^\s*(\[A2A:|\[SOURCE: AGENT MESSAGE FROM|\[SOURCE: GROUP BROADCAST FROM|\[SOURCE: PM AGENT POKE FROM)/i;

/** A row that must NOT be folded into a context summary: platform/inter-agent plumbing
 *  or an inbound peer A2A message. Keeps another agent's work out of the primary's
 *  narrative so the model can't later read it back and narrate it to the user.
 *  Exported for the nightly contaminated-summary rebuild (memory/summary-rebuild.ts),
 *  which re-runs old summaries' source messages through this same filter. */
export function isNonConversationForSummary(content: string | null | undefined): boolean {
  return isPlatformNoise(content) || (!!content && A2A_INBOUND_MARKER_RE.test(content));
}

/** Placeholder stored when a summarized span contains no user conversation at all
 *  (pure system/inter-agent plumbing or tool traffic). Shared with the nightly
 *  summary rebuild so both paths write the identical minimal placeholder. */
export const NO_CONVERSATION_PLACEHOLDER = '(system/inter-agent activity, no user conversation in this span)';

// ── Assembled-context token estimate ──
//
// This is the right metric to gate compaction on: what the assembler will
// actually load into the next model call. Pre-2026-04-30 we summed every
// message ever written to the messages table this session, which never went
// down after compaction (raw messages are preserved for archive/search even
// when their content has been folded into summaries). Result: total tokens
// climbed monotonically into millions and compaction fired every turn,
// burning the model budget on summaries while the agent's effective context
// stayed pinned at the fresh-tail size.
//
// The assembler loads:
//   - summaries pinned to context_items (top-level DAG nodes)
//   - the fresh tail (last N raw messages, sized by contextWindow)
//   - the continuity brief (a short snapshot stored in agent config)
//   - vault snippets and tracker tasks (variable, bounded by their own logic)
//
// We approximate the compressible portion: summaries + fresh tail + brief.
// Vault and active tasks aren't compressible by this engine, so leaving
// them out of the gating metric is correct.
// Per-message cap for the compaction gate. A single oversized message
// (think: file_read of a code file, web_fetch of a long page, list_agents
// returning tons of metadata) used to count its full token weight here,
// so one tool-heavy turn could trigger compaction by itself even when
// the conversation was otherwise quiet. The assembler's own
// budgetFreshTail already trims what the model actually sees; the gate
// just needs to know "is the fresh tail genuinely full of conversation",
// not "did somebody dump a 30K file into a single tool result".
// STRIP (PHASE-3 T2): `MAX_GATE_MESSAGE_TOKENS` (now `policy.gateMessageCap`) and
// `TOOL_AND_OUTPUT_RESERVE`, which was ALSO a bare literal in `assembler.ts:670`.
// STRIP (PHASE-3 T4): the re-export itself. The reserve is no longer a constant anybody can
// import — it is `toolAndOutputReserve({ measured tools, model output cap })`, computed per
// agent per call. `loop.ts` used the re-exported constant to describe the overhead the
// assembler had just produced; it now reads the number the assembler ACTUALLY used, off the
// dry-run below. requirement preserved: "the loop knows how much of the window the
// assembler did not control" — owned by `estimateAssembledTokens`'s `reserveTokens`.

/** The compaction gate's view of what the assembler will produce — an ALLOCATOR DRY-RUN
 *  since PHASE-3 T2, not a second model of it. What stood here derived the assembler's
 *  ceiling from THIS module's threshold (0.96) while the assembler used 0.75.
 *
 *  ASYNC since PHASE-3 T4, and for the reason the dry-run exists: the assembler's reserve
 *  is now MEASURED from this agent's real tools payload, and a gate that modelled it with a
 *  constant while the assembler measured it would be a second model of the budget again —
 *  the exact defect T2 deleted. Measuring needs the tool hub, which is loaded dynamically
 *  to avoid a cycle, so the dry run is async. All three call sites were already inside
 *  async functions. */
export async function estimateAssembledTokens(
  agentId: string,
  contextWindow: number,
  /** The model the turn will actually call, when the caller knows it. Absent means the
   *  output cap is unknown and the reserve uses its own floor rather than inventing one. */
  modelId?: string,
): Promise<{
  total: number;
  summaryTokens: number;
  freshTailTokens: number;
  briefTokens: number;
  freshTailCount: number;
  summaryCount: number;
  /** What the assembler set aside for tool schemas + output on this agent, measured. */
  reserveTokens: number;
}> {
  const { measureAgentToolPayloadTokens } = await import('../tools/tool-docs.js');
  const { getModelOutputCap } = await import('../agent/model.js');
  const policy = contextWindowPolicy(contextWindow, {
    toolPayloadTokens: await measureAgentToolPayloadTokens(agentId),
    maxOutputTokens: modelId ? getModelOutputCap(modelId) : undefined,
  });
  const summaries = getContextSummaries(agentId);
  const rawSummaryTokens = summaries.reduce((sum, s) => sum + (s.tokenCount ?? 0), 0);

  const freshTail = getRecentMessages(agentId, policy.freshTailCount);
  const freshTailTokens = freshTail.reduce(
    (sum, m) => {
      const raw = m.tokenCount ?? estimateTokens(m.content);
      return sum + Math.min(raw, policy.gateMessageCap);
    },
    0,
  );

  let briefTokens = 0;
  try {
    const db = getDb();
    const row = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
    if (row?.config) {
      const cfg = JSON.parse(row.config) as Record<string, unknown>;
      const brief = cfg.continuityBrief as string | undefined;
      if (brief) briefTokens = estimateTokens(brief);
    }
  } catch { /* best effort */ }

  // Cap summary tokens at the same budget the assembler applies (assembler.ts:
  // budgetSummaries reserves 70% of remaining-after-scaffolding for summaries,
  // dropping oldest first to fit). Without this cap, a long-lived agent, or
  // anyone upgrading from v1 with a deep summary DAG, sees the gate trip at
  // >100% on its first turn, force-compaction can't reduce already-condensed
  // depth-N summaries any further, and the loop wedges firing the same
  // "memory is too full" message forever. The assembler will trim summaries
  // to fit; the gate must reflect that, not the unbounded raw total.
  const maxAssemblerTokens = policy.assemblyBudgetTokens;
  const summaryBudget = Math.max(0, Math.floor((maxAssemblerTokens - briefTokens - freshTailTokens) * policy.summaryShare));
  const summaryTokens = Math.min(rawSummaryTokens, summaryBudget);

  return {
    total: summaryTokens + freshTailTokens + briefTokens,
    summaryTokens,
    freshTailTokens,
    briefTokens,
    freshTailCount: freshTail.length,
    summaryCount: summaries.length,
    reserveTokens: policy.toolAndOutputReserve,
  };
}

const logger = createLogger('memory-compaction');

// ── Technique-content scrub for summarization (v2.7.6) ──
//
// Tool results from technique_read / use_technique all carry the
// freshness sentinel (techniques/tools.ts:TECHNIQUE_FRESH_SENTINEL).
// Before sending chunk text into the summarizer, replace any such
// block with a one-line stub so the technique body NEVER appears in
// the generated summary. Without this, the summary keeps a
// paraphrased copy of the technique and the agent later reads the
// summary as authoritative, defeating the v2.7.4 stub-after-1-turn
// freshness enforcement on the raw tool_result side.
const TECHNIQUE_FRESH_SENTINEL = '══ TECHNIQUE FRESH READ ══';
const TECHNIQUE_SCRUB_STUB =
  '[technique read withheld from summary by engine policy, call technique_read for the current on-disk content; do not paraphrase from this summary]';

// Same risk class, higher stakes: a credential_get result carries a raw secret
// in its body. If it ages into a compaction chunk the summarizer would otherwise
// see the value and could fold it into a persisted leaf summary, re-injected
// across sessions (a Rule-6 leak that must NOT rest on the summarizer model's
// discretion). credential_get prepends this sentinel; the summary scrub stubs it
// deterministically at the engine, exactly like a fresh technique read.
export const CREDENTIAL_FRESH_SENTINEL = '══ CREDENTIAL FRESH READ ══';
const CREDENTIAL_SCRUB_STUB =
  '[credential value withheld from summary by engine policy, call credential_get for the current value; never persist or paraphrase a secret]';

// Return the deterministic stub for a sentinel-tagged body, or null if the body
// carries no scrubbable sentinel.
function scrubStubFor(content: string): string | null {
  if (content.startsWith(TECHNIQUE_FRESH_SENTINEL)) return TECHNIQUE_SCRUB_STUB;
  if (content.startsWith(CREDENTIAL_FRESH_SENTINEL)) return CREDENTIAL_SCRUB_STUB;
  return null;
}

export function scrubTechniqueContentForSummary(messageContent: string): string {
  // Fast path: plain string content that starts with a sentinel
  // (covers any flow where the runtime persists the raw tool string
  // rather than a JSON tool_result block).
  const fast = scrubStubFor(messageContent);
  if (fast) return fast;
  // JSON path: walk tool_result blocks the way the assembler does.
  try {
    const parsed = JSON.parse(messageContent);
    if (!Array.isArray(parsed)) return messageContent;
    let changed = false;
    const next = parsed.map((block: unknown) => {
      const b = block as { type?: string; content?: unknown };
      if (b.type !== 'tool_result') return block;
      if (typeof b.content !== 'string') return block;
      const stub = scrubStubFor(b.content);
      if (!stub) return block;
      changed = true;
      return { ...b, content: stub };
    });
    return changed ? JSON.stringify(next) : messageContent;
  } catch {
    return messageContent;
  }
}

// ── Defaults ──
//
// v1: contextThreshold 0.75, fires at 75% utilization (the "compaction is
// load-bearing" architecture). v2 raises this to 0.96 emergency-only with
// a 0.90 WARN line per Part V, compaction becomes a debug signal, not a
// routine event. Threshold lookup is runtime-version-aware so v1 agents
// keep their original behavior while v2 agents see the new architecture.

const DEFAULTS = {
  // PHASE-3 T2: `contextThreshold` moved to `memory/budget.ts` as CONTEXT_THRESHOLD.
  // It was one of five declarations of the same number and the assembler's copy said 0.75
  // (§T0-C). The remaining entries here are summary SHAPES, not budget, and stay.
  leafChunkTokens: 30000,
  leafTargetTokens: 5000,
  condensedTargetTokens: 6000,
  condensedMinFanout: 4,
  incrementalMaxDepth: 1,
};

/** Summary size targets, exposed for the nightly summary rebuild so regenerated
 *  summaries match the sizes the live compaction path produces. */
export const SUMMARY_TARGET_TOKENS = {
  leaf: DEFAULTS.leafTargetTokens,
  condensed: DEFAULTS.condensedTargetTokens,
} as const;

function getContextThreshold(): number {
  return CONTEXT_THRESHOLD;
}

function getLeafChunkTokens(): number {
  return DEFAULTS.leafChunkTokens;
}

// Model-aware tail count for compaction boundary: getFreshTailCount, imported
// from store.js (FA-M3, single source of truth shared with the assembler).

// v2.5.11, Gap-trigger threshold (mirrors UNCOMPACTED_GAP_THRESHOLD inside
// checkAndCompact). Exported via getUncompactedGapCount for the v2 loop's
// pre-call routine check.
export const UNCOMPACTED_GAP_THRESHOLD = 30;

/**
 * Cheap, sync read of how many messages have fallen outside the fresh tail
 * without yet being summarized. Used by the v2 loop to decide whether to
 * call checkAndCompact at the routine pre-call gate (in addition to the
 * existing token-utilization-based emergency gate).
 *
 * Two SQLite reads, one for "messages outside fresh tail", one for the
 * set of summarized message IDs, and a Set lookup. Negligible per-turn cost.
 */
export function getUncompactedGapCount(agentId: string, contextWindow: number): number {
  const outside = getMessagesOutsideFreshTail(agentId, getFreshTailCount(contextWindow));
  const compactedIds = getCompactedMessageIds(agentId);
  return outside.filter(m => !compactedIds.has(m.id)).length;
}

// ── Chat divider helpers ──
//
// After compaction, we drop a "── Memory Compacted ──" system message
// into the agent's chat so the user sees a horizontal divider in the
// timeline. Mirrors the existing "── New Session ──" pattern. The
// dashboard renders any system message shaped "── label ──" as a
// divider with the label centered.

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K tokens`;
  return `${n} tokens`;
}

// v2.5.11, After the divider, drop a separate, agent-facing system message
// that nudges the agent toward recall_recent_thread if it needs detail from
// the summarized portion. Sits in the messages table so it lands in the
// v2.7.10, insertRecallNudge / RECALL_NUDGE_TEXT removed.
//
// The nudge text told the agent to call recall_recent_thread before
// responding. Paired with the v2/loop.ts hard intercept (also removed)
// that AUTO-RAN that recall and pasted ~15K chars of prior thread
// content back into the message log as a system message. Real
// production failure: scheduled-task agent processing 17 emails in
// sequence hit compaction → nudge inserted → auto-recall re-injected
// 8 turns of fresh-tail content as a new system message → next turn's
// fresh tail was bigger → compaction triggered again → another
// re-injection → context spiraled. Agent started sending emails twice
// and marking unsent emails complete because the re-injected log made
// past work look pending.
//
// Recovery: recall_recent_thread is back to being a TOOL the agent
// calls on demand. The "── Memory Compacted ──" divider still appears
// (insertCompactionDivider, throttled to once per 10 min) so the
// agent sees compaction happened, but nothing else is auto-injected
// into the message log.

/** Min interval between compaction dividers shown to the user, per agent. */
const COMPACTION_DIVIDER_THROTTLE_MS = 10 * 60 * 1000;

/**
 * True when enough time has elapsed since the last divider broadcast for
 * this agent to show another one. Avoids spamming the chat during a backlog
 * drain that runs across many turns, while still surfacing compactions
 * during a normal long task at most once per 10 minutes.
 */
function shouldShowCompactionDivider(agentId: string): boolean {
  const last = lastCompactionDividerAt.get(agentId) ?? 0;
  return Date.now() - last >= COMPACTION_DIVIDER_THROTTLE_MS;
}

function insertCompactionDivider(agentId: string, opts: { label: string }): void {
  try {
    const id = uuidv4();
    const content = formatDivider(opts.label);
    const createdAt = new Date().toISOString();
    insertMessageIfAbsent({ id, agentId, role: 'system', content });
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id,
        agentId,
        role: 'system' as const,
        content,
        tokenCount: null,
        modelId: null,
        cost: null,
        latencyMs: null,
        createdAt,
      },
    });
    lastCompactionDividerAt.set(agentId, Date.now());
  } catch (err) {
    logger.warn('Failed to insert compaction divider', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Wrap a compaction work call so the dashboard's ActiveJobsIndicator shows a
// "Compacting memory" row while it runs. Engine-managed (no Stop button): the
// panel adds the row on the 'start' broadcast and removes it on 'end'. Robust
// across the work's early returns/throws via try/finally.
async function withCompactionActivity<T>(agentId: string, work: () => Promise<T>): Promise<T> {
  const id = `compaction_${agentId}_${Date.now()}`;
  const startedAt = new Date().toISOString();
  const emit = (phase: 'start' | 'end'): void =>
    broadcast({ type: 'engine:activity', data: { id, kind: 'compaction', agentId, label: 'Compacting memory', startedAt, phase } });
  emit('start');
  try {
    return await work();
  } finally {
    emit('end');
  }
}

// ── Summary-writer model resolution ──
//
// Resolve which model WRITES summaries. It must be able to produce text:
// media-generation (image/video/music) and embedding models all cost 0, so a
// naive "cheapest enabled model" picked one of them and every summarization
// call failed, the gap trigger then re-fires every turn forever (summaries
// never get written). Precedence:
//   1) the explicit Settings → compaction model, if enabled + text-capable
//   2) the caller's preferred model (the agent's own), if it's text-capable
//   3) the cheapest enabled text-capable model (the floor), deterministic tiebreak
// Shared by checkAndCompact and the nightly summary rebuild so both write
// summaries with the same (cheap) model choice. Returns null when no
// text-capable model exists at all.
export function resolveSummaryWriterModel(agentId: string, preferredModelId?: string): string | null {
  const db = getDb();
  const TEXT_FILTER = "m.capabilities NOT LIKE '%generation%' AND m.capabilities NOT LIKE '%embedding%'";
  const isUsableTextModel = (id: string): boolean => !!db
    .prepare(`SELECT 1 FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ? AND m.is_enabled = 1 AND p.id != '__system__' AND ${TEXT_FILTER}`)
    .get(id);
  const cheapestTextModel = (): string | undefined => (db
    .prepare(`SELECT m.id FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.is_enabled = 1 AND p.id != '__system__' AND ${TEXT_FILTER} ORDER BY COALESCE(m.input_cost_per_m, 0) ASC, m.id ASC LIMIT 1`)
    .get() as { id: string } | undefined)?.id;

  const explicit = (db.prepare("SELECT value FROM config WHERE key = 'compaction_model_id'").get() as { value: string } | undefined)?.value;

  if (explicit && isUsableTextModel(explicit)) {
    logger.info('Resolved summary-writer model (explicit setting)', { resolvedModelId: explicit }, agentId);
    return explicit;
  }
  if (!preferredModelId || preferredModelId === 'auto' || preferredModelId === '__auto__' || !isUsableTextModel(preferredModelId)) {
    const cheapest = cheapestTextModel();
    if (!cheapest) return null;
    logger.info('Resolved summary-writer model (cheapest text-capable)', { resolvedModelId: cheapest }, agentId);
    return cheapest;
  }
  // The caller's preferred model is text-capable, keep it.
  return preferredModelId;
}

// ── Main Entry Point ──

// Minimum-yield floor + backoff for reactive compaction (2026-07-23).
const MIN_COMPACTABLE_ROWS = 6;
const LOW_YIELD_BACKOFF_MS = 15 * 60_000;
const lowYieldCompactionBackoffUntil = new Map<string, number>();

export interface CheckAndCompactOptions {
  force?: boolean;
  // v2.5.12, Per-call cap on how many leaf chunks may be summarized.
  // Used by the routine gap-trigger path so a huge backlog (e.g. an
  // upgrade from a pre-gap-trigger version with thousands of uncompacted
  // messages) drains across many turns instead of blocking a single turn
  // for minutes while it does dozens of LLM calls back-to-back.
  maxChunksPerRun?: number;
  // v2.5.12, Skip the expensive continuity-brief LLM call AND the
  // user-facing divider/nudge insert. Used by routine drain so we don't
  // pay the brief cost on every chunk and don't spam the chat with
  // "Memory Compacted" notifications while we drain a backlog.
  skipContinuityBrief?: boolean;
  // v2.5.14, Optional abort signal for cancellation. Used by the
  // routine background drain in v2 loop so a hung summarizer LLM call
  // can actually be cancelled instead of running until the SDK's
  // 10-minute default timeout fires.
  abortSignal?: AbortSignal;
}

export type CompactionResult = { leafCreated: number; condensedCreated: number; tokensReclaimed: number };

const NO_COMPACTION: CompactionResult = { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };

/**
 * PHASE-1 T2: the ONE site that covers all seven compaction entry points (the
 * v2 loop's four, recovery, the memory route, and the routine background
 * drain). Every one of them arrives here, so the mutual exclusion belongs here
 * and nowhere else.
 *
 * Requirement preserved: a second compaction for the SAME agent can no longer
 * overlap the first. Both used to read the uncompacted set before either wrote
 * a summary, so both summarised the same messages and both wrote depth-0 rows
 * over them — 11.4% of depth-0 summaries were duplicates in real data (44/387,
 * research 22). The race last fired 2026-06-26; the corruption class is real
 * and the platform had no mutual-exclusion primitive to stop it.
 *
 * `ifBusy:'skip'` and not `'wait'`, deliberately: a queued second compaction
 * would run against a history the first one just compacted and find nothing to
 * do, after holding the caller's turn open for a full summarizer round-trip.
 * Skipping returns the same zero result those callers already handle — every
 * caller reads the counts and none treats zero as an error — and the work is
 * not lost: the next turn's gate re-checks and compacts if pressure remains.
 *
 * Scope: `withLock` is IN-PROCESS. One dojo server owns its box, which is the
 * shape of the observed race; it is not a cross-process lock and must not be
 * described as one.
 */
export async function checkAndCompact(
  agentId: string,
  modelId: string,
  contextWindow: number,
  options?: CheckAndCompactOptions,
): Promise<CompactionResult> {
  const result = await withLock(
    `compact:${agentId}`,
    () => runCheckAndCompact(agentId, modelId, contextWindow, options),
    { ifBusy: 'skip' },
  );
  if (result === undefined) {
    logger.info('Compaction skipped: another compaction is already running for this agent', {}, agentId);
    return NO_COMPACTION;
  }
  return result;
}

async function runCheckAndCompact(
  agentId: string,
  modelId: string,
  contextWindow: number,
  options?: CheckAndCompactOptions,
): Promise<CompactionResult> {
  // Resolve which model WRITES the summaries (see resolveSummaryWriterModel).
  {
    const resolved = resolveSummaryWriterModel(agentId, modelId);
    if (!resolved) {
      logger.warn('No text-capable model available for compaction, skipping', {}, agentId);
      return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
    }
    modelId = resolved;
  }

  const assembled = await estimateAssembledTokens(agentId, contextWindow, modelId);
  const totalTokens = assembled.total;
  const activeThreshold = getContextThreshold();
  const threshold = activeThreshold * contextWindow;

  const force = options?.force ?? false;

  // v2.5.11, Second trigger: message-count gap. The original token-pressure
  // trigger never fires for long-running agents whose context utilization
  // stays low (fresh tail is bounded by count, so total tokens don't grow
  // unboundedly). Symptom: agents silently lose memory of earlier-today
  // activity because messages fall outside the fresh tail without ever being
  // summarized.
  //
  // This fix: also fire compaction when the count of messages outside the
  // fresh tail that haven't yet been summarized crosses a threshold. That
  // way, summaries always cover any message that's about to fall out of
  // the fresh tail window.
  const messagesOutsideForGap = getMessagesOutsideFreshTail(agentId, getFreshTailCount(contextWindow));
  const compactedIdsForGap = getCompactedMessageIds(agentId);
  const uncompactedGapCount = messagesOutsideForGap.filter(m => !compactedIdsForGap.has(m.id)).length;
  // FA-M3: use the single exported UNCOMPACTED_GAP_THRESHOLD (above); the local
  // shadow that used to sit here could drift from the exported value the v2 loop
  // reads via getUncompactedGapCount.
  const needsCompactionByGap = uncompactedGapCount > UNCOMPACTED_GAP_THRESHOLD;
  const needsCompactionByTokens = totalTokens > threshold;

  logger.info(`Compaction check: assembled=${totalTokens} (summaries=${assembled.summaryTokens}, freshTail=${assembled.freshTailTokens}, brief=${assembled.briefTokens}), threshold=${Math.round(threshold)} (${Math.round(activeThreshold * 100)}% of ${contextWindow}), uncompactedGap=${uncompactedGapCount}${force ? ' [FORCED]' : ''}`, {
    assembledTokens: totalTokens,
    summaryTokens: assembled.summaryTokens,
    freshTailTokens: assembled.freshTailTokens,
    briefTokens: assembled.briefTokens,
    freshTailCount: assembled.freshTailCount,
    summaryCount: assembled.summaryCount,
    threshold: Math.round(threshold),
    contextWindow,
    uncompactedGapCount,
    gapThreshold: UNCOMPACTED_GAP_THRESHOLD,
    needsCompactionByTokens,
    needsCompactionByGap,
    force,
  }, agentId);

  // 90% WARN line (Part V), if under threshold but past 90%, log loudly +
  // broadcast a chat:error severity=warning. Each WARN is an architecture
  // bug to fix in tools/scaffolding/prompts. Fires once per checkAndCompact
  // invocation, not per loop iteration.
  if (!force) {
    const warnRatio = totalTokens / contextWindow;
    if (warnRatio >= CONTEXT_WARN_THRESHOLD && warnRatio < CONTEXT_THRESHOLD) {
      const reason = `Context utilization at ${(warnRatio * 100).toFixed(1)}% (${totalTokens}/${contextWindow}). This should not happen in normal v2 operation, investigate tool result sizes, scaffolding injection, system prompt cost.`;
      logger.warn(reason, { agentId, ratio: warnRatio }, agentId);
      // User-facing toast: plain language, no internal jargon. The technical
      // detail goes to the log where developers can see it.
      const userMsg = `Agent's memory is getting full (${(warnRatio * 100).toFixed(0)}%). Working normally for now.`;
      try {
        broadcast({
          type: 'chat:error',
          agentId,
          error: userMsg,
          code: 'CONTEXT_HIGH',
          severity: 'warning',
          retryable: false,
        });
      } catch { /* best effort */ }
    }
  }

  if (force || needsCompactionByTokens || needsCompactionByGap) {
    // No-op guard: if the gate metric is over threshold but there's
    // nothing outside the fresh tail to compact, the bloat IS the fresh
    // tail and compaction can't help. Pre-2026-05-01 we still ran the
    // whole reactive path (continuity brief LLM call, condensation,
    // rebuild, divider broadcast) even when leafCreated would be 0, 
    // and the next turn's gate check tripped again, looping. Now we
    // detect the no-op case and log out cleanly.
    // v2.5.11: reuse the gap calc we already did above instead of
    // re-querying.
    const guardUncompactedCount = uncompactedGapCount;
    // Minimum-yield floor (owner report 2026-07-23: "compaction SO much,
    // saving like 16 tokens"). A handful of rows outside the tail passes the
    // zero-guard below, runs the FULL reactive cycle (continuity-brief LLM
    // call, condensation, rebuild, divider), reclaims peanuts, and the
    // still-crossed threshold refires next turn: a compaction treadmill. A
    // tiny outside-tail region cannot reclaim meaningfully; skip it, and
    // after any low-yield run back off for a while. Emergency (force) always
    // bypasses, pressure at 96%+ must act regardless of yield.
    if (!force && (lowYieldCompactionBackoffUntil.get(agentId) ?? 0) > Date.now()) {
      logger.info('Compaction skipped: low-yield backoff active (last reactive run reclaimed almost nothing)', {
        assembledTokens: totalTokens, threshold,
      }, agentId);
      return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
    }
    if (!force && guardUncompactedCount > 0 && guardUncompactedCount < MIN_COMPACTABLE_ROWS) {
      logger.info('Compaction skipped: outside-tail region too small to reclaim meaningfully', {
        assembledTokens: totalTokens, threshold, uncompactedOutsideTail: guardUncompactedCount,
      }, agentId);
      lowYieldCompactionBackoffUntil.set(agentId, Date.now() + LOW_YIELD_BACKOFF_MS);
      return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
    }
    if (!force && guardUncompactedCount === 0) {
      logger.warn('Compaction gate exceeded but nothing outside fresh tail to compact, skipping (bloat is in fresh tail itself)', {
        assembledTokens: totalTokens,
        threshold,
        freshTailCount: assembled.freshTailCount,
        freshTailTokens: assembled.freshTailTokens,
      }, agentId);
      return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
    }

    // Full reactive compaction
    logger.info('Running full reactive compaction', {
      assembledTokens: totalTokens,
      threshold,
      uncompactedOutsideTail: guardUncompactedCount,
    }, agentId);

    // ── Pre-compaction continuity brief ──
    // BEFORE compaction destroys raw messages, generate a concise summary
    // of the FULL current context so the agent knows what it was working
    // on. The brief is the difference between "post-compaction the agent
    // is reoriented" and "post-compaction the agent is dazed."
    //
    // Pre-2026-05-06 this only ran on emergency compactions. The reasoning
    // was that proactive compaction shouldn't happen in v2, so generating
    // a brief was treated as a self-inflicted wound. In practice: when
    // compaction DOES run for any reason (force, threshold, recovery
    // cascade), the agent loses raw thread tail. The brief is cheap (one
    // summarizer call) and the failure mode without it ("forgot what we
    // were doing") is severe. Always run it, UNLESS this is a routine
    // gap drain (skipContinuityBrief), in which case the agent is not
    // losing context this turn (fresh tail unchanged) and the brief is
    // pure overhead.
    if (!options?.skipContinuityBrief) {
      await generateContinuityBrief(agentId, modelId, contextWindow);
    }

    // Archive raw messages to vault BEFORE compaction destroys them.
    // If archival fails, ABORT compaction, better to have a bloated context than lost data.
    // Exception: if the agent is on the Dreamer ignore list, the archive is
    // intentionally skipped (returns null). Don't abort compaction in that case.
    const messagesForArchive = getMessagesOutsideFreshTail(agentId, getFreshTailCount(contextWindow));
    const archiveCompactedIds = getCompactedMessageIds(agentId);
    // D1: never re-archive messages already copied to the vault. A reset archives
    // messages without marking them compacted, so without the high-water bound a
    // later compaction would re-copy them (reintroducing the duplicate-blob bloat).
    // This bounds only the ARCHIVE input; compaction itself is unaffected.
    // Migration 088: bound by rowid (tie-free) instead of the old second-granular
    // created_at, which dropped an equal-second boundary row from the archive
    // while it was still compacted (silent loss). A missing rowid falls to
    // "include" so the safe direction is always to archive, never to skip.
    const archiveHighWater = getArchiveHighWaterMark(agentId);
    const uncompactedForArchive = messagesForArchive.filter(
      m => !archiveCompactedIds.has(m.id) && (archiveHighWater == null || m.rowid == null || m.rowid > archiveHighWater),
    );
    // C11: service agents (Healer/Trainer/PM/Imaginer/Dreamer) are excluded from archival, 
    // archiveMessagesBeforeCompaction returns null for them (its own service-agent skip),
    // and this guard previously misread that null as "archive FAILED → abort compaction",
    // so the healer never compacted, grew unbounded, and retried every few seconds. Their
    // histories are pure plumbing (never memory-worthy), so skipping the archive step is
    // correct; compaction then proceeds normally.
    if (uncompactedForArchive.length > 0 && !isDreamerIgnored(agentId) && !isSystemServiceAgent(agentId)) {
      const archiveId = archiveMessagesBeforeCompaction(agentId, uncompactedForArchive);
      if (!archiveId) {
        logger.error('Archive failed, aborting compaction to prevent data loss', { agentId, messageCount: uncompactedForArchive.length }, agentId);
        return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
      }
    }

    const tokensBefore = totalTokens;
    const leafCreated = await withCompactionActivity(agentId, () => runLeafCompaction(agentId, modelId, contextWindow, {
      maxChunks: options?.maxChunksPerRun,
      abortSignal: options?.abortSignal,
    }));
    // v2.5.12, Skip condensation on routine drain too. Condensation walks
    // the depth tree and can do multiple LLM calls; backlog drains will
    // accumulate enough leaf summaries that condensation runs naturally on
    // the next forced/emergency compaction.
    const condensedCreated = options?.skipContinuityBrief
      ? 0
      : await runCondensation(agentId, modelId, DEFAULTS.incrementalMaxDepth);
    rebuildContextItems(agentId);

    const tokensAfter = (await estimateAssembledTokens(agentId, contextWindow, modelId)).total;
    const tokensReclaimed = tokensBefore - tokensAfter;

    const result = { leafCreated, condensedCreated, tokensReclaimed: Math.max(tokensReclaimed, 0) };

    broadcast({
      type: 'memory:compaction',
      agentId,
      ...result,
    });

    // Insert a chat divider only when something *actually* changed.
    // A reactive compaction that created no summaries and reclaimed no
    // meaningful tokens is just noise in the timeline (and was a symptom
    // of the pre-v1.15.108 runaway-loop bug). The no-op guard above
    // should catch most of those, but also gate the divider as
    // belt-and-braces.
    // v2.5.29, Show the divider on routine drains too, throttled to once
    // per 10 min per agent. Pre-v2.5.29 routine drains suppressed it
    // entirely (because backlog upgrades would emit one per turn); the
    // side effect was zero compaction visibility on normal long tasks,
    // which is exactly the path that hits compaction most often. The
    // throttle covers both: backlog stays quiet across rapid drains,
    // normal flow gets a marker the user can actually see.
    if (
      (result.leafCreated > 0 || result.condensedCreated > 0 || result.tokensReclaimed > 1000) &&
      shouldShowCompactionDivider(agentId)
    ) {
      insertCompactionDivider(agentId, {
        label: `Memory Compacted${result.tokensReclaimed > 0 ? `, reclaimed ~${formatTokens(result.tokensReclaimed)}` : ''}${result.leafCreated > 0 ? ` (${result.leafCreated} new summar${result.leafCreated === 1 ? 'y' : 'ies'})` : ''}`,
      });
    }

    if (result.tokensReclaimed < 2000 && result.leafCreated <= 1) {
      // The run happened and bought almost nothing; the threshold will still
      // be crossed next turn. Back off instead of treadmilling.
      lowYieldCompactionBackoffUntil.set(agentId, Date.now() + LOW_YIELD_BACKOFF_MS);
    }
    logger.info('Compaction complete', result, agentId);
    return result;
  }

  // Check for proactive leaf compaction
  const messagesOutside = getMessagesOutsideFreshTail(agentId, getFreshTailCount(contextWindow));
  const compactedIds = getCompactedMessageIds(agentId);
  const uncompactedMessages = messagesOutside.filter(m => !compactedIds.has(m.id));
  const uncompactedTokens = uncompactedMessages.reduce(
    (sum, m) => sum + (m.tokenCount ?? estimateTokens(m.content)),
    0,
  );

  const proactiveLeafTokens = getLeafChunkTokens();
  if (uncompactedTokens > proactiveLeafTokens) {
    logger.info('Running proactive leaf compaction', {
      uncompactedTokens,
      threshold: proactiveLeafTokens,
    }, agentId);

    // Archive raw messages to vault BEFORE proactive compaction.
    // If archival fails, ABORT, don't compact without preserving the data.
    // Exception: dreamer-ignored agents intentionally skip archive.
    // C11: same service-agent exclusion as the leaf-compaction archive guard above, 
    // archive returns null for service agents; without this the null is misread as
    // "archive failed → abort" and the healer's proactive compaction never runs.
    // D1: archive only the not-yet-vaulted subset (bounded by the high-water
    // mark); the compaction trigger above still uses the full uncompacted set,
    // so context pressure is unchanged. A proactive compaction whose uncompacted
    // messages are all already archived simply skips the archive step (which is
    // correct, not a failure) and compacts normally.
    // Migration 088: rowid high-water (tie-free); missing rowid → include (archive).
    const proactiveHighWater = getArchiveHighWaterMark(agentId);
    const messagesToArchive = uncompactedMessages.filter(
      m => proactiveHighWater == null || m.rowid == null || m.rowid > proactiveHighWater,
    );
    if (messagesToArchive.length > 0 && !isDreamerIgnored(agentId) && !isSystemServiceAgent(agentId)) {
      const archiveId = archiveMessagesBeforeCompaction(agentId, messagesToArchive);
      if (!archiveId) {
        logger.error('Archive failed, aborting proactive compaction to prevent data loss', { agentId, messageCount: messagesToArchive.length }, agentId);
        return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
      }
    }

    const leafCreated = await withCompactionActivity(agentId, () => runLeafCompaction(agentId, modelId, contextWindow));
    rebuildContextItems(agentId);

    const result = { leafCreated, condensedCreated: 0, tokensReclaimed: 0 };

    broadcast({
      type: 'memory:compaction',
      agentId,
      ...result,
    });

    // Lighter divider for proactive compaction (no token threshold hit;
    // we just folded some old leaves so they wouldn't accumulate). Same
    // 10-min throttle as the reactive path.
    if (leafCreated > 0 && shouldShowCompactionDivider(agentId)) {
      insertCompactionDivider(agentId, {
        label: `Memory Compacted (proactive, ${leafCreated} summar${leafCreated === 1 ? 'y' : 'ies'})`,
      });
    }

    logger.info('Proactive compaction complete', result, agentId);
    return result;
  }

  return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
}

// ── Leaf Compaction ──

export async function runLeafCompaction(
  agentId: string,
  modelId: string,
  contextWindow?: number,
  opts?: { maxChunks?: number; abortSignal?: AbortSignal },
): Promise<number> {
  const cw = contextWindow ?? 200000;
  const messagesOutside = getMessagesOutsideFreshTail(agentId, getFreshTailCount(cw));
  const compactedIds = getCompactedMessageIds(agentId);

  // Filter to only uncompacted messages (chronological, oldest first, that's
  // what getMessagesOutsideFreshTail returns).
  const uncompacted = messagesOutside.filter(m => !compactedIds.has(m.id));

  if (uncompacted.length === 0) {
    logger.debug('No messages to compact', {}, agentId);
    return 0;
  }

  // Group into chunks of ~leafChunkTokens. Chunks come out in chronological
  // order (oldest first), which matters for maxChunks: when capped, we drain
  // the OLDEST gap first so newer messages stay raw in fresh tail longer.
  const allChunks = chunkMessages(uncompacted, getLeafChunkTokens());
  const chunks = opts?.maxChunks ? allChunks.slice(0, opts.maxChunks) : allChunks;

  logger.info('Leaf compaction: processing chunks', {
    totalMessages: uncompacted.length,
    chunkCount: chunks.length,
    chunksAvailable: allChunks.length,
    capped: opts?.maxChunks ? true : false,
  }, agentId);

  let summariesCreated = 0;

  for (const chunk of chunks) {
    if (chunk.length === 0) continue;

    // Build content from chunk messages. scrubTechniqueContentForSummary
    // strips technique tool-result bodies so they don't leak into the
    // summary the model writes next (and which the agent would later
    // read as authoritative, bypassing freshness enforcement).
    // condenseToolJsonForSummary then flattens remaining tool_use/tool_result
    // JSON to one-liners: fed verbatim, the summarizer quotes raw JSON into
    // summaries (observed live), wasting tokens on wire format while keeping
    // none of the meaning beyond tool name + outcome, which the one-liner keeps.
    const content = chunk
      // Drop inter-agent/lifecycle plumbing (sub-agent completions, PM/scheduler/
      // healer pokes, inbound A2A, session dividers, synthetic acks) from the summary
      // input. Without this the summarizer folded another agent's completion dump into
      // the primary's context summary, and the model then narrated that work back to
      // the user (the repeated "Dreamer batch" summaries). The vault already strips these;
      // this makes live compaction agree.
      .filter(m => !isNonConversationForSummary(m.content))
      .map(m => {
        const role = m.role.toUpperCase();
        // Tag each message with its conversation party so the summarizer can carry
        // attribution into every fact (see summaryPartyTag above).
        const party = summaryPartyTag(m);
        const tag = party ? `${role} · ${party}` : role;
        return `[${tag}] ${condenseToolJsonForSummary(scrubTechniqueContentForSummary(m.content))}`;
      }).join('\n\n---\n\n');

    const messageIds = chunk.map(m => m.id);
    const earliestAt = chunk[0].createdAt;
    const latestAt = chunk[chunk.length - 1].createdAt;

    try {
      // Bail out fast if a caller-supplied abort signal has already fired
      // (e.g. background-drain wall-clock timeout). Prevents starting a
      // brand-new chunk's LLM call after the caller has given up.
      if (opts?.abortSignal?.aborted) {
        logger.info('Leaf compaction aborted before chunk started', {
          messageCount: chunk.length, summariesCreated,
        }, agentId);
        break;
      }
      // A chunk that was ENTIRELY inter-agent/lifecycle plumbing has no
      // conversation to summarize. Skip the LLM round-trip and record a minimal
      // placeholder so the rows are still marked compacted + removed from the live
      // tail (bookkeeping intact) without inventing narrative from plumbing.
      if (content.trim().length === 0) {
        createLeafSummary(
          agentId,
          NO_CONVERSATION_PLACEHOLDER,
          estimateTokens(NO_CONVERSATION_PLACEHOLDER),
          messageIds,
          earliestAt,
          latestAt,
        );
        summariesCreated++;
        continue;
      }

      const summary = await generateSummary({
        content,
        depth: 0,
        targetTokens: DEFAULTS.leafTargetTokens,
        agentId,
        modelId,
        abortSignal: opts?.abortSignal,
      });

      // PHASE-2 T7: the fenced-section ingest is GONE. Compaction used to run the summarizer's
      // output through a parser that upserted rows into the prose-parsed obligation store and
      // then stripped the section back out of the text it had just been handed — a summariser
      // writing the obligation ledger. Obligations are `work` rows created when the obligation
      // is made (4a), so a summary is a summary again: stored exactly as it was generated.
      // (The table name is deliberately not written here: T10's grep-zero list carries the
      // token, and a comment is not worth a false hit on it.)

      createLeafSummary(
        agentId,
        summary.text,
        summary.tokenCount,
        messageIds,
        earliestAt,
        latestAt,
      );

      summariesCreated++;
    } catch (err) {
      logger.error('Failed to create leaf summary for chunk', {
        messageCount: chunk.length,
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }

  return summariesCreated;
}

// ── Condensation ──

export async function runCondensation(
  agentId: string,
  modelId: string,
  maxDepth: number,
): Promise<number> {
  let totalCondensed = 0;

  for (let depth = 0; depth <= maxDepth; depth++) {
    const uncondensed = getLeafSummariesNotCondensed(agentId, depth);

    if (uncondensed.length < DEFAULTS.condensedMinFanout) {
      logger.debug('Not enough uncondensed summaries at depth', {
        depth,
        count: uncondensed.length,
        minFanout: DEFAULTS.condensedMinFanout,
      }, agentId);
      continue;
    }

    // Group uncondensed summaries into batches of condensedMinFanout
    const batches = chunkArray(uncondensed, DEFAULTS.condensedMinFanout);

    for (const batch of batches) {
      if (batch.length < DEFAULTS.condensedMinFanout) continue;

      const content = batch.map(s => {
        return `<summary id="${s.id}" depth="${s.depth}" earliest="${s.earliestAt}" latest="${s.latestAt}">\n${s.content}\n</summary>`;
      }).join('\n\n');

      const parentIds = batch.map(s => s.id);
      const earliestAt = batch[0].earliestAt;
      const latestAt = batch[batch.length - 1].latestAt;
      const newDepth = depth + 1;

      try {
        const summary = await generateSummary({
          content,
          depth: newDepth,
          targetTokens: DEFAULTS.condensedTargetTokens,
          agentId,
          modelId,
        });

        createCondensedSummary(
          agentId,
          summary.text,
          summary.tokenCount,
          parentIds,
          newDepth,
          earliestAt,
          latestAt,
        );

        totalCondensed++;
      } catch (err) {
        logger.error('Failed to create condensed summary', {
          depth: newDepth,
          parentCount: batch.length,
          error: err instanceof Error ? err.message : String(err),
        }, agentId);
      }
    }
  }

  return totalCondensed;
}

// ── Rebuild Context Items ──

export function rebuildContextItems(agentId: string): void {
  // Get all summaries that are NOT parents in summary_parents
  // i.e., the "leaf nodes" of the DAG (top of the tree, highest depth)
  const db = getDb();

  // Look up agent's model context window for tail sizing
  const agentModel = db.prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;
  let contextWindow = 200000; // default
  if (agentModel?.model_id) {
    const model = db.prepare('SELECT context_window FROM models WHERE id = ?').get(agentModel.model_id) as { context_window: number | null } | undefined;
    if (model?.context_window) contextWindow = model.context_window;
  }

  interface TopLevelRow {
    id: string;
    earliest_at: string;
  }

  const topLevel = db.prepare(`
    SELECT s.id, s.earliest_at FROM summaries s
    WHERE s.agent_id = ?
      AND s.id NOT IN (
        SELECT parent_id FROM summary_parents
      )
    ORDER BY s.earliest_at ASC, s.id ASC
  `).all(agentId) as TopLevelRow[];

  // Fresh tail messages
  const freshTail = getRecentMessages(agentId, getFreshTailCount(contextWindow));

  // Build context items: summaries first, then fresh tail messages
  const items: Array<{ itemType: 'message' | 'summary'; itemId: string }> = [];

  for (const summary of topLevel) {
    items.push({ itemType: 'summary', itemId: summary.id });
  }

  for (const msg of freshTail) {
    items.push({ itemType: 'message', itemId: msg.id });
  }

  replaceContextItems(agentId, items);

  logger.info('Rebuilt context items', {
    summaryCount: topLevel.length,
    freshTailCount: freshTail.length,
  }, agentId);
}

// ── Pre-Compaction Continuity Brief ──
// Generates a concise summary of the agent's full current context BEFORE
// compaction destroys the raw messages. This summary is stored as a
// special "continuity" summary and injected first in context assembly,
// so the agent always knows what it was doing after compaction.

const CONTINUITY_BRIEF_PROMPT = `You are generating a CONTINUITY BRIEF for an AI agent whose conversation history is about to be compressed. After compaction the agent will only see this brief + compressed summaries, not the raw messages. If you are vague, the agent loses its mind on the next turn. Specificity is everything.

Length: aim for 1500–3000 words. This is the single most important context the agent will see; do NOT under-write it.

Required sections (use these headings literally, in this order):

## What the user has told the agent
Quote the user's last 3–5 direct instructions or messages **verbatim** if they are short, or paraphrase tightly with quotes around the load-bearing phrases. The user's exact words matter more than your interpretation. Include any "remember to…", "always…", "never…", "from now on…" instructions verbatim.

## Current project / task
What is the agent actually working on right now? Be concrete: specific project name, what stage, what they're trying to achieve. Reject "working on a project", that's useless. "Fixing the drop-shadow rendering on Layout 7 of the Verve Health deck so it matches Figma reference (file: /Users/.../decks/verve.pptx, slide ID: g3a8f2)" is useful.

## What was happening RIGHT BEFORE compaction
Last 1–3 turns: what tool calls just ran, what they returned, what the agent was about to do next. The agent has to continue exactly from here.

## Specific details to preserve
File paths, URLs, task IDs, agent IDs, deck IDs, technique names, drive file IDs, model names, error messages, decision rationale, anything an agent picking this up tomorrow couldn't rederive in five seconds. Bullet list of facts. Be exhaustive.

## Active threads / tasks
Tracker tasks the agent is owning, A2A threads the agent is in the middle of (with thread IDs), files the agent has been editing, tools the agent has loaded.

## Known constraints
Standing rules from this conversation (don't push without approval, the user is testing X, don't touch Y, etc.). Anything the agent would otherwise blunder into.

Anti-patterns to avoid:
- "The agent has been working on various tasks." Useless.
- "The user wants the project to succeed." Useless.
- "Several decisions were made." Useless, list them.
- Filler transitions ("As mentioned above", "In summary", "Looking forward").

Write the brief directly, no preamble, no meta-commentary about being a continuity brief. The first character should start the "## What the user has told the agent" heading.`;

// Don't regenerate the brief if a fresh one already exists. Compaction can
// fire several times in a row when assembled context hovers around the
// threshold; without this guard the brief is overwritten before the agent
// has a chance to read it. 5 minutes is generous enough that the agent has
// ALMOST CERTAINLY had a turn or two with the existing brief in context.
const BRIEF_OVERWRITE_GUARD_MS = 5 * 60 * 1000;

// Brief target size. Pre-2026-04-30 this was 800 tokens; v1.15.92 raised
// to 2500. The structured prompt rewrite (verbatim user quotes + required
// sections) needs more room to fully capture state, so 4000 tokens, a
// chunky but bounded brief that can hold weeks of project context across
// compactions. Still well under typical context windows.
const BRIEF_TARGET_TOKENS = 4000;

async function generateContinuityBrief(agentId: string, modelId: string, contextWindow: number): Promise<void> {
  try {
    const db = getDb();

    // Skip if a fresh brief already exists. Stored via continuityBriefAt
    // (ISO timestamp); legacy briefs without a timestamp are treated as
    // stale so they get replaced once.
    try {
      const cfgRow = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
      if (cfgRow?.config) {
        const cfg = JSON.parse(cfgRow.config) as Record<string, unknown>;
        const existingBrief = cfg.continuityBrief as string | undefined;
        const existingAt = cfg.continuityBriefAt as string | undefined;
        if (existingBrief && existingAt) {
          const ageMs = Date.now() - new Date(existingAt).getTime();
          if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < BRIEF_OVERWRITE_GUARD_MS) {
            logger.info('Skipping continuity brief regen, existing brief is fresh', {
              ageSeconds: Math.round(ageMs / 1000),
              guardSeconds: Math.round(BRIEF_OVERWRITE_GUARD_MS / 1000),
            }, agentId);
            return;
          }
        }
      }
    } catch { /* best effort */ }

    // Gather ALL current messages (the full context window the agent has right now)
    const allMessages = getRecentMessages(agentId, getFreshTailCount(contextWindow) * 2);
    if (allMessages.length < 5) return; // Not enough context to summarize

    // Format messages for the summarizer. Scrub technique tool-result
    // bodies first so they don't leak into the continuity brief. Also drop
    // inter-agent/lifecycle plumbing (same reason as the leaf summary above): a
    // sub-agent completion dump or PM poke must not become part of the brief the
    // primary reads after compaction, or it narrates another agent's work to the user.
    const formatted = allMessages
      .filter(m => !isNonConversationForSummary(m.content))
      .map(m => {
        const role = m.role === 'assistant' ? '[ASSISTANT]' : m.role === 'user' ? '[USER]' : `[${m.role.toUpperCase()}]`;
        const scrubbed = scrubTechniqueContentForSummary(m.content);
        // Truncate very long messages (tool results) to keep the input manageable
        const content = scrubbed.length > 2000 ? scrubbed.slice(0, 2000) + '...[truncated]' : scrubbed;
        return `${role}\n${content}`;
      }).join('\n---\n');

    // Cap the input to avoid sending too much to the summarizer
    const maxInput = Math.min(formatted.length, 50000);
    const input = formatted.slice(-maxInput); // Take the most recent portion

    logger.info('Generating pre-compaction continuity brief', {
      messageCount: allMessages.length,
      inputChars: input.length,
      targetTokens: BRIEF_TARGET_TOKENS,
    }, agentId);

    const result = await generateSummary({
      content: input,
      depth: 0,
      targetTokens: BRIEF_TARGET_TOKENS,
      agentId,
      modelId,
      previousContext: CONTINUITY_BRIEF_PROMPT,
    });

    // PHASE-2 T7: nothing to strip. The depth-0 contract no longer emits a fenced
    // OPEN-LOOPS section, so the brief is the model's text as written.
    const briefText = result.text;

    if (!briefText || briefText.length < 50) {
      logger.warn('Continuity brief generation produced empty/short result, skipping', { agentId });
      return;
    }

    // Store the brief in the agent's config JSON. The context assembler reads
    // it and injects it at assembly time, no messages, no wasted turns, no
    // chat feed clutter. continuityBriefAt is the source of truth for the
    // overwrite guard above.
    const nowIso = new Date().toISOString();
    const briefTimestamp = new Date().toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZoneName: 'short',
    });
    const briefContent = `[CONTINUITY BRIEF, ${briefTimestamp}, generated before memory compaction]\n${briefText}\n\nYour older conversation history has been archived to the vault. If you need details beyond what's in this brief, use vault_search or history_search to find specific facts, file paths, decisions, or instructions from your earlier conversation.`;

    // Phase 4 §C (2026-05-04), set continuityBriefValidUntilTurn so the
    // assembler stops injecting the brief after 3 turns post-emergency
    // (Part XVIII §C: "the fresh tail is authoritative once the agent has
    // had a few turns to re-orient").
    //
    // currentTurn is computed from MAX(turn_number) on this agent's
    // messages, same logic v2/loop.ts uses. v1 messages have NULL
    // turn_number so MAX returns the highest v2 turn or null. v1 path
    // doesn't read this field, so a NULL/0 default is harmless.
    const turnRow = db
      .prepare('SELECT MAX(turn_number) AS max_turn FROM messages WHERE agent_id = ?')
      .get(agentId) as { max_turn: number | null } | undefined;
    const currentTurn = (turnRow?.max_turn ?? 0) + 1;
    const validUntilTurn = currentTurn + 3;

    db.prepare(`
      UPDATE agents SET config = json_set(
        json_set(
          json_set(COALESCE(config, '{}'), '$.continuityBrief', ?),
          '$.continuityBriefAt', ?
        ),
        '$.continuityBriefValidUntilTurn', ?
      )
      WHERE id = ?
    `).run(briefContent, nowIso, validUntilTurn, agentId);

    logger.info('Continuity brief stored in agent config', {
      briefTokens: result.tokenCount,
      briefChars: result.text.length,
    }, agentId);
  } catch (err) {
    // Continuity brief is best-effort, don't block compaction if it fails
    logger.warn('Continuity brief generation failed, compaction will proceed without it', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

// ── Helpers ──

// Persisted tool rows (and assistant tool_use rows) are raw JSON arrays.
// For the summarizer they are flattened to one-liners that keep WHAT happened
// (tool name, ok/error, a short result head) and drop the wire format. Pure
// text content passes through untouched.
export function condenseToolJsonForSummary(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return content;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const lines: string[] = [];
    for (const b of arr) {
      if (!b || typeof b !== 'object') continue;
      const block = b as { type?: string; name?: string; text?: string; content?: unknown; is_error?: boolean };
      if (block.type === 'tool_use') {
        lines.push(`(called tool ${block.name ?? 'unknown'})`);
      } else if (block.type === 'tool_result') {
        const body = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        lines.push(`(tool result${block.is_error ? ' ERROR' : ''}: ${body.slice(0, 200)})`);
      } else if (block.type === 'text' && typeof block.text === 'string') {
        lines.push(block.text);
      }
    }
    return lines.length > 0 ? lines.join('\n') : content;
  } catch {
    return content; // not JSON after all
  }
}

function chunkMessages(messages: Message[], targetTokens: number): Message[][] {
  const chunks: Message[][] = [];
  let currentChunk: Message[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const msgTokens = msg.tokenCount ?? estimateTokens(msg.content);

    if (currentTokens + msgTokens > targetTokens && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(msg);
    currentTokens += msgTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
