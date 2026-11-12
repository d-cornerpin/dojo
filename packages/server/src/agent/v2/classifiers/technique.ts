// Technique matcher: fuzzy-match a user message to known techniques and surface
// them in context, so the LLM never has to remember to check. Semantic-only.

export interface Technique {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
}

export interface TechniqueMatch {
  technique: Technique;
  score: number;          // 0..1
  reasons: string[];      // for logging which signals fired
}

// Build the match query from raw content. Attachment-pointer boilerplate
// (Path, fileId hash) dilutes a semantic match, so keep kind + filename only.
export function buildTechniqueMatchQuery(rawContent: string): string {
  if (!rawContent) return '';
  let s = rawContent;
  s = s.replace(/\[(Image|PDF|Audio|Video|Office file|File) attached:\s*([^(\]]+?)\s*(?:\([^)]*\))?(?:,[^\]]*)?\]/gi,
    (_m, kind: string, name: string) => `${kind.toLowerCase().replace(' file', '')}: ${name.trim()}`);
  s = s.replace(/^\s*Path:.*$/gim, '');
  s = s.replace(/\bfileId:\s*\S+/gi, '');
  s = s.replace(/If your model supports (?:vision|PDF input)[^\n]*/gi, '');
  s = s.replace(/Use file_read with this path[^\n]*/gi, '');
  s = s.replace(/To (?:send|forward|transcribe|hear|use)[^\n]*/gi, '');
  s = s.replace(/Do not open image files[^\n]*/gi, '');
  s = s.replace(/The pdf_\*[^\n]*/gi, '');
  return s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

// Thresholds on the embedding-similarity scale, tuned for semantic scores.

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
    // Embedding service down: offer no technique. No keyword fallback: keyword matching is forbidden.
    return [];
  }
}
