// Vault prefetch classifier: a pure heuristic (no DB read) that decides each
// turn whether to retrieve and inject vault entries. Session start injects once.

export interface VaultPrefetchInput {
  /** The triggering query; empty on system-triggered turns. */
  query: string;
  isSessionStart: boolean;
  /** True when the last 3 turns already mentioned vault entries. */
  recentlyUsedVault: boolean;
  isSystemTrigger: boolean;
}

export interface VaultPrefetchResult {
  shouldFetch: boolean;
  queryTerms: string[];   // extracted terms for the retrieval call
  reason: string;
}

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
  // Session start always fetches: pinned plus session_context inject once.
  if (input.isSessionStart) {
    return {
      shouldFetch: true,
      queryTerms: extractTerms(input.query, /* fallbackBroad= */ true),
      reason: 'session start — pinned + session_context entries always inject',
    };
  }

  // System triggers (scheduler, A2A) skip: they react to structured input, not a user ask.
  if (input.isSystemTrigger) {
    return { shouldFetch: false, queryTerms: [], reason: 'system trigger — skip vault' };
  }

  const trimmed = input.query.trim();
  if (trimmed.length === 0) {
    return { shouldFetch: false, queryTerms: [], reason: 'empty query — nothing to look up' };
  }

  for (const pat of RECALL_PATTERNS) {
    if (pat.test(trimmed)) {
      return {
        shouldFetch: true,
        queryTerms: extractTerms(trimmed),
        reason: `recall pattern matched: ${pat.source.slice(0, 30)}`,
      };
    }
  }

  // Recently used vault: skip, its entries are already in the conversation history.
  if (input.recentlyUsedVault) {
    return {
      shouldFetch: false,
      queryTerms: [],
      reason: 'agent recently used vault — entries already in context',
    };
  }

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

/** Extract substantive terms for vault retrieval; stop words and short tokens dropped. */
function extractTerms(query: string, fallbackBroad = false): string[] {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
    .slice(0, 10);

  if (terms.length === 0 && fallbackBroad) {
    // Session-start fallback: broad terms used when the query yields none.
    return ['current', 'projects', 'active', 'tasks', 'recent', 'work'];
  }
  return terms;
}
