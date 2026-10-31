// t285 R3 — code search can only search the Dojo's own repository, whatever pattern is sent.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../github/account.js', () => ({ getGithubToken: () => 'synthetic-connection-value' }));
import { searchSource } from '../source-remote.js';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubEnv('DOJO_BUILD_SHA', '0123456789abcdef0123456789abcdef01234567');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const queryOf = (): string => new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('q') ?? '';

describe('searchSource scope', () => {
  it('a pattern carrying repo:/org:/user: qualifiers searches only the Dojo repository', async () => {
    await searchSource('secret repo:someone/private org:acme user:bob');
    const q = queryOf();
    expect(q.match(/\brepo:/g)).toHaveLength(1);
    expect(q).toContain('repo:d-cornerpin/dojo');
    expect(q).not.toMatch(/org:|user:|someone\/private/);
    expect(q).toContain('secret');
  });
  it('every widening or steering qualifier is neutralised, in any case, negated or quoted', async () => {
    await searchSource('foo -repo:a/b ORG:acme path:secrets filename:.env in:file language:ts "repo:x/y" repo:"a b"');
    const q = queryOf();
    expect(q).toBe('foo repo:d-cornerpin/dojo');
  });
  it('a pattern of nothing but qualifiers searches nothing', async () => {
    const out = await searchSource('repo:someone/private');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toMatch(/qualifier/i);
  });
  it('ordinary code text with colons is kept', async () => {
    await searchSource('std::string http://x');
    expect(queryOf()).toBe('std::string http://x repo:d-cornerpin/dojo');
  });
  it('F2: a path argument carrying whitespace, quotes or a qualifier is refused and nothing is sent', async () => {
    for (const p of ['packages repo:someone/private', 'a/b org:acme', 'a/"b', "a/b'c", 'repo:x/y', 'a/(b)']) {
      fetchMock.mockClear();
      const out = await searchSource('foo', p);
      expect(fetchMock, p).not.toHaveBeenCalled();
      expect(out, p).toMatch(/not a path inside the Dojo repository/);
    }
  });
  it('F2: a plain path still narrows the search, with exactly one repo: and one path:', async () => {
    await searchSource('foo', 'packages/server/src');
    expect(queryOf()).toBe('foo repo:d-cornerpin/dojo path:packages/server/src');
  });
  it('F2: an unbalanced quote in the pattern never leaves a phrase open over the appended qualifiers', async () => {
    await searchSource('foo "bar baz');
    expect(queryOf()).toBe('foo bar baz repo:d-cornerpin/dojo');
    fetchMock.mockClear();
    await searchSource('"foo bar" baz');
    expect(queryOf()).toBe('"foo bar" baz repo:d-cornerpin/dojo');
  });
  it('F2: a hit from another repository is dropped, whatever the query said', async () => {
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ total_count: 2, items: [
        { path: 'private/secrets.env', repository: { full_name: 'someone/private' } },
        { path: 'src/ok.ts', repository: { full_name: 'd-cornerpin/dojo' } },
      ] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('const foo = 1;\n', { status: 200 }));
    const out = await searchSource('foo');
    expect(out).not.toContain('private/secrets.env');
    expect(out).not.toContain('someone/private');
    expect(out).toContain('src/ok.ts');
    expect(out).toContain('1 file match');
  });
  it('F2: the no-match line repeats what was searched, not the removed qualifiers', async () => {
    const out = await searchSource('foo repo:someone/private');
    expect(out).toContain('No match for "foo"');
    expect(out).not.toContain('someone');
  });
});
