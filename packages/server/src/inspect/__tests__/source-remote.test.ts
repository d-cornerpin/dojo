// v3.5 inspect A2 — the Dojo's own source, read from its public GitHub repository at the exact
// commit this box runs. Nothing ships on the box (owner ruling 2026-10-20).
//
// Every GitHub call is MOCKED here; this file makes no network call. The pins:
//   · the sha and version come from the platform's own authorities (boot-stamp's resolver,
//     update.ts's version), never from a constant;
//   · a read fetches the raw URL AT THAT SHA and numbers its lines, whole when no range is asked;
//   · a path that climbs out of the repository is refused before any fetch;
//   · search uses the owner's GitHub connection when there is one, and without one says so and
//     still gives the agent the repository link and the raw-read form (REVIEW FOCUS 5);
//   · GitHub unreachable is a plain sentence plus the link, never a throw.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

const token: { current: string | null } = { current: null };
vi.mock('../../github/account.js', () => ({ getGithubToken: () => token.current }));

import { sourceRef, readSourceFile, searchSource, pointerLine } from '../source-remote.js';
import { getCurrentVersion } from '../../gateway/routes/update.js';

const REPO = { full_name: 'd-cornerpin/dojo' };
const SHA = '0123456789abcdef0123456789abcdef01234567';
const fetchMock = vi.fn();

const text = (body: string, status = 200): Response => new Response(body, { status });
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubEnv('DOJO_BUILD_SHA', SHA);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  token.current = null;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('sourceRef', () => {
  it('names the commit and version this box runs, and the tree URL at that commit', () => {
    const ref = sourceRef();
    expect(ref).toMatchObject({ owner: 'd-cornerpin', repo: 'dojo', sha: SHA, version: getCurrentVersion() });
    expect(ref.url).toBe(`https://github.com/d-cornerpin/dojo/tree/${SHA}`);
    expect(pointerLine()).toBe(`Source: https://github.com/d-cornerpin/dojo/tree/${SHA} (the commit this box runs, v${getCurrentVersion()}).`);
  });

  it('in a development checkout with no build stamp, is the checkout HEAD (the same resolver the boot stamp uses)', () => {
    vi.stubEnv('DOJO_BUILD_SHA', '');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8', cwd: __dirname }).trim();
    expect(sourceRef().sha).toBe(head);
  });
});

