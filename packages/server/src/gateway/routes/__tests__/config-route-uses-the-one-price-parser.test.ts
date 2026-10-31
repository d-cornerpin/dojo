import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../config.ts', import.meta.url), 'utf8');

describe('the provider-validate route reads prices through the one shared parser', () => {
  it('holds no inline copy of parsePrice', () => {
    expect(src).not.toMatch(/const parsePrice\s*=/);
  });
  it('imports parsePrice from services/price-per-million', () => {
    expect(src).toMatch(/import \{ parsePrice \} from '\.\.\/\.\.\/services\/price-per-million\.js';/);
  });
});
