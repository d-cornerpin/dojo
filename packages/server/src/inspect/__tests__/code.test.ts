// v3.5 inspect B4 — the two code views over the GitHub source at the running commit.
// Every GitHub call is mocked; no network call is made.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const token: { current: string | null } = { current: 'synthetic-connection-value' };
vi.mock('../../github/account.js', () => ({ getGithubToken: () => token.current }));

import { codeSearch, codeRead } from '../code.js';
import { getCurrentVersion } from '../../gateway/routes/update.js';

const SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const fetchMock = vi.fn();
const text = (body: string, status = 200): Response => new Response(body, { status });
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
const POINTER = (): string => `Source: https://github.com/d-cornerpin/dojo/tree/${SHA} (the commit this box runs, v${getCurrentVersion()}).`;

beforeEach(() => {
  vi.stubEnv('DOJO_BUILD_SHA', SHA);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  token.current = 'synthetic-connection-value';
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('codeSearch', () => {
  it('renders file:line results grouped by file, from the running commit, with the pointer line', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://api.github.com/search/code')) {
        return json({ total_count: 2, items: [{ path: 'packages/server/src/work/moved.ts' }, { path: 'packages/server/src/tracker/board.ts' }] });
      }
      if (url.endsWith('/work/moved.ts')) return text('// header\nexport function taskMovedAtSql(): string {\n  return "x";\n}\n');
      return text('import { taskMovedAtSql } from "../work/moved.js";\n\nconst q = taskMovedAtSql();\n');
    });
    const out = await codeSearch({ pattern: 'taskMovedAtSql' });
    expect(out).toMatch(/^2 files match "taskMovedAtSql"; lines are from the commit this box runs\./);
    expect(out).toContain('packages/server/src/work/moved.ts\n  2: export function taskMovedAtSql(): string {');
    expect(out).toContain('packages/server/src/tracker/board.ts\n  1: import { taskMovedAtSql } from "../work/moved.js";\n  3: const q = taskMovedAtSql();');
    expect(out.trimEnd().endsWith(POINTER())).toBe(true);
    for (const [url] of fetchMock.mock.calls.slice(1)) expect(String(url)).toContain(`/${SHA}/`);
  });

  it('an empty pattern is a plain sentence and no call', async () => {
    expect(await codeSearch({ pattern: '  ' })).toMatch(/Give a pattern to search for/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('codeRead', () => {
  it('a read by range returns numbered lines, and the pointer names the running commit and version', async () => {
    fetchMock.mockResolvedValueOnce(text(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')));
    const out = await codeRead({ path: 'packages/server/src/work/moved.ts', from: 9, to: 11 });
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://raw.githubusercontent.com/d-cornerpin/dojo/${SHA}/packages/server/src/work/moved.ts`);
    expect(out).toMatch(/^ 9 {2}line 9$/m);
    expect(out).toMatch(/^11 {2}line 11$/m);
    expect(out).not.toMatch(/line 12$/m);
    expect(out).toContain(POINTER());
  });

  it('a range that is not one is a plain sentence and no call', async () => {
    expect(await codeRead({ path: 'a.ts', from: 0 })).toMatch(/from and to are line numbers, starting at 1/);
    expect(await codeRead({ path: 'a.ts', from: 5, to: 2 })).toMatch(/from \(5\) is after to \(2\)/);
    expect(await codeRead({ path: 'a.ts', from: 1.5 })).toMatch(/line numbers/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
