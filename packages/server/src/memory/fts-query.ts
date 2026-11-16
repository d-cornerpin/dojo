// FTS5 rejects punctuation on a word and reads bare NOT/OR/AND/NEAR as operators, so every term is rebuilt from its
// words and quoted. Terms join with OR and bm25 ranks a row holding more of them first; a "phrase" and a trailing * keep
// their meaning.
export function ftsSafeQuery(text: string, maxWords = 8): string {
  return (text.match(/"[^"]*"|[\p{L}\p{N}_]+\*?/gu) ?? []).map((term) => {
    const words = term.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (term.startsWith('"')) return words.length > 0 ? `"${words.join(' ')}"` : '';
    const word = words[0] ?? '';
    return word.length > 2 ? `"${word}"${term.endsWith('*') ? '*' : ''}` : '';
  }).filter(Boolean).slice(0, maxWords).join(' OR ');
}
