// Heuristic query-complexity classifier, no LLM call: the assembler uses it
// to decide whether a turn gets vault/tracker scaffolding; simple turns skip it.

export type Complexity = 'simple' | 'complex';

export interface ComplexityResult {
  complexity: Complexity;
  signals: string[];   // for logging: which heuristics fired
}

/** Phrases that almost always indicate simple chat. */
const SIMPLE_PATTERNS: RegExp[] = [
  /^(hi|hey|hello|yo|sup|good (morning|afternoon|evening|night))\b/i,
  /^(thanks?|thank you|ty|cheers|appreciated)\b/i,
  /^(ok|okay|got it|sounds good|noted|understood|cool|nice|great|perfect)\b/i,
  /^(bye|goodnight|talk later|ttyl)\b/i,
  /^what time is it\??$/i,
  /^how are you\??$/i,
];

/** Phrases that strongly indicate complex multi-step work. */
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

/** Length thresholds: very short skews simple, very long skews complex. */
const SHORT_LENGTH = 30;
const LONG_LENGTH = 200;

export function complexityClassifier(query: string): ComplexityResult {
  const signals: string[] = [];
  const trimmed = query.trim();

  if (trimmed.length === 0) {
    return { complexity: 'simple', signals: ['empty query'] };
  }

  // Strong complex signals first: "hey can you build me a dashboard" is complex despite "hey".
  for (const pat of COMPLEX_PATTERNS) {
    if (pat.test(trimmed)) {
      signals.push(`complex-pattern: ${pat.source.slice(0, 30)}`);
      return { complexity: 'complex', signals };
    }
  }

  // Multi-sentence next: by definition more than a greeting.
  const sentenceCount = (trimmed.match(/[.!?]+/g) ?? []).length;
  if (sentenceCount >= 2) {
    signals.push(`multi-sentence (${sentenceCount} sentences)`);
    return { complexity: 'complex', signals };
  }

  if (trimmed.length >= LONG_LENGTH) {
    signals.push(`long query (${trimmed.length} chars)`);
    return { complexity: 'complex', signals };
  }

  // Simple patterns only now: strong complex signals were already ruled out.
  for (const pat of SIMPLE_PATTERNS) {
    if (pat.test(trimmed)) {
      signals.push(`simple-pattern: ${pat.source.slice(0, 30)}`);
      return { complexity: 'simple', signals };
    }
  }

  if (trimmed.length <= SHORT_LENGTH) {
    signals.push(`short query (${trimmed.length} chars)`);
    return { complexity: 'simple', signals };
  }

  signals.push('default: moderate length, single sentence');
  return { complexity: 'simple', signals };
}
