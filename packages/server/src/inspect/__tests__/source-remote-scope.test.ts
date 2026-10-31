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
});
