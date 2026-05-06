// ════════════════════════════════════════
// Phase 1D — technique matcher
//
// Per Part VI #5. v1 puts "MANDATORY: Check Techniques Before Starting
// Work" in the system prompt and relies on the agent to call
// list_techniques + use_technique. Weak models forget; strong models
// over-check (they call list_techniques on every "hi").
//
// v2 takes the decision out of the LLM's hands: when a user message
// arrives, this classifier fuzzy-matches the user's intent to known
// techniques and surfaces matches as part of the assembled context.
// The agent gets an explicit "Looks like '${techniqueName}' might
// apply — load it with use_technique('${id}')." note.
//
// Pure heuristic — token overlap + tag matching. No LLM, no embeddings.
// Runs in <2ms.
// ════════════════════════════════════════

export interface Technique {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
}

export interface TechniqueMatch {
  technique: Technique;
  score: number;          // 0..1
  reasons: string[];      // for logging — which signals fired
}

export interface TechniqueMatcherInput {
  /** The user's query / intent (raw text). */
  query: string;
  /** All published techniques visible to the agent. */
  techniques: Technique[];
  /** Minimum score to surface (default 0.25). */
  minScore?: number;
  /** Maximum matches to return (default 3). */
  maxMatches?: number;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'have', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on',
  'or', 'our', 'so', 'that', 'the', 'this', 'to', 'we', 'with',
  'you', 'your', 'do', 'does', 'did', 'can', 'could', 'should',
  'would', 'will', 'just', 'now', 'than', 'about', 'what', 'when',
  'where', 'why', 'how', 'who', 'which',
]);

/**
 * Match a user query against a set of techniques. Returns matches
 * sorted by score descending, filtered to those above minScore.
 */
export function techniqueMatcher(input: TechniqueMatcherInput): TechniqueMatch[] {
  const minScore = input.minScore ?? 0.25;
  const maxMatches = input.maxMatches ?? 3;

  const queryTerms = tokenize(input.query);
  if (queryTerms.size === 0) return [];

  const scored: TechniqueMatch[] = [];

  for (const tech of input.techniques) {
    const reasons: string[] = [];
    let score = 0;

    // Name match: words in technique.name that appear in query.
    const nameTerms = tokenize(tech.name);
    const nameOverlap = countOverlap(nameTerms, queryTerms);
    if (nameOverlap > 0) {
      const nameScore = nameOverlap / Math.max(nameTerms.size, 1);
      score += nameScore * 0.6;  // name match is strongest signal
      reasons.push(`name overlap ${nameOverlap}/${nameTerms.size}`);
    }

    // Description match
    if (tech.description) {
      const descTerms = tokenize(tech.description);
      const descOverlap = countOverlap(descTerms, queryTerms);
      if (descOverlap > 0 && queryTerms.size > 0) {
        const descScore = descOverlap / queryTerms.size;
        score += descScore * 0.3;
        reasons.push(`description overlap ${descOverlap}`);
      }
    }

    // Tag exact matches (high value — tags are curated)
    if (tech.tags && tech.tags.length > 0) {
      let tagHits = 0;
      for (const tag of tech.tags) {
        const tagTerms = tokenize(tag);
        if (countOverlap(tagTerms, queryTerms) > 0) tagHits++;
      }
      if (tagHits > 0) {
        const tagScore = tagHits / tech.tags.length;
        score += tagScore * 0.4;
        reasons.push(`tag hits ${tagHits}/${tech.tags.length}`);
      }
    }

    if (score >= minScore) {
      scored.push({ technique: tech, score: Math.min(score, 1), reasons });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxMatches);
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t)),
  );
}

function countOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}
