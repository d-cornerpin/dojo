// ════════════════════════════════════════
// Vault Retrieval: Semantic retrieval for context injection
// Retrieves relevant vault entries for each agent turn
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { estimateTokens } from '../memory/store.js';
import { getDreamerAgentId } from '../config/platform.js';
import {
  semanticSearch,
  getPinnedEntries,
  updateRetrievalStats,
  getUnfiledArchivesForAgent,
  formatCitationSuffix,
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
  // FU-2: append the compact source suffix when the entry carries a citation, so
  // the agent can cite it in-context. Empty string when there is none.
  const cite = formatCitationSuffix(entry.citation);
  return dateStr ? `- [${label}, ${dateStr}] ${entry.content}${cite}` : `- [${label}] ${entry.content}${cite}`;
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

// ── FN-1: Unfiled-archive recall bridge ──
//
// behav-sig:wave3-memory-across-reset-race. A session reset copies the
// just-finished conversation into vault_conversations (is_processed = 0) but
// nothing files it into vault_entries until the nightly Dreamer cycle. Every
// vault recall path reads ONLY vault_entries, so a fact told right before a
// reset is invisible for hours. This bridge deterministically peeks at the
// agent's newest still-unfiled archives so that fact stays recallable in the
// gap. It never writes entries and self-disables once the Dreamer flips
// is_processed = 1 (the WHERE clause in getUnfiledArchivesForAgent is the gate),
// so vault_entries remains the sole distilled store.

// A single unfiled-archive match: a bounded snippet of raw recent conversation
// plus the archive's latest_at so the caller can date-stamp it.
export interface UnfiledArchiveSnippet {
  text: string;
  latestAt: string;
}

// Deliberately small caps: this is a stopgap over recent raw conversation, not
// a search index. Keeping it tight (and the label explicit at the call sites)
// is why the active-task suppression that guards stale ENTRIES is not applied
// to these snippets.
const UNFILED_MAX_ARCHIVES = 3;      // newest N unfiled archives only
const UNFILED_MAX_MESSAGES = 400;    // total messages scanned across archives
const UNFILED_MAX_SNIPPETS = 3;      // returned snippets
const UNFILED_SNIPPET_CHARS = 300;   // per-snippet char budget
const UNFILED_OVERLAP_THRESHOLD = 0.4; // min token-overlap to count as a match
const UNFILED_BRIDGE_MAX_TOKENS = 200; // context-injection subsection cap

// The exact label wording is shared by both bridge consumers (context injection
// and vault_search) so the surfaced text always reads the same way.
export const UNFILED_ARCHIVE_LABEL =
  'From the just archived previous session (not yet distilled into vault entries):';

// Pull the plain-text portion out of a stored archive message. Archive content
// is either a plain string or a JSON content-block array (assistant turns carry
// tool_use blocks alongside text). We keep only text blocks; a message that is
// purely tool_use / tool_result collapses to '' and is skipped by the caller.
function extractArchiveText(content: string): string {
  if (!content) return '';
  const trimmed = content.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return content;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return content; }
  if (!Array.isArray(parsed)) return content;
  const parts: string[] = [];
  for (const blk of parsed as Array<Record<string, unknown>>) {
    if (blk?.type === 'text' && typeof blk.text === 'string' && blk.text.trim().length > 0) {
      parts.push(blk.text);
    }
  }
  return parts.join('\n');
}

