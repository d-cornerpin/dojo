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
  return `- [${label}] ${entry.content}`;
}

// ── Retrieve Relevant Vault Entries ──

export async function retrieveForContext(
  query: string,
  contextWindow: number,
): Promise<{ section: string; entryIds: string[] }> {
  const budget = getVaultBudget(contextWindow);

  // Get pinned entries (always included, don't count against limit)
  const pinned = getPinnedEntries();

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

  // Add pinned entries first (always included)
  for (const entry of pinned) {
    const line = formatEntryForPrompt(entry);
    const tokens = estimateTokens(line);
    lines.push(line);
    includedIds.push(entry.id);
    usedTokens += tokens;
  }

  // Add relevant entries up to budget
  for (const entry of relevant) {
    if (includedIds.length - pinned.length >= budget.maxEntries) break;
    const line = formatEntryForPrompt(entry);
    const tokens = estimateTokens(line);
    if (usedTokens + tokens > budget.maxTokens && includedIds.length > pinned.length) break;
    lines.push(line);
    includedIds.push(entry.id);
    usedTokens += tokens;
  }

  if (lines.length === 0) {
    return { section: '', entryIds: [] };
  }

  // Update retrieval stats (async, non-blocking)
  try { updateRetrievalStats(includedIds); } catch { /* best effort */ }

  const section = `## Vault -- What You Remember

The following are facts and knowledge from your long-term memory vault:

${lines.join('\n')}

You can search for more memories with vault_search. You can save new knowledge with vault_remember.`;

  logger.debug('Vault context injection', {
    pinnedCount: pinned.length,
    relevantCount: includedIds.length - pinned.length,
    totalTokens: usedTokens,
    budget: budget.maxTokens,
  });

  return { section, entryIds: includedIds };
}
