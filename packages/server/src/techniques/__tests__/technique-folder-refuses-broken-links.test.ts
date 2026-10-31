// No write may land outside the technique folder: a link whose target is missing (final name or any
// parent), or any path whose nearest existing part resolves outside, is refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { insideTechniqueDir } from '../technique-folder.js';

let tmp: string;
let dir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-folder-links-'));
  dir = path.join(tmp, 'tech');
  fs.mkdirSync(dir);
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('insideTechniqueDir and links that lead nowhere', () => {
  it('refuses a broken link as the final name', () => {
    fs.symlinkSync(path.join(tmp, 'missing-target.txt'), path.join(dir, 'out.txt'));
    expect(insideTechniqueDir(dir, 'out.txt')).toBeNull();
  });
  it('refuses a path through a broken link used as a parent folder', () => {
    fs.symlinkSync(path.join(tmp, 'missing-folder'), path.join(dir, 'sub'));
    expect(insideTechniqueDir(dir, 'sub/file.txt')).toBeNull();
  });
  it('refuses a link loop', () => {
    fs.symlinkSync(path.join(dir, 'b'), path.join(dir, 'a'));
    fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'b'));
    expect(insideTechniqueDir(dir, 'a/x.txt')).toBeNull();
  });
  it('still accepts a new nested file and a working link that stays inside', () => {
    fs.mkdirSync(path.join(dir, 'real'));
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'alias'));
    expect(insideTechniqueDir(dir, 'new/deep/file.txt')).toBe(path.join(dir, 'new/deep/file.txt'));
    expect(insideTechniqueDir(dir, 'alias/file.txt')).not.toBeNull();
  });
});