// Earliest position in `text` of any significant query token, used to center the
// snippet window. -1 when none is found (snippet then starts at the head).
function firstQueryTokenIndex(text: string, queryTokens: Set<string>): number {
  const lower = text.toLowerCase();
  let best = -1;
  for (const tok of queryTokens) {
    const idx = lower.indexOf(tok);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

// Window `text` down to ~maxChars, centered on the match where possible, with
// ellipses marking elided ends.
function makeSnippet(text: string, matchIndex: number, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (matchIndex < 0) return text.slice(0, maxChars) + '…';
  const half = Math.floor(maxChars / 2);
  let start = Math.max(0, matchIndex - half);
  const end = Math.min(text.length, start + maxChars);
  start = Math.max(0, end - maxChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end) + suffix;
}

/**
 * Deterministic recall over the agent's newest still-unfiled conversation
 * archives (FN-1). No LLM, no embeddings, just token-overlap or substring
 * matching so it holds on the weakest model.
 *
 * @param agentId scope: only this agent's archives (per-agent vault, W3-4).
 * @param query   the recall query (recent-message text, or a vault_search query).
 * @param opts.mode 'token' (default) reuses significantTokensFor/tokenOverlapRatio
 *   for fuzzy conceptual recall; 'substring' does a plain case-insensitive
 *   contains match (backs vault_search exact mode).
 */
export function searchUnfiledArchives(
  agentId: string,
  query: string,
  opts?: { mode?: 'token' | 'substring' },
): UnfiledArchiveSnippet[] {
  if (!agentId || !query || query.trim().length === 0) return [];
  const mode = opts?.mode ?? 'token';

  // The Dreamer may call vault_search while filing the very archive these
  // snippets come from; never let it read its own in-flight work as if it were
  // durable memory. Excluding it here covers both bridge consumers at once.
  try { if (agentId === getDreamerAgentId()) return []; } catch { /* config not ready */ }

  let archives: Array<{ id: string; messages: string; latestAt: string }>;
  try {
    archives = getUnfiledArchivesForAgent(agentId, UNFILED_MAX_ARCHIVES);
  } catch (err) {
    logger.debug('Unfiled-archive lookup failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  if (archives.length === 0) return [];

  const queryTokens = significantTokensFor(query);
  const queryLower = query.trim().toLowerCase();
  if (mode === 'token' && queryTokens.size === 0) return [];

  const snippets: UnfiledArchiveSnippet[] = [];
  let scanned = 0;

  for (const archive of archives) {
    if (snippets.length >= UNFILED_MAX_SNIPPETS || scanned >= UNFILED_MAX_MESSAGES) break;
    let rows: Array<{ role?: string; content?: string }>;
    try {
      const parsed = JSON.parse(archive.messages);
      if (!Array.isArray(parsed)) continue;
      rows = parsed as Array<{ role?: string; content?: string }>;
    } catch { continue; }

    for (const row of rows) {
      if (snippets.length >= UNFILED_MAX_SNIPPETS || scanned >= UNFILED_MAX_MESSAGES) break;
      const role = (row.role ?? '').toLowerCase();
      if (role !== 'user' && role !== 'assistant') continue;
      const clean = extractArchiveText(row.content ?? '').replace(/\s+/g, ' ').trim();
      if (clean.length === 0) continue;
      scanned++;

      let matchIndex = -1;
      if (mode === 'substring') {
        matchIndex = clean.toLowerCase().indexOf(queryLower);
        if (matchIndex === -1) continue;
      } else {
        const msgTokens = significantTokensFor(clean);
        // Symmetric: a short precise archived line covered by the query, or a
        // query token fully present in the message, both count.
        const overlap = Math.max(
          tokenOverlapRatio(msgTokens, queryTokens),
          tokenOverlapRatio(queryTokens, msgTokens),
        );
        if (overlap < UNFILED_OVERLAP_THRESHOLD) continue;
        matchIndex = firstQueryTokenIndex(clean, queryTokens);
      }

      snippets.push({
        text: makeSnippet(clean, matchIndex, UNFILED_SNIPPET_CHARS),
        latestAt: archive.latestAt,
      });
    }
  }

  return snippets;
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
  // W3-4: scoped to the requesting agent's own vault (per-agent by design).
  let pinned = getPinnedEntries(agentId);
  if (pinned.length > MAX_PINNED_ENTRIES) {
    pinned.sort((a, b) => {
      // Permanent first
      if (a.isPermanent && !b.isPermanent) return -1;
      if (!a.isPermanent && b.isPermanent) return 1;
      // Then by most recent
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    pinned = pinned.slice(0, MAX_PINNED_ENTRIES);
    logger.info(`Pinned entries exceed cap (${pinned.length + (getPinnedEntries(agentId).length - MAX_PINNED_ENTRIES)} total), capped at ${MAX_PINNED_ENTRIES}`);
  }

  // Semantic search for relevant entries
  let relevant: Array<VaultEntry & { similarity: number }> = [];
  try {
    // FA-V6: personalOnly:true so semantic personal recall matches exact mode's
    // existing contract (listEntries defaults to namespace IS NULL). Without it,
    // an agent's own squad-namespaced entries leaked into PERSONAL recall while
    // exact mode filtered them out. Squad recall still flows via squad_recall.
    // Still correct under D-A: household sharing is BUILT and LIVE (resolveRecallScope
    // in vault/store.js), but it is a separate AXIS, it widens which author ids are in
    // scope, not which namespaces. Squad namespaces stay opt-in, so keeping them out
    // of personal recall is the right default regardless of the household flip.
    relevant = await semanticSearch(query, { limit: budget.maxEntries + 5, agentId, personalOnly: true }); // extra for filtering
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

  // Update retrieval stats (async, non-blocking). Only real entries were
  // included; the bridge below never touches includedIds (retrieval bookkeeping
  // is for distilled vault_entries only).
  if (lines.length > 0) {
    try { updateRetrievalStats(includedIds); } catch { /* best effort */ }
  }

  const sectionParts: string[] = [];

  if (lines.length > 0) {
    sectionParts.push(`## Vault -- What You Remember

The following are facts and knowledge from your long-term memory vault:

${lines.join('\n')}

You can search for more memories with vault_search. You can save new knowledge with vault_remember. (These notes can be stale. For what tools/capabilities you have RIGHT NOW, trust your live tool list, not a memory like "I can't do X".)`);
  }

  // ── FN-1 bridge: surface the just-archived-but-unfiled session ──
  // Runs even when there are no vault_entries yet (a fact told right before a
  // reset produces exactly that: an unfiled archive and an empty entries set).
  // Capped small, dated, and clearly labeled; no active-task suppression is run
  // on these snippets (that guard is for stale procedure/event ENTRIES, not raw
  // recent conversation). Bridge ids are never added to includedIds.
  if (agentId) {
    try {
      const remaining = budget.maxTokens - usedTokens;
      if (remaining > 0) {
        const snippets = searchUnfiledArchives(agentId, query, { mode: 'token' });
        if (snippets.length > 0) {
          const cap = Math.min(UNFILED_BRIDGE_MAX_TOKENS, remaining);
          const kept: string[] = [];
          let bridgeTokens = estimateTokens(UNFILED_ARCHIVE_LABEL);
          for (const snip of snippets) {
            const line = `- [${snip.latestAt}] ${snip.text}`;
            const t = estimateTokens(line);
            if (bridgeTokens + t > cap) break;
            kept.push(line);
            bridgeTokens += t;
          }
          if (kept.length > 0) {
            sectionParts.push(`${UNFILED_ARCHIVE_LABEL}\n${kept.join('\n')}`);
            usedTokens += bridgeTokens;
            logger.debug('Vault unfiled-archive bridge injected', {
              agentId, snippets: kept.length, bridgeTokens,
            });
          }
        }
      }
    } catch (err) {
      logger.debug('Vault unfiled-archive bridge failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (sectionParts.length === 0) {
    return { section: '', entryIds: includedIds };
  }

  logger.debug('Vault context injection', {
    pinnedCount: pinned.length,
    relevantCount: includedIds.length - pinned.length,
    totalTokens: usedTokens,
    budget: budget.maxTokens,
  });

  return { section: sectionParts.join('\n\n'), entryIds: includedIds };
}
