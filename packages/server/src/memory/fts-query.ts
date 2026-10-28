// ════════════════════════════════════════════════════════════════════════════════════════
// FTS-safe query text for the D4 FTS-degrade path in recall-lane.ts. When the query embedding
// is unavailable, per-turn recall falls back to a bare FTS5 MATCH on the query words. FTS5
// refuses punctuation that sits on a word (`this?` is `syntax error near "?"`, `file.txt` is
// `syntax error near "."`, `foo-bar` is `no such column: bar`) and reads bare upper-case
// `NOT`/`OR`/`AND`/`NEAR` as operators — so the raw query must be reduced to safe terms.
//
// Pure on purpose: no imports, no database, no lane policy — the caller decides the word cap.
// ════════════════════════════════════════════════════════════════════════════════════════
export function ftsSafeQuery(text: string, maxWords: number): string {
  const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.filter((w) => w.length > 2).slice(0, maxWords).map((w) => `"${w}"`).join(' ');
}
