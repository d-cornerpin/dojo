// `DRY_RUN=1 bash deploy/release.sh` is not a dry run: the script refuses before it asks GitHub anything and
// says to use the --dry-run flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseScratch } from './release-scratch.mjs';

test('DRY_RUN in the environment is refused before anything runs', () => {
  const box = releaseScratch({ branch: 'main', stable: '3.4.1', released: [] });
  try {
    const r = box.run(['3.5.0'], { DRY_RUN: '1' });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /--dry-run flag/);
    assert.equal(box.ghCalls(), '');
  } finally { box.clean(); }
});
