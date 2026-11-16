// ════════════════════════════════════════════════════════════════════════════════════════
// FTS SAFE QUERY — the D4 fallback (`ftsMessageHits` in recall-lane.ts) builds its FTS5 MATCH
// text by only stripping quotes, so any other punctuation (`?`, `.`, `-`, …) stays on a word
// and FTS5 refuses it — `this?` is `syntax error near "?"`, `file.txt` is `syntax error near
// "."`, `foo-bar` is `no such column: bar`. The catch in that function swallows it, so a normal
// question yields zero recall hits exactly when the embedder is down (the only time this path
// runs). A bare upper-case `NOT`/`OR` is also read as an operator and fails the same way.
//
// This suite drives the new pure helper that replaces that expression, and the last two cases
// prove the produced MATCH text actually parses under real FTS5 (not just the helper's shape).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ftsSafeQuery } from '../fts-query.js';

describe('ftsSafeQuery: strips non-word punctuation, quotes every kept word and joins them with OR', () => {
  it('keeps only letter/digit/underscore words, drops 1-2 letter pieces', () => {
    expect(ftsSafeQuery('Can you check this? It\'s file.txt, foo-bar!', 20))
      .toBe('"Can" OR "you" OR "check" OR "this" OR "file" OR "txt" OR "foo" OR "bar"');
  });

  it('keeps the first maxWords words only', () => {
    expect(ftsSafeQuery('one two three four five six', 3))
      .toBe('"one" OR "two" OR "three"');
  });

  it('no words longer than 2 characters gives the empty string', () => {
    expect(ftsSafeQuery('a b ??? !!', 8)).toBe('');
  });

  it('NOT is kept but quoted so it is a plain word; OR (2 letters) is dropped', () => {
    expect(ftsSafeQuery('NOT OR bananas', 8)).toBe('"NOT" OR "bananas"');
  });

  it('unicode letters, digits and underscore survive', () => {
    expect(ftsSafeQuery('café déjà_vu 2026', 8)).toBe('"café" OR "déjà_vu" OR "2026"');
  });

  it('a quoted phrase stays one phrase and a trailing * stays a prefix, both rebuilt from words', () => {
    expect(ftsSafeQuery('"new roof!" shing* car', 8)).toBe('"new roof" OR "shing"* OR "car"');
  });

  it('the produced MATCH text parses under real FTS5 (punctuation no longer breaks it)', () => {
    const db = new Database(':memory:');
    db.exec('create virtual table t using fts5(c)');
    db.prepare('insert into t(c) values (?)').run('can you check this file now');

    const match = db.prepare('select count(*) as n from t where t match ?');
    expect(match.get(ftsSafeQuery('can you check this?', 8))).toEqual({ n: 1 });

    // Punctuation, a phrase and a prefix all parse; any one word is enough to match.
    expect(match.get(ftsSafeQuery('Can you check this? file.txt', 8))).toEqual({ n: 1 });
    expect(match.get(ftsSafeQuery('"check this" fil*', 8))).toEqual({ n: 1 });
    expect(match.get(ftsSafeQuery('"this check" zebra', 8))).toEqual({ n: 0 });
  });
});
