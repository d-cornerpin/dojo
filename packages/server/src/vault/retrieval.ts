// ════════════════════════════════════════
// Vault Retrieval: Semantic retrieval for context injection
// Retrieves relevant vault entries for each agent turn
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { estimateTokens } from '../memory/budget.js';
import { getDreamerAgentId } from '../config/platform.js';
import { listTasks } from '../tracker/schema.js';
import {
  getPinnedEntries,
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

/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * T67b — THE PREFIX HALF OF THE VAULT PULL. NO QUERY, NO CLOCK, NO WRITE.
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * `retrieveForContext` was ONE function doing two jobs with two different volatilities, and
 * `lane.vault` rendered both from MessageSlot.VaultPull = 200 — ahead of the entire message
 * prefix. The semantic half re-ranked against a query built from the recent messages, so a
 * new question rewrote history above itself on every turn; and the function ran
 * `updateRetrievalStats` from that same read path, which is a WRITE inside assembly
 * (PHASE-3 S3's own finding, one module over).
 *
 * This is the half that is genuinely session-stable and may therefore stay in the cached
 * prefix: the PINNED and PERMANENT entries, under the same budget, with the same header, and
 * with the SAME active-task topic suppression the old function applied to them. The
 * semantic half and the FN-1 unfiled-archive bridge went to `memory/recall-lane.ts` — the
 * tail lane that already ran the identical `semanticSearch` and already excluded this
 * pinned set so the two could not double-render.
 *
 * PURE. It bumps no retrieval stats: pinned/permanent rows are exempt from every hygiene arm
 * in `vault/maintenance.ts` by construction (`is_pinned = 0 AND is_permanent = 0` is on each
 * of them), so the bookkeeping this drops could never have decided their fate, and
 * `work/obligation-memory.ts` already records auto-recall inflation making rows immune to
 * hygiene as a defect rather than a service.
 */
export function pinnedContextSection(
  agentId: string | undefined,
): { section: string; entryIds: string[] } {
  const suppress = activeTaskSuppressor(agentId);

  let pinned = getPinnedEntries(agentId);
  if (pinned.length > MAX_PINNED_ENTRIES) {
    pinned.sort((a, b) => {
      if (a.isPermanent && !b.isPermanent) return -1;
      if (!a.isPermanent && b.isPermanent) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    pinned = pinned.slice(0, MAX_PINNED_ENTRIES);
  }

  const lines: string[] = [];
  const includedIds: string[] = [];
  for (const entry of pinned) {
    if (suppress(entry).suppressed) continue;
    lines.push(formatEntryForPrompt(entry));
    includedIds.push(entry.id);
  }
  if (lines.length === 0) return { section: '', entryIds: [] };
  // No token budget is applied and that is deliberate, not an omission: the pinned/permanent
  // set is bounded by `MAX_PINNED_ENTRIES` (20) and the Dreamer unpins the overflow nightly.
  // `getVaultBudget`'s token ceiling existed to ration the SEMANTIC half against it, and that
  // half is `memory/recall-lane.ts`'s now, under that lane's own derived reserve.
  return { section: `${VAULT_SECTION_HEAD}\n${lines.join('\n')}\n${VAULT_SECTION_TAIL}`, entryIds: includedIds };
}

/** The vault section's frame, named once so the prefix half and any future reader render
 *  the identical wrapper. Bytes unchanged from the string `retrieveForContext` built. */
const VAULT_SECTION_HEAD = `## Vault -- What You Remember

The following are facts and knowledge from your long-term memory vault:
`;
const VAULT_SECTION_TAIL =
  '\nYou can search for more memories with vault_search. You can save new knowledge with '
  + 'vault_remember. (These notes can be stale. For what tools/capabilities you have RIGHT '
  + 'NOW, trust your live tool list, not a memory like "I can\'t do X".)';

/**
 * The active-task topic suppressor, lifted out of `retrieveForContext` unchanged so the
 * prefix half and the tail half apply the SAME rule rather than two copies of it.
 *
 * If the agent has in-progress tracker tasks, drop any vault entries of type 'procedure' or
 * 'event' that substantially overlap a task's topic. Those entries are about work currently
 * in flight — they duplicate the tracker (and often contradict it, since vault entries get
 * written before the work is done). The tracker is the source of truth for active state;
 * vault is for durable past facts.
 */
export function activeTaskSuppressor(
  agentId: string | undefined,
): (entry: VaultEntry) => { suppressed: boolean; taskId?: string } {
  const activeTaskTopics: Array<{ id: string; topic: Set<string> }> = [];
  if (agentId) {
    try {
      // `listTasks` is a synchronous read; the dynamic import the async caller used is not
      // available here, so the module is required through the same path the tracker uses.
      const tasks = listTasks({ status: 'in_progress', assignedTo: agentId });
      for (const t of tasks) {
        const topicText = `${t.title} ${t.description ?? ''}`;
        activeTaskTopics.push({ id: t.id, topic: significantTokensFor(topicText) });
      }
    } catch { /* tracker not available */ }
  }
  return (entry: VaultEntry) => {
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
}

/**
 * T67b — THE FN-1 BRIDGE, EXPORTED SO ITS NEW HOME CAN CALL IT.
 *
 * It surfaces the just-archived-but-unfiled session, searched BY THE QUERY, which is why it
 * left the prefix with the rest of the retrieval. `memory/recall-lane.ts` renders it now,
 * under the same 200-token cap it always had, past `volatileFrom`.
 */
export function unfiledArchiveBridgeLines(
  agentId: string,
  query: string,
  maxTokens: number = UNFILED_BRIDGE_MAX_TOKENS,
): string[] {
  const snippets = searchUnfiledArchives(agentId, query, { mode: 'token' });
  if (snippets.length === 0) return [];
  const cap = Math.min(UNFILED_BRIDGE_MAX_TOKENS, maxTokens);
  const kept: string[] = [];
  let bridgeTokens = estimateTokens(UNFILED_ARCHIVE_LABEL);
  for (const snip of snippets) {
    const line = `- [${snip.latestAt}] ${snip.text}`;
    const t = estimateTokens(line);
    if (bridgeTokens + t > cap) break;
    kept.push(line);
    bridgeTokens += t;
  }
  return kept;
}

/** The bridge's own worst case as the LINES it would emit, DERIVED from its caps rather than
 *  guessed beside them: `UNFILED_MAX_SNIPPETS` snippets at `UNFILED_SNIPPET_CHARS`, each in
 *  its `- [<stamp>] ` frame. `memory/recall-lane.ts`'s reserve derivation feeds these through
 *  the real renderer, so the declaration and the render cannot drift.
 *
 *  Note the 200-token `UNFILED_BRIDGE_MAX_TOKENS` cap binds FIRST at runtime; these lines are
 *  the shape the cap is applied to, and the reserve is deliberately derived from the shape so
 *  a future loosening of the token cap cannot silently exceed a reserve derived from it. */
export function unfiledArchiveWorstCaseLines(): string[] {
  const stampFrame = '- [2026-08-31T12:00:00.000Z] ';
  return Array.from({ length: UNFILED_MAX_SNIPPETS }, () => stampFrame + 'x'.repeat(UNFILED_SNIPPET_CHARS));
}

// ── T67b — `retrieveForContext` IS GONE, AND BOTH OF ITS HALVES HAVE A HOME ─────────────
//
// It was the ONE reader of the vault for context injection, and it mixed two volatilities:
// a PINNED set that changes when the user pins, and a SEMANTIC SEARCH that changes with
// every ask — rendered together from `MessageSlot.VaultPull = 200`, ahead of the whole
// message prefix, with an `updateRetrievalStats` write inside the assembly read path.
//
//   the pinned half   -> `pinnedContextSection` above (prefix, pure, no query)
//   the semantic half -> `memory/recall-lane.ts` (tail, past `volatileFrom`) — which was
//                        ALREADY running the identical `semanticSearch` with the identical
//                        scope and already subtracting this pinned set so the two could not
//                        double-render. Its `includeVault` gate existed only because THIS
//                        function fired on scaffolding turns; it is always on now.
//   the FN-1 bridge   -> `unfiledArchiveBridgeLines` above, called from the same tail lane.
//
// Deleted rather than left beside its replacements: a second, unreferenced path into the
// vault is how the double-injection gate it once needed came to exist.
