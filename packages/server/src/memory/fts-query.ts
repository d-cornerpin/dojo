// FTS5 rejects punctuation on a word and reads bare NOT/OR/AND/NEAR as operators, so keep quoted words only.
export function ftsSafeQuery(text: string, maxWords = 8): string {
  const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.filter((w) => w.length > 2).slice(0, maxWords).map((w) => `"${w}"`).join(' ');
}
