
import { createLogger } from '../logger.js';
import { estimateTokens } from '../memory/budget.js';
import { getDreamerAgentId } from '../config/platform.js';
import {
  getPinnedEntries,
  getUnfiledArchivesForAgent,
  formatCitationSuffix,
  type VaultEntry,
} from './store.js';

const logger = createLogger('vault-retrieval');

// Ordinary pins shown in every turn, newest first; every permanent entry is shown besides them.
const MAX_PINNED_ENTRIES = 20;




function formatEntryForPrompt(entry: VaultEntry): string {
  let label = entry.type;
  if (entry.isPinned) label = 'pinned';
  if (entry.isPermanent) label = 'permanent';
  const dateStr = entry.createdAt ? entry.createdAt.split('T')[0]?.split(' ')[0] ?? '' : '';
  // Source suffix lets the agent cite the entry in-context; empty when there is no citation.
  const cite = formatCitationSuffix(entry.citation);
  return dateStr ? `- [${label}, ${dateStr}] ${entry.content}${cite}` : `- [${label}] ${entry.content}${cite}`;
}

// Significant tokens (5+ chars, lowercased, stopwords removed) for cheap Jaccard-style topic overlap.
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
  return shared / entry.size;
}

// Unfiled-archive recall bridge: a session reset files the finished conversation into vault_conversations
// (is_processed = 0), but vault_entries only gain it at the next Dreamer cycle. This read-only peek keeps
// that conversation recallable meanwhile; the is_processed filter in getUnfiledArchivesForAgent ends it.

export interface UnfiledArchiveSnippet {
  text: string;
  latestAt: string;
}

// Deliberately small caps: a stopgap over recent raw conversation, not a search index. Active-task
// suppression is therefore not applied to these snippets.
const UNFILED_MAX_ARCHIVES = 3;      // newest N unfiled archives only
const UNFILED_MAX_MESSAGES = 400;    // total messages scanned across archives
const UNFILED_MAX_SNIPPETS = 3;      // returned snippets
const UNFILED_SNIPPET_CHARS = 300;   // per-snippet char budget
const UNFILED_OVERLAP_THRESHOLD = 0.4; // min token-overlap to count as a match
const UNFILED_BRIDGE_MAX_TOKENS = 200; // context-injection subsection cap

export const UNFILED_ARCHIVE_LABEL =
  'From the just archived previous session (not yet distilled into vault entries):';

// Plain text of a stored archive message: content is a string or a JSON content-block array; only text
// blocks are kept, and a purely tool_use/tool_result message collapses to '' (the caller skips it).
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

// Earliest position of any query token in `text`, to center the snippet (-1 when none).
function firstQueryTokenIndex(text: string, queryTokens: Set<string>): number {
  const lower = text.toLowerCase();
  let best = -1;
  for (const tok of queryTokens) {
    const idx = lower.indexOf(tok);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

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
 * Deterministic recall over the agent's newest unfiled archives (no LLM, no embeddings). Mode 'token'
 * (default) is fuzzy token overlap; 'substring' is a case-insensitive contains match (vault_search exact).
 */
export function searchUnfiledArchives(
  agentId: string,
  query: string,
  opts?: { mode?: 'token' | 'substring' },
): UnfiledArchiveSnippet[] {
  if (!agentId || !query || query.trim().length === 0) return [];
  const mode = opts?.mode ?? 'token';

  // The Dreamer may call vault_search while filing the archive these snippets come from; it must not
  // read its own in-flight work as durable memory. Excluding it here covers both bridge consumers.
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
 * The prefix half of the vault pull: pinned and permanent entries only. No query, no clock, no write,
 * so it stays stable in the cached prefix. The query-driven half is in `memory/recall-lane.ts`.
 *
 * It reads no tracker state: a task edit would then change bytes ahead of the whole conversation.
 */
export function pinnedContextSection(
  agentId: string | undefined,
): { section: string; entryIds: string[] } {
  const all = getPinnedEntries(agentId);
  const newestOthers = new Set(all.filter((e) => !e.isPermanent).slice(0, MAX_PINNED_ENTRIES));
  const pinned = all.filter((e) => e.isPermanent || newestOthers.has(e));

  const lines: string[] = [];
  const includedIds: string[] = [];
  for (const entry of pinned) {
    lines.push(formatEntryForPrompt(entry));
    includedIds.push(entry.id);
  }
  if (lines.length === 0) return { section: '', entryIds: [] };
  // No token budget here: every standing rule is in the section; the ordinary pins are bounded by MAX_PINNED_ENTRIES.
  return { section: `${VAULT_SECTION_HEAD}\n${lines.join('\n')}\n${VAULT_SECTION_TAIL}`, entryIds: includedIds };
}

/** The vault section's frame, named once so every renderer emits the identical wrapper. */
const VAULT_SECTION_HEAD = `## Vault -- What You Remember

The following are facts and knowledge from your long-term memory vault:
`;
const VAULT_SECTION_TAIL =
  '\nYou can search for more memories with vault_search. You can save new knowledge with '
  + 'vault_remember. (These notes can be stale. For what tools/capabilities you have RIGHT '
  + 'NOW, trust your live tool list, not a memory like "I can\'t do X".)';

/**
 * Surfaces the just-archived, unfiled session matched against the query, capped at `maxTokens` (and
 * at most 200). `memory/recall-lane.ts` renders it in the tail lane.
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

/** The bridge's worst case as the lines it would emit, derived from its caps: UNFILED_MAX_SNIPPETS
 *  snippets of UNFILED_SNIPPET_CHARS in their `- [<stamp>] ` frame. `memory/recall-lane.ts` feeds them
 *  through the real renderer to size its reserve. The 200-token cap binds first at runtime; deriving
 *  from the shape means loosening that cap cannot overflow the reserve. */
export function unfiledArchiveWorstCaseLines(): string[] {
  const stampFrame = '- [2026-08-31T12:00:00.000Z] ';
  return Array.from({ length: UNFILED_MAX_SNIPPETS }, () => stampFrame + 'x'.repeat(UNFILED_SNIPPET_CHARS));
}
