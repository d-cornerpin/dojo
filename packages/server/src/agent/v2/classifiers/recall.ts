// Classify a recall ask as vault, grep, both, or skip, so the choice is made
// by pattern match rather than by whether the agent happens to try remembering.

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
  // Balanced double-quote or backtick only; single quotes would match apostrophes in contractions.
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
  // Both read-only, so 'both' is safe to run in parallel.
  return { strategy: 'both', signals };
}
