// A helper does not read a project .env or .npmrc, by file tool or by shell, however wide its grants.

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const { scratchDojo, HELPER } = await import('./scratch-dojo.js');
const { home, run, blocked } = await scratchDojo('dotenv-helper', { 'code/site/.env.example': 'PORT=3000\n', 'code/site/.env': 'PORT=3000\n', 'code/site/.npmrc': 'registry=https://registry.example.com/\n' });
const project = path.join(home, 'code', 'site');

describe('a helper cannot read a dotenv file', () => {
  it.each([
    ['file_read', { path: path.join(project, '.env') }],
    ['file_read', { path: path.join(project, '.npmrc') }],
    ['shell', { script: `cat "${project}/.env"` }],
    ['shell', { script: `cd "${project}" && cp .env /tmp/copied-env` }],
  ] as const)('%s is refused', async (name, args) => {
    expect(blocked(await run(HELPER, name, args))).toBe(true);
  });
});
