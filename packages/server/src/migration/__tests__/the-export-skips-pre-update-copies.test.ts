// The export carries the owner's data, not copies of the program: the database copies taken before
// updates, set-aside builds and the rollback lock stay behind, and an export that cannot fit is refused first.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../../home.js';

const free = vi.hoisted(() => ({ bytes: null as number | null }));
vi.mock('../../update/disk-preflight.js', async (orig) => ({
  ...(await orig<typeof import('../../update/disk-preflight.js')>()),
  freeBytesAt: () => free.bytes,
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../db/connection.js', () => ({ getDb: () => { throw new Error('the export started staging'); } }));

import { copyDojoTree, createExport } from '../export.js';

const put = (root: string, rel: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), 'x');
};

describe('the export skips pre-update copies', () => {
  it('leaves out database copies, set-aside builds and the rollback lock', () => {
    const src = fs.mkdtempSync(path.join(homeDir(), 'src-'));
    const dest = fs.mkdtempSync(path.join(homeDir(), 'dest-'));
    for (const rel of [
      'data/backups/dojo-pre-1-of-2.db', 'data/notes.json', 'uploads/a.txt',
      'platform.backup-3.4.1/x', 'platform.failed-1/x', 'platform.staging/x', 'watchdog.old-1/x', 'rollback.lock',
    ]) put(src, rel);

    copyDojoTree(src, dest);

    expect(fs.readdirSync(dest).sort()).toEqual(['data', 'uploads']);
    expect(fs.readdirSync(path.join(dest, 'data'))).toEqual(['notes.json']);
  });

  it('refuses before staging anything when the disk cannot hold it', async () => {
    put(path.join(homeDir(), '.dojo'), 'data/dojo.db');
    free.bytes = 1;
    await expect(createExport('password-for-test')).rejects.toThrow(/Not enough free disk space/);
  });
});
