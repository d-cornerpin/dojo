// The start-up sweep removes a dead installer's work dir once it is older than one install
// attempt, keeps a live installer's and a just-started one's, and always settles.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanUpdateLeftovers } from '../leftovers.js';
import { INSTALL_CEILING_MS } from '../install-tree.js';

const DEAD_PID = 2147483646;
const NOW = 1_800_000_000_000;
let box = '';
afterEach(() => { if (box) fs.rmSync(box, { recursive: true, force: true }); box = ''; });

const staging = (dojo: string, pid: number, startedMs: number): string => {
  const dir = path.join(dojo, `platform.staging-${pid}-${startedMs}`);
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'half.js'), 'half a copy');
  return dir;
};

describe('a dead installer\'s folder is removed and boot is not blocked', () => {
  it('removes only the dead installer\'s folder that outlived one attempt', async () => {
    box = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'leftovers-'));
    const dojo = path.join(box, '.dojo');
    const old = staging(dojo, DEAD_PID, NOW - INSTALL_CEILING_MS - 1);
    const recent = staging(dojo, DEAD_PID, NOW - 1_000);
    const live = staging(dojo, process.pid, NOW - INSTALL_CEILING_MS - 1);

    const res = await cleanUpdateLeftovers(dojo, NOW);

    expect(res).toEqual({ deleted: [path.basename(old)], failed: [] });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(live)).toBe(true);
  });

  it('settles on a home with no install folder at all', async () => {
    box = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'leftovers-'));
    await expect(cleanUpdateLeftovers(path.join(box, 'missing'), NOW)).resolves.toEqual({ deleted: [], failed: [] });
  });
});
