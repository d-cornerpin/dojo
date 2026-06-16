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
// Token mode: pure heuristic — token overlap + tag matching. No LLM, no
// embeddings. Runs in <2ms.
// Semantic mode (remediation Phase 2): matches the ask against
// technique-intent embeddings instead; the token matcher remains the
// fallback when the embedding service is unavailable.
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

// Build the technique-match query from a raw user message (remediation
// Phase 3, S5.1/S5.2). The persisted content carries attachment POINTER text
// (`[Image attached: vacation.jpg (123 bytes), fileId: ...] Path: ... If your
// model supports vision ...`). The filename and kind are real intent signal a
// photo-with-little-text message would otherwise lack — keep them as a compact
// hint; strip the fileId hash, Path, and capability boilerplate, which are
// noise that dilutes a semantic match. This is the safe slice of "attachment-
// aware matching": no pipeline reorder, no captioning dependency.
export function buildTechniqueMatchQuery(rawContent: string): string {
  if (!rawContent) return '';
  let s = rawContent;
  // Compact attachment pointers to "kind: filename".
  s = s.replace(/\[(Image|PDF|Audio|Video|Office file|File) attached:\s*([^(\]]+?)\s*(?:\([^)]*\))?(?:,[^\]]*)?\]/gi,
    (_m, kind: string, name: string) => `${kind.toLowerCase().replace(' file', '')}: ${name.trim()}`);
  // Drop the boilerplate lines that follow a pointer.
  s = s.replace(/^\s*Path:.*$/gim, '');
  s = s.replace(/\bfileId:\s*\S+/gi, '');
  s = s.replace(/If your model supports (?:vision|PDF input)[^\n]*/gi, '');
  s = s.replace(/Use file_read with this path[^\n]*/gi, '');
  s = s.replace(/To (?:send|forward|transcribe|hear|use)[^\n]*/gi, '');
  s = s.replace(/Do not open image files[^\n]*/gi, '');
  s = s.replace(/The pdf_\*[^\n]*/gi, '');
  // Collapse whitespace.
  return s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

// ── Semantic matching (remediation Phase 2, Invariant II) ──
// Token overlap cannot represent intent: "put these snapshots up on the
// website" shares no tokens with "publish vacation pics", and a photo with a
// two-word caption has nothing to overlap at all. Semantic similarity sits on
// a different scale than token overlap, so semantic mode uses these
// thresholds, not the 0.5/0.25 pair.

export const SEMANTIC_STRONG_THRESHOLD = 0.62;
export const SEMANTIC_MIN_THRESHOLD = 0.4;

export async function semanticTechniqueMatches(
  query: string,
  techniques: Technique[],
): Promise<TechniqueMatch[]> {
  if (techniques.length === 0 || query.trim().length === 0) return [];
  try {
    const { vectorSearch } = await import('../../../memory/vector-search.js');
    const hits = await vectorSearch(query.slice(0, 500), undefined, {
      sourceType: 'technique',
      limit: 5,
      minSimilarity: SEMANTIC_MIN_THRESHOLD,
    });
    const byId = new Map(techniques.map((t) => [t.id, t]));
    const out: TechniqueMatch[] = [];
    for (const hit of hits) {
      const technique = byId.get(hit.sourceId);
      if (!technique) continue; // not in the caller's visible set
      out.push({ technique, score: hit.similarity, reasons: ['semantic'] });
    }
    return out.sort((a, b) => b.score - a.score);
  } catch {
    // Embedding service down: degrade to the token matcher so technique
    // recall weakens but never disappears.
    return techniqueMatcher({ query, techniques });
  }
}

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
