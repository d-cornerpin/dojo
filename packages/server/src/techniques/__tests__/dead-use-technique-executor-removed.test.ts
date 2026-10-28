import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('the dead use_technique executor stays gone', () => {
  it('techniques/tools.ts does not define executeUseTechnique', () => {
    const text = fs.readFileSync(path.join(SRC, 'techniques/tools.ts'), 'utf8');
    expect(/function\s+executeUseTechnique\b/.test(text)).toBe(false);
  });
  it('the live use_technique handler still reads through executeTechniqueRead', () => {
    const text = fs.readFileSync(path.join(SRC, 'agent/tools/cat/techniques.ts'), 'utf8');
    expect(text).toContain('executeTechniqueRead');
  });
});
