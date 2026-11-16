// The release script takes one version: a second one is refused instead of silently replacing the first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseScratch } from './release-scratch.mjs';

test('a second version argument is refused before anything runs', () => {
  const box = releaseScratch({ branch: 'Preflight', stable: '3.4.1', released: ['v3.5.0-preflight.3'] });
  try {
    const r = box.run(['3.5.0', '3.9.0', '--preflight', '--dry-run']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /3\.9\.0/);
    assert.equal(box.ghCalls(), '');
  } finally { box.clean(); }
});
