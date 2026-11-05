// v3.5 field fix 3, audit round (#4). The owner, 2026-11-04 (verbatim): "I fucking LOVE when the agent
// tells the user "do it yourself"." (he is furious when it does). The update-swap failure and the
// uninstall script state what happened and what is where; they do not hand him a command to run.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../../..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');

describe('update and uninstall text states facts, never a chore', () => {
  it('a failed swap says which version runs, and does not tell the owner to run rollback.sh', () => {
    const src = read('packages/server/src/update/install-tree.ts');
    expect(src).toContain('stopped while switching versions');
    expect(src).not.toMatch(/run ~\/\.dojo\/scripts\/rollback\.sh/);
  });

  it('uninstall does not tell the owner to run start.sh or brew commands', () => {
    const src = read('deploy/uninstall.sh');
    expect(src).not.toMatch(/Run ~\/\.dojo\/scripts\/start\.sh/);
    expect(src).not.toMatch(/brew uninstall/);
  });
});
