import { describe, it, expect } from 'vitest';
import * as deny from '../deny.js';
import * as resolve from '../resolve.js';
import * as index from '../index.js';

describe('the broker exports only helpers something calls', () => {
  it('deny.ts no longer exports the three unused isGlobal*Denied helpers', () => {
    for (const name of ['isGlobalReadDenied', 'isGlobalWriteDenied', 'isGlobalDeleteDenied']) {
      expect(Object.keys(deny), name).not.toContain(name);
      expect(Object.keys(index), name).not.toContain(name);
    }
  });
  it('resolve.ts no longer exports escapesDirectory', () => {
    expect(Object.keys(resolve)).not.toContain('escapesDirectory');
  });
  it('the helpers that ARE used are still exported', () => {
    expect(typeof deny.isSensitivePath).toBe('function');
    expect(typeof deny.isDeniedResource).toBe('function');
    expect(typeof deny.deniedTiers).toBe('function');
    expect(typeof index.isSensitivePath).toBe('function');
    expect(typeof resolve.resolvePathArg).toBe('function');
  });
});
