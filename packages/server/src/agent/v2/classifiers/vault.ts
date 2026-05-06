// ════════════════════════════════════════
// Phase 1D — vault prefetch classifier
//
// Per Part VI #4 and Part XVIII §C. v1 auto-injects vault entries
// into context on EVERY turn (assembler.ts:97 retrieveForContext).
// That cost is paid even on simple turns where the vault isn't useful.
//
// v2 promotes the vault to long-term memory (Part XVIII §C):
//   - Pinned and session_context entries inject ONCE at session start
//   - Per-turn injection only when the engine decides it's worth it
//
// This classifier makes that per-turn decision: given the user query,
// should we issue a vault retrieval AND inject the result?
//
// Pure heuristic — no DB read. Phase 4 wires this into the assembler.
// ════════════════════════════════════════

export interface VaultPrefetchInput {
  /** The triggering user query (or empty for system-triggered turns). */
  query: string;
  /** Whether this is the first turn of a session (vault always injects then). */
  isSessionStart: boolean;
  /** Whether the agent's last 3 turns already mentioned vault entries. */
  recentlyUsedVault: boolean;
  /** Was the trigger a system event (scheduler, A2A, etc.)? Skip vault for those. */
  isSystemTrigger: boolean;
}

export interface VaultPrefetchResult {
  shouldFetch: boolean;
  queryTerms: string[];   // extracted terms for the retrieval call
  reason: string;
}

/** Stop words to exclude from query term extraction. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'have', 'he', 'her', 'his', 'i', 'in', 'is', 'it', 'its',
  'me', 'my', 'of', 'on', 'or', 'our', 'she', 'so', 'that', 'the',
  'their', 'them', 'they', 'this', 'to', 'was', 'we', 'were', 'with',
  'you', 'your', 'do', 'does', 'did', 'can', 'could', 'should', 'would',
  'will', 'just', 'now', 'then', 'than', 'but', 'about', 'what', 'when',
  'where', 'why', 'how', 'who', 'which', 'all', 'any', 'some',
]);

/** Personal-context phrases that ALMOST ALWAYS warrant a vault check. */
const RECALL_PATTERNS: RegExp[] = [
  /\bdo you (remember|recall|know)\b/i,
  /\bwhat (did|do) (i|we|you) (say|tell|mention|decide)\b/i,
  /\bremember (when|that)\b/i,
  /\b(my|our) (project|client|preference|setting|password|family|friend|partner|spouse|kid|child|dog|cat)\b/i,
  /\bwhat('s| is) (my|our|the)\b/i,
  /\bwho (is|are|was|were)\b/i,
  /\blast (week|month|year|time)\b/i,
];

export function vaultPrefetchClassifier(input: VaultPrefetchInput): VaultPrefetchResult {
  // Session start always fetches (per Part XVIII §C — vault as CLAUDE.md).
  if (input.isSessionStart) {
    return {
      shouldFetch: true,
      queryTerms: extractTerms(input.query, /* fallbackBroad= */ true),
      reason: 'session start — pinned + session_context entries always inject',
    };
  }

  // System triggers (scheduler, A2A) skip — the agent is reacting to
  // structured input, not a user request that needs personal context.
  if (input.isSystemTrigger) {
    return { shouldFetch: false, queryTerms: [], reason: 'system trigger — skip vault' };
  }

  const trimmed = input.query.trim();
  if (trimmed.length === 0) {
    return { shouldFetch: false, queryTerms: [], reason: 'empty query — nothing to look up' };
  }

  // Strong recall signals — always fetch
  for (const pat of RECALL_PATTERNS) {
    if (pat.test(trimmed)) {
      return {
        shouldFetch: true,
        queryTerms: extractTerms(trimmed),
        reason: `recall pattern matched: ${pat.source.slice(0, 30)}`,
      };
    }
  }

  // Already used vault recently — skip; the relevant entries are
  // already in the conversation history.
  if (input.recentlyUsedVault) {
    return {
      shouldFetch: false,
      queryTerms: [],
      reason: 'agent recently used vault — entries already in context',
    };
  }

  // Default: fetch when there are substantive terms to search on.
  const terms = extractTerms(trimmed);
  if (terms.length === 0) {
    return { shouldFetch: false, queryTerms: [], reason: 'no substantive terms in query' };
  }

  return {
    shouldFetch: true,
    queryTerms: terms,
    reason: 'has substantive terms — issuing vault retrieval',
  };
}

/**
 * Extract substantive terms from a query for vault retrieval. Strips
 * stop words and short tokens. Returns up to 10 terms.
 */
function extractTerms(query: string, fallbackBroad = false): string[] {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
    .slice(0, 10);

  if (terms.length === 0 && fallbackBroad) {
    // Session-start fallback (matches assembler.ts behavior at line 109)
    return ['current', 'projects', 'active', 'tasks', 'recent', 'work'];
  }
  return terms;
}
