// ════════════════════════════════════════════════════════════════════════════════════════
// Final round (proofed release notes; owner rule: the Dojo or the agent does the work, never "do it yourself").
//   1. A failed import: the import route STOPS the agents' runs (it never terminates them), so a failed import brings
//      them back; its card states the fact only (the words are pinned in migration/__tests__).
//   2. The rollback's end text: the Dojo prunes kept failed builds itself, so no "delete it once you no longer need it".
//   3. The uninstall banner: uninstall is his own act, so its instructions stay; only the line asking him to start a
//      service the uninstaller could start itself goes (it tries, then states the fact).
//   4. IF-AN-UPDATE-FAILS.md line 150: no em-dash (the file's commands stay; it is for a box the Dojo cannot run on).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('the Dojo does the recovery work itself', () => {
  it('1: the import route stops agent runs and never terminates the agents', () => {
    const src = read('packages/server/src/gateway/routes/migration.ts');
    const stop = /const stopServices = async \(\) => \{[\s\S]*?\n {4}\};/.exec(src)?.[0] ?? '';
    expect(stop.length, 'found').toBeGreaterThan(0);
    expect(stop).not.toMatch(/terminateAgent\(/);
    expect(stop).toMatch(/stopAgentRunsForImport\(/);
  });

  it('2: the rollback end text leaves no chore', () => {
    const src = read('deploy/scripts/rollback.sh');
    expect(src).not.toMatch(/once you no longer need it/);
    expect(src).toMatch(/kept at \$\(basename "\$failed_dir"\) for diagnosis/);
  });

  it('3: the uninstaller starts a service itself before saying it did not start, and asks him nothing', () => {
    const src = read('deploy/uninstall.sh');
    const fn = /restart_services\(\) \{[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    expect(fn).toMatch(/scripts\/start\.sh/);
    expect(fn).not.toMatch(/Run ~\/\.dojo\/scripts\/start\.sh|restart Dojo from the menu bar/);
  });

  it('4: IF-AN-UPDATE-FAILS.md line 150 carries no em-dash', () => {
    const line = read('deploy/scripts/IF-AN-UPDATE-FAILS.md').split('\n')[149];
    expect(line).toContain('MIGRATION DIVERGENCE 129b');
    expect(line).not.toContain('—');
  });
});
