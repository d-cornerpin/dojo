// ════════════════════════════════════════
// Phase 1D — recall strategy classifier
//
// Per Part VI #16. When the agent needs to recall something, it has
// two recall mechanisms: vault_search (semantic, long-term, curated)
// and memory_grep (full-text search of conversation history). v1
// relies on the agent to remember when each applies. The system
// prompt has 40+ lines of vault guidance trying to teach this; weak
// models still default to "I don't remember" without searching.
//
// v2 classifies the recall query itself:
//   - vault: conceptual queries ("the project we discussed", "her name")
//   - grep:  specific recent terms (filenames, exact phrases, dates)
//   - both:  ambiguous — try both
//
// The engine can use this either to suggest a tool to the agent
// or to pre-execute the recall and inject the result. Phase 4
// decides which.
// ════════════════════════════════════════

export type RecallStrategy = 'vault' | 'grep' | 'both' | 'skip';

export interface RecallStrategyResult {
  strategy: RecallStrategy;
  signals: string[];
}

/** Patterns that suggest a vault search (conceptual / personal). */
const VAULT_PATTERNS: RegExp[] = [
  /\b(name|relationship|preference|password|address|email|phone|birthday|anniversary)\b/i,
  /\b(my|our) (project|client|partner|family|spouse|kid|child|dog|cat|brother|sister|parent)\b/i,
  /\bwhat (do|did) (i|we) (decide|agree|prefer|choose)\b/i,
  /\bremember (when|that|the time)\b/i,
  /\b(do you|can you) (remember|recall) (when|that|the)\b/i,
  /\bwhich (project|client|deck|doc) (is|was|did)\b/i,
];

/** Patterns that suggest grep (specific / recent / textual). */
const GREP_PATTERNS: RegExp[] = [
  /\bfile\s+["'`]?[\w./-]+["'`]?/i,             // "the file foo.ts"
  // Quoted phrase — must be balanced double-quote or backtick (single
  // quotes excluded to avoid catching apostrophes in contractions like
  // "what's" / "partner's").
  /"[^"]{4,40}"/,
  /`[^`]{4,40}`/,
  /\b\d{4}-\d{2}-\d{2}\b/,                       // ISO date
  /\b(yesterday|today|earlier|just now|a few minutes ago|this morning)\b/i,
  /\b(what|where) (did|does|is) (it|that|this) say\b/i,
  /\b(error|warning|exception|stack trace) (about|saying|that)\b/i,
];

export function recallStrategyClassifier(query: string): RecallStrategyResult {
  const trimmed = query.trim();
  const signals: string[] = [];

  if (trimmed.length === 0) {
    return { strategy: 'skip', signals: ['empty query'] };
  }

  let vaultHits = 0;
  let grepHits = 0;

  for (const pat of VAULT_PATTERNS) {
    if (pat.test(trimmed)) {
      vaultHits++;
      signals.push(`vault: ${pat.source.slice(0, 30)}`);
    }
  }
  for (const pat of GREP_PATTERNS) {
    if (pat.test(trimmed)) {
      grepHits++;
      signals.push(`grep: ${pat.source.slice(0, 30)}`);
    }
  }

  if (vaultHits === 0 && grepHits === 0) {
    return { strategy: 'skip', signals: ['no recall signal'] };
  }
  if (vaultHits > 0 && grepHits === 0) return { strategy: 'vault', signals };
  if (grepHits > 0 && vaultHits === 0) return { strategy: 'grep', signals };
  // Both signals present — try both. The engine can run them in parallel
  // since both are read-only / safe.
  return { strategy: 'both', signals };
}
