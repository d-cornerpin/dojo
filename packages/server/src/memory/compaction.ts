import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
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

function estimateAssembledTokens(agentId: string, contextWindow: number): {
  total: number;
  summaryTokens: number;
  freshTailTokens: number;
  briefTokens: number;
  freshTailCount: number;
  summaryCount: number;
} {
  const summaries = getContextSummaries(agentId);
  const summaryTokens = summaries.reduce((sum, s) => sum + (s.tokenCount ?? 0), 0);

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

// ── Defaults ──

const DEFAULTS = {
  contextThreshold: 0.75,
  leafChunkTokens: 20000,    // Raised from 10k — less aggressive proactive compaction
  leafTargetTokens: 5000,
  condensedTargetTokens: 6000,
  condensedMinFanout: 4,
  incrementalMaxDepth: 1,
};

// Model-aware tail count for compaction boundary
function getCompactionTailCount(contextWindow: number): number {
  if (contextWindow >= 200000) return 80;
  if (contextWindow >= 128000) return 64;
  if (contextWindow >= 32000) return 40;
  return 24;
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
  options?: { force?: boolean },
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
  const threshold = DEFAULTS.contextThreshold * contextWindow;

  const force = options?.force ?? false;

  logger.info(`Compaction check: assembled=${totalTokens} (summaries=${assembled.summaryTokens}, freshTail=${assembled.freshTailTokens}, brief=${assembled.briefTokens}), threshold=${Math.round(threshold)} (${Math.round(DEFAULTS.contextThreshold * 100)}% of ${contextWindow})${force ? ' [FORCED]' : ''}`, {
    assembledTokens: totalTokens,
    summaryTokens: assembled.summaryTokens,
    freshTailTokens: assembled.freshTailTokens,
    briefTokens: assembled.briefTokens,
    freshTailCount: assembled.freshTailCount,
    summaryCount: assembled.summaryCount,
    threshold: Math.round(threshold),
    contextWindow,
    needsCompaction: totalTokens > threshold,
    force,
  }, agentId);

  if (force || totalTokens > threshold) {
    // No-op guard: if the gate metric is over threshold but there's
    // nothing outside the fresh tail to compact, the bloat IS the fresh
    // tail and compaction can't help. Pre-2026-05-01 we still ran the
    // whole reactive path (continuity brief LLM call, condensation,
    // rebuild, divider broadcast) even when leafCreated would be 0 —
    // and the next turn's gate check tripped again, looping. Now we
    // detect the no-op case and log out cleanly.
    const guardMessagesOutside = getMessagesOutsideFreshTail(agentId, getCompactionTailCount(contextWindow));
    const guardCompactedIds = getCompactedMessageIds(agentId);
    const guardUncompactedCount = guardMessagesOutside.filter(m => !guardCompactedIds.has(m.id)).length;
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
    // of the FULL current context. This is injected after compaction so
    // the agent knows what it was working on. Without this, the agent
    // wakes up post-compaction with only chunk summaries (which are
    // fragmented) and loses the big picture of its current task.
    await generateContinuityBrief(agentId, modelId, contextWindow);

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
    const leafCreated = await runLeafCompaction(agentId, modelId, contextWindow);
    const condensedCreated = await runCondensation(agentId, modelId, DEFAULTS.incrementalMaxDepth);
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
    if (result.leafCreated > 0 || result.condensedCreated > 0 || result.tokensReclaimed > 1000) {
      insertCompactionDivider(agentId, {
        label: `Memory Compacted${result.tokensReclaimed > 0 ? ` — reclaimed ~${formatTokens(result.tokensReclaimed)}` : ''}${result.leafCreated > 0 ? ` (${result.leafCreated} new summar${result.leafCreated === 1 ? 'y' : 'ies'})` : ''}`,
      });
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

  if (uncompactedTokens > DEFAULTS.leafChunkTokens) {
    logger.info('Running proactive leaf compaction', {
      uncompactedTokens,
      threshold: DEFAULTS.leafChunkTokens,
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
    // we just folded some old leaves so they wouldn't accumulate).
    if (leafCreated > 0) {
      insertCompactionDivider(agentId, {
        label: `Memory Compacted (proactive — ${leafCreated} summar${leafCreated === 1 ? 'y' : 'ies'})`,
      });
    }

    logger.info('Proactive compaction complete', result, agentId);
    return result;
  }

  return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
}

// ── Leaf Compaction ──

export async function runLeafCompaction(agentId: string, modelId: string, contextWindow?: number): Promise<number> {
  const cw = contextWindow ?? 200000;
  const messagesOutside = getMessagesOutsideFreshTail(agentId, getCompactionTailCount(cw));
  const compactedIds = getCompactedMessageIds(agentId);

  // Filter to only uncompacted messages
  const uncompacted = messagesOutside.filter(m => !compactedIds.has(m.id));

  if (uncompacted.length === 0) {
    logger.debug('No messages to compact', {}, agentId);
    return 0;
  }

  // Group into chunks of ~leafChunkTokens
  const chunks = chunkMessages(uncompacted, DEFAULTS.leafChunkTokens);

  logger.info('Leaf compaction: processing chunks', {
    totalMessages: uncompacted.length,
    chunkCount: chunks.length,
  }, agentId);

  let summariesCreated = 0;

  for (const chunk of chunks) {
    if (chunk.length === 0) continue;

    // Build content from chunk messages
    const content = chunk.map(m => {
      const role = m.role.toUpperCase();
      return `[${role}] ${m.content}`;
    }).join('\n\n---\n\n');

    const messageIds = chunk.map(m => m.id);
    const earliestAt = chunk[0].createdAt;
    const latestAt = chunk[chunk.length - 1].createdAt;

    try {
      const summary = await generateSummary({
        content,
        depth: 0,
        targetTokens: DEFAULTS.leafTargetTokens,
        agentId,
        modelId,
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

    // Format messages for the summarizer
    const formatted = allMessages.map(m => {
      const role = m.role === 'assistant' ? '[ASSISTANT]' : m.role === 'user' ? '[USER]' : `[${m.role.toUpperCase()}]`;
      // Truncate very long messages (tool results) to keep the input manageable
      const content = m.content.length > 2000 ? m.content.slice(0, 2000) + '...[truncated]' : m.content;
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

    db.prepare(`
      UPDATE agents SET config = json_set(json_set(COALESCE(config, '{}'), '$.continuityBrief', ?), '$.continuityBriefAt', ?)
      WHERE id = ?
    `).run(briefContent, nowIso, agentId);

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
