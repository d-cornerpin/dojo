import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { estimateTokens, getMessagesOutsideFreshTail, getRecentMessages, getTotalTokensByAgent } from './store.js';
import {
  createLeafSummary,
  createCondensedSummary,
  getLeafSummariesNotCondensed,
  getCompactedMessageIds,
  replaceContextItems,
} from './dag.js';
import { generateSummary } from './summarize.js';
import { archiveMessagesBeforeCompaction } from '../vault/archive.js';
import type { Message } from '@dojo/shared';

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

  const totalTokens = getTotalTokensByAgent(agentId);
  const threshold = DEFAULTS.contextThreshold * contextWindow;

  const force = options?.force ?? false;

  logger.info(`Compaction check: ${totalTokens} total tokens, threshold at ${Math.round(threshold)} (${Math.round(DEFAULTS.contextThreshold * 100)}% of ${contextWindow})${force ? ' [FORCED]' : ''}`, {
    totalTokens,
    threshold: Math.round(threshold),
    contextWindow,
    needsCompaction: totalTokens > threshold,
    force,
  }, agentId);

  if (force || totalTokens > threshold) {
    // Full reactive compaction
    logger.info('Running full reactive compaction', {
      totalTokens,
      threshold,
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
    const messagesForArchive = getMessagesOutsideFreshTail(agentId, getCompactionTailCount(contextWindow));
    const archiveCompactedIds = getCompactedMessageIds(agentId);
    const uncompactedForArchive = messagesForArchive.filter(m => !archiveCompactedIds.has(m.id));
    if (uncompactedForArchive.length > 0) {
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

    const tokensAfter = getTotalTokensByAgent(agentId);
    const tokensReclaimed = tokensBefore - tokensAfter;

    const result = { leafCreated, condensedCreated, tokensReclaimed: Math.max(tokensReclaimed, 0) };

    broadcast({
      type: 'memory:compaction',
      agentId,
      ...result,
    });

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
    if (uncompactedMessages.length > 0) {
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

const CONTINUITY_BRIEF_PROMPT = `You are generating a continuity brief for an AI agent whose conversation history is about to be compressed. The agent will lose access to the raw messages and will only see this brief plus compressed summaries.

Write a concise brief (300-500 words) that answers:
1. What is the agent currently working on? (specific project, task, or request)
2. What was the agent doing RIGHT NOW when this brief was generated? (last action taken, current step in the process)
3. What is the current state? (what's done, what's in progress, what's next)
4. What specific details does the agent need to continue? (file paths, task IDs, key decisions, important context)
5. What did the user last ask for or what instructions are active?

Be SPECIFIC. Include file paths, task IDs, names, numbers, and any details the agent needs to pick up exactly where it left off. Do NOT be vague — "working on a project" is useless. "Iterating on the Figma-AE pipeline builder script to improve visual fidelity from 35% to target 95%, currently fixing drop shadow rendering in /Users/Shared/figma-ae-pipeline/src/builder.jsx" is useful.

Write the brief directly — no preamble.`;

async function generateContinuityBrief(agentId: string, modelId: string, contextWindow: number): Promise<void> {
  try {
    const db = getDb();

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
    }, agentId);

    const result = await generateSummary({
      content: input,
      depth: 0,
      targetTokens: 800, // Concise but detailed enough to be useful
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
    // chat feed clutter. The brief persists until the next compaction replaces it.
    const briefTimestamp = new Date().toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZoneName: 'short',
    });
    const briefContent = `[CONTINUITY BRIEF — ${briefTimestamp}, generated before memory compaction]\n${result.text}\n\nYour older conversation history has been archived to the vault. If you need details beyond what's in this brief, use vault_search or memory_grep to find specific facts, file paths, decisions, or instructions from your earlier conversation.`;

    db.prepare(`
      UPDATE agents SET config = json_set(COALESCE(config, '{}'), '$.continuityBrief', ?)
      WHERE id = ?
    `).run(briefContent, agentId);

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
