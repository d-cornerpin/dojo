import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('two unused helpers stay gone', () => {
  it('registry/assembler.ts has no renderMessageEntryById', () => {
    expect(/\brenderMessageEntryById\b/.test(read('prompt/registry/assembler.ts'))).toBe(false);
  });
  it('aliases.ts has no isToolAlias but still resolves aliases', () => {
    const text = read('tools/aliases.ts');
    expect(/\bisToolAlias\b/.test(text)).toBe(false);
    expect(text).toContain('export function resolveToolAlias(');
  });
  it('the live registry helpers are still exported', () => {
    const text = read('prompt/registry/assembler.ts');
    expect(text).toContain('export function renderMessageEntry(');
    expect(text).toContain('export function injectRegistryMessage(');
  });
});
