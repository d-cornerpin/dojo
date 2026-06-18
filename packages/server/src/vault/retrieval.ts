// ════════════════════════════════════════
// Vault Retrieval: Semantic retrieval for context injection
// Retrieves relevant vault entries for each agent turn
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { estimateTokens } from '../memory/store.js';
import {
  semanticSearch,
  getPinnedEntries,
  updateRetrievalStats,
  type VaultEntry,
} from './store.js';

const logger = createLogger('vault-retrieval');

// Maximum pinned/permanent entries included in every turn.
// Beyond this cap, entries are sorted by importance and the overflow
// is unpinned by the Dreamer during its nightly cycle.
export const MAX_PINNED_ENTRIES = 20;

// ── Model-Dependent Budgets ──

function getVaultBudget(contextWindow: number): { maxTokens: number; maxEntries: number } {
  if (contextWindow >= 200000) return { maxTokens: 2000, maxEntries: 10 };
  if (contextWindow >= 128000) return { maxTokens: 1500, maxEntries: 7 };
  if (contextWindow >= 32000) return { maxTokens: 1000, maxEntries: 5 };
  return { maxTokens: 500, maxEntries: 3 };
}

// ── Format Entries for System Prompt ──

function formatEntryForPrompt(entry: VaultEntry): string {
  let label = entry.type;
  if (entry.isPinned) label = 'pinned';
  if (entry.isPermanent) label = 'permanent';
  // Include creation date so agents can judge temporal relevance
  const dateStr = entry.createdAt ? entry.createdAt.split('T')[0]?.split(' ')[0] ?? '' : '';
  return dateStr ? `- [${label}, ${dateStr}] ${entry.content}` : `- [${label}] ${entry.content}`;
}

// ── Retrieve Relevant Vault Entries ──

// Significant-token extractor for vault-vs-task overlap detection.
// Words ≥ 5 chars, lowercased, common stopwords removed. Yields a
// fuzzy "topic" set for cheap Jaccard-style overlap comparison without
// embeddings.
const VAULT_OVERLAP_STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'have', 'been',
  'when', 'were', 'will', 'into', 'their', 'about', 'they', 'them', 'these',
  'those', 'which', 'where', 'while', 'after', 'before', 'because', 'than',
  'should', 'would', 'could', 'might', 'also', 'other', 'something',
  'agent', 'agents', 'tool', 'tools', 'using', 'used', 'task',
]);

function significantTokensFor(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_\-]+/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 5 && !VAULT_OVERLAP_STOPWORDS.has(t)),
  );
}

function tokenOverlapRatio(entry: Set<string>, task: Set<string>): number {
  if (entry.size === 0 || task.size === 0) return 0;
  let shared = 0;
  for (const t of entry) if (task.has(t)) shared++;
  // Coverage of the (smaller) entry by the task — high values mean
  // the entry is mostly "about" the same thing as the task.
  return shared / entry.size;
}