describe('readSourceFile', () => {
  const FILE = ['line one', 'line two', 'line three', 'line four'].join('\n') + '\n';

  it('fetches the raw file at the running commit and numbers the asked range', async () => {
    fetchMock.mockResolvedValueOnce(text(FILE));
    const out = await readSourceFile('packages/server/src/work/store.ts', 2, 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://raw.githubusercontent.com/d-cornerpin/dojo/${SHA}/packages/server/src/work/store.ts`);
    expect(out).toMatch(/^2 {2}line two$/m);
    expect(out).toMatch(/^3 {2}line three$/m);
    expect(out).not.toContain('line one');
    expect(out).not.toContain('line four');
    expect(out).toContain('lines 2–3 of 4');
    expect(out.trimEnd().endsWith(pointerLine())).toBe(true);
  });

  it('returns the whole file, every line numbered, when no range is asked', async () => {
    const long = Array.from({ length: 1200 }, (_, i) => `row ${i + 1}`).join('\n');
    fetchMock.mockResolvedValueOnce(text(long));
    const out = await readSourceFile('README.md');
    expect(out).toMatch(/^ {3}1 {2}row 1$/m);
    expect(out).toMatch(/^1200 {2}row 1200$/m);
  });

  it('refuses a path outside the repository before any fetch', async () => {
    for (const p of ['../secrets.yaml', '/etc/hosts', 'packages/../../x', 'https://example.com/x', '', 'a\\..\\b', '~/.dojo/secrets.yaml']) {
      const out = await readSourceFile(p);
      expect(out, p).toMatch(/path inside the Dojo repository/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says plainly when the file is not in that commit', async () => {
    fetchMock.mockResolvedValueOnce(text('404: Not Found', 404));
    const out = await readSourceFile('packages/server/src/nope.ts');
    expect(out).toContain('No file at packages/server/src/nope.ts');
    expect(out).toContain(pointerLine());
  });

  it('REVIEW FOCUS 5: GitHub unreachable — a plain sentence and the link, never a throw', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const out = await readSourceFile('packages/server/src/work/store.ts');
    expect(out).toContain('GitHub could not be reached');
    expect(out).toContain(`https://github.com/d-cornerpin/dojo/blob/${SHA}/packages/server/src/work/store.ts`);
    expect(out).toContain(pointerLine());
  });

  it('scrubs a token-shaped string out of the file', async () => {
    const key = `sk-ant-${'Q'.repeat(30)}`;
    fetchMock.mockResolvedValueOnce(text(`const example = '${key}';\n`));
    const out = await readSourceFile('fixtures/example.ts');
    expect(out).not.toContain(key);
  });
});

describe('searchSource', () => {
  it('REVIEW FOCUS 5: without a GitHub connection, says search needs one and gives the link and the raw-read form', async () => {
    const out = await searchSource('taskMovedAtSql');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toContain('needs a GitHub connection');
    expect(out).toContain(`https://github.com/d-cornerpin/dojo/tree/${SHA}`);
    expect(out).toContain(`https://raw.githubusercontent.com/d-cornerpin/dojo/${SHA}/<path>`);
    expect(out).toContain(pointerLine());
  });

  it('with the connection, searches the repo with the token and locates each hit at the running commit', async () => {
    token.current = 'synthetic-connection-value';
    fetchMock
      .mockResolvedValueOnce(json({ total_count: 1, items: [{ path: 'packages/server/src/work/moved.ts', repository: REPO }] }))
      .mockResolvedValueOnce(text('import x;\nexport const taskMovedAtSql = 1;\nconst y = taskMovedAtSql + 1;\n'));
    const out = await searchSource('taskMovedAtSql', 'packages/server');
    const [searchUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const q = new URL(searchUrl).searchParams.get('q');
    expect(new URL(searchUrl).origin + new URL(searchUrl).pathname).toBe('https://api.github.com/search/code');
    expect(q).toBe('taskMovedAtSql repo:d-cornerpin/dojo path:packages/server');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer synthetic-connection-value');
    expect(String(fetchMock.mock.calls[1][0])).toBe(`https://raw.githubusercontent.com/d-cornerpin/dojo/${SHA}/packages/server/src/work/moved.ts`);
    expect(out).toContain('packages/server/src/work/moved.ts');
    expect(out).toMatch(/^ {2}2: export const taskMovedAtSql = 1;$/m);
    expect(out).toMatch(/^ {2}3: const y = taskMovedAtSql \+ 1;$/m);
    expect(out).not.toContain('synthetic-connection-value');
    expect(out).toContain(pointerLine());
  });

  it('fix round 1: the hit files are read one at a time, never as an unbounded burst', async () => {
    token.current = 'synthetic-connection-value';
    let inFlight = 0; let most = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith('https://api.github.com/')) return json({ total_count: 3, items: [{ path: 'a.ts', repository: REPO }, { path: 'b.ts', repository: REPO }, { path: 'c.ts', repository: REPO }] });
      inFlight++; most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return text('const taskMovedAtSql = 1;\n');
    });
    const out = await searchSource('taskMovedAtSql');
    expect(out).toContain('a.ts\n  1:');
    expect(out).toContain('c.ts\n  1:');
    expect(most).toBe(1);
  });

  it('REVIEW FOCUS 5: with the connection but GitHub unreachable, a plain sentence and the link', async () => {
    token.current = 'synthetic-connection-value';
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const out = await searchSource('taskMovedAtSql');
    expect(out).toContain('GitHub could not be reached');
    expect(out).toContain(pointerLine());
  });

  it('a refusal from GitHub is GitHub\'s own words, not a throw', async () => {
    token.current = 'synthetic-connection-value';
    fetchMock.mockResolvedValueOnce(json({ message: 'API rate limit exceeded' }, 403));
    const out = await searchSource('taskMovedAtSql');
    expect(out).toContain('HTTP 403');
    expect(out).toContain('GitHub said: API rate limit exceeded');
    expect(out).toContain(pointerLine());
  });
});

describe("the agent's stop reaches every GitHub call (agent/__tests__/no-transport-is-born-stop-blind.test.ts)", () => {
  it('a call made for an agent carries that agent\'s stop, and a stopped agent dials nothing', async () => {
    fetchMock.mockResolvedValueOnce(text('one\n'));
    await readSourceFile('README.md', undefined, undefined, 'agent-inspect-stop');
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);

    const { stoppedAgents } = await import('../../agent/shared-state.js');
    stoppedAgents.add('agent-inspect-stop');
    try {
      fetchMock.mockClear();
      expect(await readSourceFile('README.md', undefined, undefined, 'agent-inspect-stop')).toMatch(/^Stopped: you pressed stop/);
      token.current = 'synthetic-connection-value';
      expect(await searchSource('taskMovedAtSql', undefined, 'agent-inspect-stop')).toMatch(/^Stopped: you pressed stop/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      stoppedAgents.delete('agent-inspect-stop');
    }
  });
});
