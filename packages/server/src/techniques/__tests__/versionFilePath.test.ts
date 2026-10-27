// versionFilePath joins a technique directory, the versions subdirectory and the
// version number into the snapshot's markdown path.

import { describe, it, expect } from 'vitest';
import { versionFilePath } from '../versioning.js';

describe('versionFilePath', () => {
  it.each([
    ['/a/b', 1, '/a/b/versions/TECHNIQUE_v1.md'],
    ['/a/b', 12, '/a/b/versions/TECHNIQUE_v12.md'],
    ['/x', 0, '/x/versions/TECHNIQUE_v0.md'],
    ['', 5, 'versions/TECHNIQUE_v5.md'],
    ['/a/b', 7, '/a/b/versions/TECHNIQUE_v7.md'],
    ['/a/b', 123, '/a/b/versions/TECHNIQUE_v123.md'],
  ])('versionFilePath(%j, %j) -> %j', (dir, version, expected) => {
    expect(versionFilePath(dir, version)).toBe(expected);
  });
});
