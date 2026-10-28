import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('the unused prompt helpers stay gone', () => {
  it('assembler.ts has no getPromptFilePath', () => {
    expect(/\bgetPromptFilePath\b/.test(read('prompt/assembler.ts'))).toBe(false);
  });
  it('user-profile.ts has no userProfileExists', () => {
    expect(/\buserProfileExists\b/.test(read('prompt/user-profile.ts'))).toBe(false);
  });
  it('registry.ts has no registerAll but still has register', () => {
    const text = read('prompt/registry/registry.ts');
    expect(/\bregisterAll\b/.test(text)).toBe(false);
    expect(text).toContain('export function register(');
  });
});
