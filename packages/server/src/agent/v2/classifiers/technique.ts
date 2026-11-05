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
// Matching is semantic only: the ask against technique-intent embeddings. v3.5 owner test 2 (fix rank 5): the
// token-overlap fallback is gone. It was keyword matching, which the product laws forbid; with no embedding service,
// no technique is offered.
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
    // Embedding service down: no technique is offered (v3.5 owner test 2: no keyword fallback).
    return [];
  }
}
