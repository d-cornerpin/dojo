// ════════════════════════════════════════
// Phase 1B — query complexity classifier
//
// Per Part VI #12. Used by the assembler to decide whether to inject
// vault/tracker scaffolding for a turn. Simple turns (a greeting,
// a one-line question) don't need the same scaffolding cost as a
// multi-step coding task. This trims per-turn baseline cost on the
// majority of casual interactions.
//
// Heuristic — no LLM call. Runs in <1ms.
// ════════════════════════════════════════

export type Complexity = 'simple' | 'complex';

export interface ComplexityResult {
  complexity: Complexity;
  signals: string[];   // for logging — which heuristics fired
}

/**
 * Phrases that almost always indicate simple chat (greetings,
 * one-shot questions, acknowledgments).
 */
const SIMPLE_PATTERNS: RegExp[] = [
  /^(hi|hey|hello|yo|sup|good (morning|afternoon|evening|night))\b/i,
  /^(thanks?|thank you|ty|cheers|appreciated)\b/i,
  /^(ok|okay|got it|sounds good|noted|understood|cool|nice|great|perfect)\b/i,
  /^(bye|goodnight|talk later|ttyl)\b/i,
  /^what time is it\??$/i,
  /^how are you\??$/i,
];

/**
 * Phrases that strongly indicate complex multi-step work.
 */
const COMPLEX_PATTERNS: RegExp[] = [
  /\bbuild\b/i,
  /\bcreate\b.*\b(app|site|page|deck|presentation|document|report)\b/i,
  /\bimplement\b/i,
  /\brefactor\b/i,
  /\bdebug\b/i,
  /\bset up\b/i,
  /\bconfigure\b/i,
  /\bplan\b.*\b(project|sprint|launch|campaign)\b/i,
  /\bresearch\b/i,
  /\binvestigate\b/i,
  /\bdraft\b.*\b(email|memo|proposal|plan|spec)\b/i,
];

/**
 * Length thresholds. Very short messages skew simple; very long ones
 * skew complex.
 */
const SHORT_LENGTH = 30;
const LONG_LENGTH = 200;

export function complexityClassifier(query: string): ComplexityResult {
  const signals: string[] = [];
  const trimmed = query.trim();

  if (trimmed.length === 0) {
    return { complexity: 'simple', signals: ['empty query'] };
  }

  // Strong-signal complex patterns first (they win even over greetings).
  // "hey can you build me a dashboard" → complex despite the "hey" prefix.
  for (const pat of COMPLEX_PATTERNS) {
    if (pat.test(trimmed)) {
      signals.push(`complex-pattern: ${pat.source.slice(0, 30)}`);
      return { complexity: 'complex', signals };
    }
  }

  // Multi-sentence next — by definition not just a greeting.
  const sentenceCount = (trimmed.match(/[.!?]+/g) ?? []).length;
  if (sentenceCount >= 2) {
    signals.push(`multi-sentence (${sentenceCount} sentences)`);
    return { complexity: 'complex', signals };
  }

  // Long messages are complex.
  if (trimmed.length >= LONG_LENGTH) {
    signals.push(`long query (${trimmed.length} chars)`);
    return { complexity: 'complex', signals };
  }

  // Now the simple patterns — only consider them after we've ruled out
  // strong complex signals.
  for (const pat of SIMPLE_PATTERNS) {
    if (pat.test(trimmed)) {
      signals.push(`simple-pattern: ${pat.source.slice(0, 30)}`);
      return { complexity: 'simple', signals };
    }
  }

  // Short queries default to simple.
  if (trimmed.length <= SHORT_LENGTH) {
    signals.push(`short query (${trimmed.length} chars)`);
    return { complexity: 'simple', signals };
  }

  // Single question or imperative of moderate length → simple by default
  signals.push('default: moderate length, single sentence');
  return { complexity: 'simple', signals };
}