export async function retrieveForContext(
  query: string,
  contextWindow: number,
  agentId?: string,
): Promise<{ section: string; entryIds: string[] }> {
  const budget = getVaultBudget(contextWindow);

  // ── Active-task topic suppression ──
  // If the agent has in-progress tracker tasks, drop any vault entries
  // of type 'procedure' or 'event' that substantially overlap a task's
  // topic. Those entries are about work currently in flight — they
  // duplicate the tracker (and often contradict it, since vault entries
  // get written before the work is done). The tracker is the source of
  // truth for active state; vault is for durable past facts.
  const activeTaskTopics: Array<{ id: string; topic: Set<string> }> = [];
  if (agentId) {
    try {
      const { listTasks } = await import('../tracker/schema.js');
      const tasks = listTasks({ status: 'in_progress', assignedTo: agentId });
      for (const t of tasks) {
        const topicText = `${t.title} ${t.description ?? ''}`;
        activeTaskTopics.push({ id: t.id, topic: significantTokensFor(topicText) });
      }
    } catch { /* tracker not available */ }
  }

  const isSuppressed = (entry: VaultEntry): { suppressed: boolean; taskId?: string } => {
    if (activeTaskTopics.length === 0) return { suppressed: false };
    if (entry.type !== 'procedure' && entry.type !== 'event') return { suppressed: false };
    if (entry.isPermanent) return { suppressed: false }; // permanent entries are USER.md-grade — never suppress
    const entryTokens = significantTokensFor(entry.content);
    if (entryTokens.size < 4) return { suppressed: false }; // too short to judge
    for (const task of activeTaskTopics) {
      const overlap = tokenOverlapRatio(entryTokens, task.topic);
      if (overlap >= 0.45) return { suppressed: true, taskId: task.id };
    }
    return { suppressed: false };
  };

  // Get pinned entries, capped at MAX_PINNED_ENTRIES.
  // Permanent entries get priority, then sort by recency.
  let pinned = getPinnedEntries();
  if (pinned.length > MAX_PINNED_ENTRIES) {
    pinned.sort((a, b) => {
      // Permanent first
      if (a.isPermanent && !b.isPermanent) return -1;
      if (!a.isPermanent && b.isPermanent) return 1;
      // Then by most recent
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    pinned = pinned.slice(0, MAX_PINNED_ENTRIES);
    logger.info(`Pinned entries exceed cap (${pinned.length + (getPinnedEntries().length - MAX_PINNED_ENTRIES)} total), capped at ${MAX_PINNED_ENTRIES}`);
  }

  // Semantic search for relevant entries
  let relevant: Array<VaultEntry & { similarity: number }> = [];
  try {
    relevant = await semanticSearch(query, { limit: budget.maxEntries + 5 }); // extra for filtering
  } catch (err) {
    logger.warn('Vault semantic search failed, using pinned entries only', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Remove pinned entries from relevant (they're already included separately)
  const pinnedIds = new Set(pinned.map(e => e.id));
  relevant = relevant.filter(e => !pinnedIds.has(e.id));

  // Prioritize: permanent > high confidence > recently retrieved > by similarity
  relevant.sort((a, b) => {
    // Permanent first
    if (a.isPermanent && !b.isPermanent) return -1;
    if (!a.isPermanent && b.isPermanent) return 1;
    // Then by confidence
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    // Then by similarity (already sorted, but just in case)
    return b.similarity - a.similarity;
  });

  // Build the section within token budget
  const lines: string[] = [];
  const includedIds: string[] = [];
  let usedTokens = 0;
  let suppressedCount = 0;

  // Add pinned entries first (always included unless they overlap an
  // active task's topic — see isSuppressed comment).
  for (const entry of pinned) {
    const sup = isSuppressed(entry);
    if (sup.suppressed) {
      suppressedCount++;
      logger.debug('Vault entry suppressed (overlaps active task)', {
        entryId: entry.id, taskId: sup.taskId, type: entry.type,
      });
      continue;
    }
    const line = formatEntryForPrompt(entry);
    const tokens = estimateTokens(line);
    lines.push(line);
    includedIds.push(entry.id);
    usedTokens += tokens;
  }

  // Add relevant entries up to budget
  for (const entry of relevant) {
    if (includedIds.length - pinned.length >= budget.maxEntries) break;
    const sup = isSuppressed(entry);
    if (sup.suppressed) {
      suppressedCount++;
      logger.debug('Vault entry suppressed (overlaps active task)', {
        entryId: entry.id, taskId: sup.taskId, type: entry.type,
      });
      continue;
    }
    const line = formatEntryForPrompt(entry);
    const tokens = estimateTokens(line);
    if (usedTokens + tokens > budget.maxTokens && includedIds.length > pinned.length) break;
    lines.push(line);
    includedIds.push(entry.id);
    usedTokens += tokens;
  }
  if (suppressedCount > 0) {
    logger.info(`Suppressed ${suppressedCount} vault entries that overlapped active tracker tasks`, { agentId });
  }

  if (lines.length === 0) {
    return { section: '', entryIds: [] };
  }

  // Update retrieval stats (async, non-blocking)
  try { updateRetrievalStats(includedIds); } catch { /* best effort */ }

  const section = `## Vault -- What You Remember

The following are facts and knowledge from your long-term memory vault:

${lines.join('\n')}

You can search for more memories with vault_search. You can save new knowledge with vault_remember. (These notes can be stale — for what tools/capabilities you have RIGHT NOW, trust your live tool list, not a memory like "I can't do X".)`;

  logger.debug('Vault context injection', {
    pinnedCount: pinned.length,
    relevantCount: includedIds.length - pinned.length,
    totalTokens: usedTokens,
    budget: budget.maxTokens,
  });

  return { section, entryIds: includedIds };
}
