// The main agent works with a project's .env and .npmrc like any file: `cp .env.example .env` runs, and
// file_read, file_patch and the PDF and Office readers are not refused. Scratch home, made-up contents.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const { scratchDojo, MAIN } = await import('./scratch-dojo.js');
const { home, run, blocked } = await scratchDojo('dotenv-main', { 'code/site/.env.example': 'PORT=3000\n', 'code/site/.env': 'PORT=3000\n', 'code/site/.npmrc': 'registry=https://registry.example.com/\n' });
const project = path.join(home, 'code', 'site');
const dotenv = path.join(project, '.env');

describe('the main agent copies a dotenv file', () => {
  it('cp .env.example .env runs at the shell', async () => {
    fs.rmSync(dotenv);
    expect(blocked(await run(MAIN, 'shell', { script: `cd "${project}" && cp .env.example .env` }))).toBe(false);
    expect(fs.readFileSync(dotenv, 'utf8')).toBe('PORT=3000\n');
  });

  it.each([
    ['file_read', { path: dotenv }],
    ['file_read', { path: path.join(project, '.npmrc') }],
    ['file_patch', { path: dotenv, patches: [{ search: 'PORT=3000', replace: 'PORT=3001' }] }],
    ['pdf_read', { path: dotenv }],
    ['office_read_word_document', { path: dotenv }],
  ] as const)('%s is not refused', async (name, args) => {
    expect(blocked(await run(MAIN, name, args))).toBe(false);
  });
});
