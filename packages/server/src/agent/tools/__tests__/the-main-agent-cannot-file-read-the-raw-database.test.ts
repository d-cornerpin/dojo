// The owner's ruling stands: the raw database file is not read through the file tools, by the main
// agent either, nor its backup copies.

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const { scratchDojo, MAIN } = await import('./scratch-dojo.js');
const RAW = ['.dojo/data/dojo.db-wal', '.dojo/backups/dojo-old.db'];
const { home, run, blocked } = await scratchDojo('raw-db', Object.fromEntries(RAW.map((rel) => [rel, 'not a real database'])));

describe('the main agent cannot file_read the raw database', () => {
  it.each(['.dojo/data/dojo.db', ...RAW])('%s', async (rel) => {
    expect(blocked(await run(MAIN, 'file_read', { path: path.join(home, rel) }))).toBe(true);
  });
});
