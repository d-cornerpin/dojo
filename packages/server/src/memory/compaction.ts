import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
// (getRuntimeVersion import removed in Phase 9 Stage 2 — single-track v2)
import { estimateTokens, getMessagesOutsideFreshTail, getRecentMessages } from './store.js';
import {
  createLeafSummary,
  createCondensedSummary,
  getLeafSummariesNotCondensed,
  getCompactedMessageIds,
  getContextSummaries,
  replaceContextItems,
} from './dag.js';
import { generateSummary } from './summarize.js';
import { archiveMessagesBeforeCompaction, isDreamerIgnored } from '../vault/archive.js';
import { lastCompactionDividerAt } from '../agent/shared-state.js';
import type { Message } from '@dojo/shared';

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
const MAX_GATE_MESSAGE_TOKENS = 4000;

export function estimateAssembledTokens(agentId: string, contextWindow: number): {
  total: number;
  summaryTokens: number;
  freshTailTokens: number;
  briefTokens: number;
  freshTailCount: number;
  summaryCount: number;
} {
  const summaries = getContextSummaries(agentId);
  const rawSummaryTokens = summaries.reduce((sum, s) => sum + (s.tokenCount ?? 0), 0);

  const freshTail = getRecentMessages(agentId, getCompactionTailCount(contextWindow));
  const freshTailTokens = freshTail.reduce(
    (sum, m) => {
      const raw = m.tokenCount ?? estimateTokens(m.content);
      return sum + Math.min(raw, MAX_GATE_MESSAGE_TOKENS);
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
  // dropping oldest first to fit). Without this cap, a long-lived agent — or
  // anyone upgrading from v1 with a deep summary DAG — sees the gate trip at
  // >100% on its first turn, force-compaction can't reduce already-condensed
  // depth-N summaries any further, and the loop wedges firing the same
  // "memory is too full" message forever. The assembler will trim summaries
  // to fit; the gate must reflect that, not the unbounded raw total.
  const TOOL_AND_OUTPUT_RESERVE = 15000;
  const maxAssemblerTokens = Math.max(0, Math.floor(DEFAULTS.contextThreshold * contextWindow) - TOOL_AND_OUTPUT_RESERVE);
  const summaryBudget = Math.max(0, Math.floor((maxAssemblerTokens - briefTokens - freshTailTokens) * 0.7));
  const summaryTokens = Math.min(rawSummaryTokens, summaryBudget);

  return {
    total: summaryTokens + freshTailTokens + briefTokens,
    summaryTokens,
    freshTailTokens,
    briefTokens,
    freshTailCount: freshTail.length,
    summaryCount: summaries.length,
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
// summary as authoritative — defeating the v2.7.4 stub-after-1-turn
// freshness enforcement on the raw tool_result side.
const TECHNIQUE_FRESH_SENTINEL = '══ TECHNIQUE FRESH READ ══';
const TECHNIQUE_SCRUB_STUB =
  '[technique read withheld from summary by engine policy — call technique_read for the current on-disk content; do not paraphrase from this summary]';

function scrubTechniqueContentForSummary(messageContent: string): string {
  // Fast path: plain string content that starts with the sentinel
  // (covers any flow where the runtime persists the raw tool string
  // rather than a JSON tool_result block).
  if (messageContent.startsWith(TECHNIQUE_FRESH_SENTINEL)) {
    return TECHNIQUE_SCRUB_STUB;
  }
  // JSON path: walk tool_result blocks the way the assembler does.
  try {
    const parsed = JSON.parse(messageContent);
    if (!Array.isArray(parsed)) return messageContent;
    let changed = false;
    const next = parsed.map((block: unknown) => {
      const b = block as { type?: string; content?: unknown };
      if (b.type !== 'tool_result') return block;
      if (typeof b.content !== 'string') return block;
      if (!b.content.startsWith(TECHNIQUE_FRESH_SENTINEL)) return block;
      changed = true;
      return { ...b, content: TECHNIQUE_SCRUB_STUB };
    });
    return changed ? JSON.stringify(next) : messageContent;
  } catch {
    return messageContent;
  }
}

// ── Defaults ──
//
// v1: contextThreshold 0.75 — fires at 75% utilization (the "compaction is
// load-bearing" architecture). v2 raises this to 0.96 emergency-only with
// a 0.90 WARN line per Part V — compaction becomes a debug signal, not a
// routine event. Threshold lookup is runtime-version-aware so v1 agents
// keep their original behavior while v2 agents see the new architecture.

const DEFAULTS = {
  // v2 thresholds — emergency-only compaction (Part V).
  // The old v1 values (contextThreshold:0.75, leafChunkTokens:20000) were
  // removed in Phase 9 Stage 2 along with the runtime version flag.
  contextThreshold: 0.96,
  leafChunkTokens: 30000,
  leafTargetTokens: 5000,
  condensedTargetTokens: 6000,
  condensedMinFanout: 4,
  incrementalMaxDepth: 1,
};

function getContextThreshold(): number {
  return DEFAULTS.contextThreshold;
}

function getLeafChunkTokens(): number {
  return DEFAULTS.leafChunkTokens;
}

// Model-aware tail count for compaction boundary
function getCompactionTailCount(contextWindow: number): number {
  if (contextWindow >= 200000) return 80;
  if (contextWindow >= 128000) return 64;
  if (contextWindow >= 32000) return 40;
  return 24;
}

// v2.5.11 — Gap-trigger threshold (mirrors UNCOMPACTED_GAP_THRESHOLD inside
// checkAndCompact). Exported via getUncompactedGapCount for the v2 loop's
// pre-call routine check.
export const UNCOMPACTED_GAP_THRESHOLD = 30;

/**
 * Cheap, sync read of how many messages have fallen outside the fresh tail
 * without yet being summarized. Used by the v2 loop to decide whether to
 * call checkAndCompact at the routine pre-call gate (in addition to the
 * existing token-utilization-based emergency gate).
 *
 * Two SQLite reads — one for "messages outside fresh tail", one for the
 * set of summarized message IDs — and a Set lookup. Negligible per-turn cost.
 */
export function getUncompactedGapCount(agentId: string, contextWindow: number): number {
  const outside = getMessagesOutsideFreshTail(agentId, getCompactionTailCount(contextWindow));
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

// v2.5.11 — After the divider, drop a separate, agent-facing system message
// that nudges the agent toward recall_recent_thread if it needs detail from
// the summarized portion. Sits in the messages table so it lands in the
// fresh tail of the very next API call. Kept under 200 chars so
// recall_recent_thread itself (which filters short system messages) can
// surface it on later lookbacks.
const RECALL_NUDGE_TEXT =
  '[System: Memory was just compacted. If you need specific content from earlier (file contents, tool outputs, prior decisions), call recall_recent_thread(include_tool_results: true) BEFORE responding to the user.]';

function insertRecallNudge(agentId: string): void {
  try {
    const db = getDb();
    const id = uuidv4();
    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'system', ?, datetime('now'))
    `).run(id, agentId, RECALL_NUDGE_TEXT);
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id,
        agentId,
        role: 'system' as const,
        content: RECALL_NUDGE_TEXT,
        tokenCount: null,
        modelId: null,
        cost: null,
        latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn('Failed to insert recall nudge', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

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
    const db = getDb();
    const id = uuidv4();
    const content = `── ${opts.label} ──`;
    const createdAt = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'system', ?, datetime('now'))
    `).run(id, agentId, content);
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

// ── Main Entry Point ──

export async function checkAndCompact(
  agentId: string,
  modelId: string,
  contextWindow: number,
  options?: {
    force?: boolean;
    // v2.5.12 — Per-call cap on how many leaf chunks may be summarized.
    // Used by the routine gap-trigger path so a huge backlog (e.g. an
    // upgrade from a pre-gap-trigger version with thousands of uncompacted
    // messages) drains across many turns instead of blocking a single turn
    // for minutes while it does dozens of LLM calls back-to-back.
    maxChunksPerRun?: number;
    // v2.5.12 — Skip the expensive continuity-brief LLM call AND the
    // user-facing divider/nudge insert. Used by routine drain so we don't
    // pay the brief cost on every chunk and don't spam the chat with
    // "Memory Compacted" notifications while we drain a backlog.
    skipContinuityBrief?: boolean;
    // v2.5.14 — Optional abort signal for cancellation. Used by the
    // routine background drain in v2 loop so a hung summarizer LLM call
    // can actually be cancelled instead of running until the SDK's
    // 10-minute default timeout fires.
    abortSignal?: AbortSignal;
  },
): Promise<{ leafCreated: number; condensedCreated: number; tokensReclaimed: number }> {
  // If the caller passed the sentinel 'auto' model id (auto-routed agent),
  // resolve it to a real model so the summarizer can actually call it.
  // The cheapest enabled model is a good pick — summaries are bulk work
  // where quality matters less than not crashing.
  if (modelId === 'auto' || modelId === '__auto__') {
    const db = getDb();
    const cheapest = db.prepare(`
      SELECT m.id FROM models m
      JOIN providers p ON p.id = m.provider_id
      WHERE m.is_enabled = 1 AND p.id != '__system__'
      ORDER BY COALESCE(m.input_cost_per_m, 0) ASC
      LIMIT 1
    `).get() as { id: string } | undefined;
    if (cheapest) {
      modelId = cheapest.id;
      logger.info('Resolved auto-routed model for compaction', { resolvedModelId: modelId }, agentId);
    } else {
      logger.warn('No enabled models available for compaction — skipping', {}, agentId);
      return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
    }
  }

  const assembled = estimateAssembledTokens(agentId, contextWindow);
  const totalTokens = assembled.total;
  const activeThreshold = getContextThreshold();
  const threshold = activeThreshold * contextWindow;

  const force = options?.force ?? false;

  // v2.5.11 — Second trigger: message-count gap. The original token-pressure
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
  const messagesOutsideForGap = getMessagesOutsideFreshTail(agentId, getCompactionTailCount(contextWindow));
  const compactedIdsForGap = getCompactedMessageIds(agentId);
  const uncompactedGapCount = messagesOutsideForGap.filter(m => !compactedIdsForGap.has(m.id)).length;
  const UNCOMPACTED_GAP_THRESHOLD = 30;
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

  // 90% WARN line (Part V) — if under threshold but past 90%, log loudly +
  // broadcast a chat:error severity=warning. Each WARN is an architecture
  // bug to fix in tools/scaffolding/prompts. Fires once per checkAndCompact
  // invocation, not per loop iteration.
  if (!force) {
    const warnRatio = totalTokens / contextWindow;
    if (warnRatio >= 0.90 && warnRatio < 0.96) {
      const reason = `Context utilization at ${(warnRatio * 100).toFixed(1)}% (${totalTokens}/${contextWindow}). This should not happen in normal v2 operation — investigate tool result sizes, scaffolding injection, system prompt cost.`;
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
    // rebuild, divider broadcast) even when leafCreated would be 0 —
    // and the next turn's gate check tripped again, looping. Now we
    // detect the no-op case and log out cleanly.
    // v2.5.11: reuse the gap calc we already did above instead of
    // re-querying.
    const guardUncompactedCount = uncompactedGapCount;
    if (!force && guardUncompactedCount === 0) {
      logger.warn('Compaction gate exceeded but nothing outside fresh tail to compact — skipping (bloat is in fresh tail itself)', {
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
    // were doing") is severe. Always run it — UNLESS this is a routine
    // gap drain (skipContinuityBrief), in which case the agent is not
    // losing context this turn (fresh tail unchanged) and the brief is
    // pure overhead.
    if (!options?.skipContinuityBrief) {
      await generateContinuityBrief(agentId, modelId, contextWindow);
    }

    // Archive raw messages to vault BEFORE compaction destroys them.
    // If archival fails, ABORT compaction — better to have a bloated context than lost data.
    // Exception: if the agent is on the Dreamer ignore list, the archive is
    // intentionally skipped (returns null). Don't abort compaction in that case.
    const messagesForArchive = getMessagesOutsideFreshTail(agentId, getCompactionTailCount(contextWindow));
    const archiveCompactedIds = getCompactedMessageIds(agentId);
    const uncompactedForArchive = messagesForArchive.filter(m => !archiveCompactedIds.has(m.id));
    if (uncompactedForArchive.length > 0 && !isDreamerIgnored(agentId)) {
      const archiveId = archiveMessagesBeforeCompaction(agentId, uncompactedForArchive);
      if (!archiveId) {
        logger.error('Archive failed — aborting compaction to prevent data loss', { agentId, messageCount: uncompactedForArchive.length }, agentId);
        return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
      }
    }

    const tokensBefore = totalTokens;
    const leafCreated = await runLeafCompaction(agentId, modelId, contextWindow, {
      maxChunks: options?.maxChunksPerRun,
      abortSignal: options?.abortSignal,
    });
    // v2.5.12 — Skip condensation on routine drain too. Condensation walks
    // the depth tree and can do multiple LLM calls; backlog drains will
    // accumulate enough leaf summaries that condensation runs naturally on
    // the next forced/emergency compaction.
    const condensedCreated = options?.skipContinuityBrief
      ? 0
      : await runCondensation(agentId, modelId, DEFAULTS.incrementalMaxDepth);
    rebuildContextItems(agentId);

    const tokensAfter = estimateAssembledTokens(agentId, contextWindow).total;
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
    // v2.5.29 — Show the divider on routine drains too, throttled to once
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
        label: `Memory Compacted${result.tokensReclaimed > 0 ? ` — reclaimed ~${formatTokens(result.tokensReclaimed)}` : ''}${result.leafCreated > 0 ? ` (${result.leafCreated} new summar${result.leafCreated === 1 ? 'y' : 'ies'})` : ''}`,
      });
      insertRecallNudge(agentId);
    }

    logger.info('Compaction complete', result, agentId);
    return result;
  }

  // Check for proactive leaf compaction
  const messagesOutside = getMessagesOutsideFreshTail(agentId, getCompactionTailCount(contextWindow));
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
    // If archival fails, ABORT — don't compact without preserving the data.
    // Exception: dreamer-ignored agents intentionally skip archive.
    if (uncompactedMessages.length > 0 && !isDreamerIgnored(agentId)) {
      const archiveId = archiveMessagesBeforeCompaction(agentId, uncompactedMessages);
      if (!archiveId) {
        logger.error('Archive failed — aborting proactive compaction to prevent data loss', { agentId, messageCount: uncompactedMessages.length }, agentId);
        return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
      }
    }

    const leafCreated = await runLeafCompaction(agentId, modelId, contextWindow);
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
        label: `Memory Compacted (proactive — ${leafCreated} summar${leafCreated === 1 ? 'y' : 'ies'})`,
      });
      insertRecallNudge(agentId);
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
  const messagesOutside = getMessagesOutsideFreshTail(agentId, getCompactionTailCount(cw));
  const compactedIds = getCompactedMessageIds(agentId);

  // Filter to only uncompacted messages (chronological, oldest first — that's
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
    const content = chunk.map(m => {
      const role = m.role.toUpperCase();
      return `[${role}] ${scrubTechniqueContentForSummary(m.content)}`;
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
      const summary = await generateSummary({
        content,
        depth: 0,
        targetTokens: DEFAULTS.leafTargetTokens,
        agentId,
        modelId,
        abortSignal: opts?.abortSignal,
      });

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
    ORDER BY s.earliest_at ASC
  `).all(agentId) as TopLevelRow[];

  // Fresh tail messages
  const freshTail = getRecentMessages(agentId, getCompactionTailCount(contextWindow));

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

const CONTINUITY_BRIEF_PROMPT = `You are generating a CONTINUITY BRIEF for an AI agent whose conversation history is about to be compressed. After compaction the agent will only see this brief + compressed summaries — not the raw messages. If you are vague, the agent loses its mind on the next turn. Specificity is everything.

Length: aim for 1500–3000 words. This is the single most important context the agent will see; do NOT under-write it.

Required sections (use these headings literally, in this order):

## What the user has told the agent
Quote the user's last 3–5 direct instructions or messages **verbatim** if they are short, or paraphrase tightly with quotes around the load-bearing phrases. The user's exact words matter more than your interpretation. Include any "remember to…", "always…", "never…", "from now on…" instructions verbatim.

## Current project / task
What is the agent actually working on right now? Be concrete: specific project name, what stage, what they're trying to achieve. Reject "working on a project" — that's useless. "Fixing the drop-shadow rendering on Layout 7 of the Verve Health deck so it matches Figma reference (file: /Users/.../decks/verve.pptx, slide ID: g3a8f2)" is useful.

## What was happening RIGHT BEFORE compaction
Last 1–3 turns: what tool calls just ran, what they returned, what the agent was about to do next. The agent has to continue exactly from here.

## Specific details to preserve
File paths, URLs, task IDs, agent IDs, deck IDs, technique names, drive file IDs, model names, error messages, decision rationale — anything an agent picking this up tomorrow couldn't rederive in five seconds. Bullet list of facts. Be exhaustive.

## Active threads / tasks
Tracker tasks the agent is owning, A2A threads the agent is in the middle of (with thread IDs), files the agent has been editing, tools the agent has loaded.

## Known constraints
Standing rules from this conversation (don't push without approval, the user is testing X, don't touch Y, etc.). Anything the agent would otherwise blunder into.

Anti-patterns to avoid:
- "The agent has been working on various tasks." Useless.
- "The user wants the project to succeed." Useless.
- "Several decisions were made." Useless — list them.
- Filler transitions ("As mentioned above", "In summary", "Looking forward").

Write the brief directly — no preamble, no meta-commentary about being a continuity brief. The first character should start the "## What the user has told the agent" heading.`;

// Don't regenerate the brief if a fresh one already exists. Compaction can
// fire several times in a row when assembled context hovers around the
// threshold; without this guard the brief is overwritten before the agent
// has a chance to read it. 5 minutes is generous enough that the agent has
// ALMOST CERTAINLY had a turn or two with the existing brief in context.
const BRIEF_OVERWRITE_GUARD_MS = 5 * 60 * 1000;

// Brief target size. Pre-2026-04-30 this was 800 tokens; v1.15.92 raised
// to 2500. The structured prompt rewrite (verbatim user quotes + required
// sections) needs more room to fully capture state, so 4000 tokens — a
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
            logger.info('Skipping continuity brief regen — existing brief is fresh', {
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
    // bodies first so they don't leak into the continuity brief.
    const formatted = allMessages.map(m => {
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

    if (!result.text || result.text.length < 50) {
      logger.warn('Continuity brief generation produced empty/short result — skipping', { agentId });
      return;
    }

    // Store the brief in the agent's config JSON. The context assembler reads
    // it and injects it at assembly time — no messages, no wasted turns, no
    // chat feed clutter. continuityBriefAt is the source of truth for the
    // overwrite guard above.
    const nowIso = new Date().toISOString();
    const briefTimestamp = new Date().toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZoneName: 'short',
    });
    const briefContent = `[CONTINUITY BRIEF — ${briefTimestamp}, generated before memory compaction]\n${result.text}\n\nYour older conversation history has been archived to the vault. If you need details beyond what's in this brief, use vault_search or memory_grep to find specific facts, file paths, decisions, or instructions from your earlier conversation.`;

    // Phase 4 §C (2026-05-04) — set continuityBriefValidUntilTurn so the
    // assembler stops injecting the brief after 3 turns post-emergency
    // (Part XVIII §C: "the fresh tail is authoritative once the agent has
    // had a few turns to re-orient").
    //
    // currentTurn is computed from MAX(turn_number) on this agent's
    // messages — same logic v2/loop.ts uses. v1 messages have NULL
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
    // Continuity brief is best-effort — don't block compaction if it fails
    logger.warn('Continuity brief generation failed — compaction will proceed without it', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

function getFreshTailCount(contextWindow: number): number {
  if (contextWindow >= 200000) return 80;
  if (contextWindow >= 128000) return 64;
  if (contextWindow >= 32000) return 40;
  return 24;
}

// ── Helpers ──

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
