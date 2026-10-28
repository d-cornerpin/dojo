// ── Dead code is gone ──
//
// Four functions had no caller anywhere in packages / deploy / scripts /
// watchdog / menubar (grep -rnw), so they were removed. This source scan keeps
// them deleted: a reader re-introducing one fails here instead of the dead
// function quietly accumulating a second copy.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');

describe('dead code is gone', () => {
  it('router/scorer.ts no longer declares extractText', () => {
    expect(read('router/scorer.ts')).not.toMatch(/function extractText\b/);
  });

  it('config/platform.ts no longer declares getPlatformName or isPermanentAgent', () => {
    const platform = read('config/platform.ts');
    expect(platform).not.toMatch(/function getPlatformName\b/);
    expect(platform).not.toMatch(/function isPermanentAgent\b/);
  });

  it('router/semantic.ts no longer declares clearSemanticCache', () => {
    expect(read('router/semantic.ts')).not.toMatch(/function clearSemanticCache\b/);
  });

  it('the live siblings are untouched', () => {
    expect(read('config/platform.ts')).toMatch(/function getOwnerName\b/);
    expect(read('router/semantic.ts')).toMatch(/function classifyTierSemantic\b/);
  });
});
