// PAGE_SIZES_DXA is the table generateWordBuffer looks up for the Word-creation
// tool's page_size argument. Each value is page dimensions in DXA (1440 DXA =
// 1 inch), so a size is right exactly when width and height are its physical
// dimensions in inches times 1440.

import { describe, it, expect } from 'vitest';
import { PAGE_SIZES_DXA } from '../tools-office.js';

const DXA_PER_INCH = 1440;

describe('PAGE_SIZES_DXA — the Word page_size table', () => {
  it('letter is 8.5 x 11 inches', () => {
    expect(PAGE_SIZES_DXA.letter.width).toBe(8.5 * DXA_PER_INCH); // 12240
    expect(PAGE_SIZES_DXA.letter.height).toBe(11 * DXA_PER_INCH); // 15840
  });

  it('legal is 8.5 x 14 inches', () => {
    expect(PAGE_SIZES_DXA.legal.width).toBe(8.5 * DXA_PER_INCH);  // 12240
    expect(PAGE_SIZES_DXA.legal.height).toBe(14 * DXA_PER_INCH);  // 20160
  });

  it('tabloid is 11 x 17 inches', () => {
    expect(PAGE_SIZES_DXA.tabloid.width).toBe(11 * DXA_PER_INCH);  // 15840
    expect(PAGE_SIZES_DXA.tabloid.height).toBe(17 * DXA_PER_INCH); // 24480
  });

  it('a4 is the rounded DXA of 210 x 297 mm', () => {
    expect(PAGE_SIZES_DXA.a4.width).toBe(Math.round((210 / 25.4) * DXA_PER_INCH)); // 11906
    expect(PAGE_SIZES_DXA.a4.height).toBe(Math.round((297 / 25.4) * DXA_PER_INCH)); // 16838
  });

  it('every entry is portrait and the keys are exactly the four sizes', () => {
    expect(Object.keys(PAGE_SIZES_DXA).sort()).toEqual(['a4', 'legal', 'letter', 'tabloid']);
    for (const [key, size] of Object.entries(PAGE_SIZES_DXA)) {
      expect(size.height, `${key} must be portrait`).toBeGreaterThan(size.width);
    }
  });
});
