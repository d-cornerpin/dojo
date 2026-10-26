// hexToRgb01 turns the colour strings pdf_create / pdf_watermark accept into
// three 0-1 numbers. A three-digit hex like "#fff" must expand to white, and a
// six-character string that is not hex must fall back to black — never reach a
// call site as NaN. The siblings hexToRgb (google/tools-write.ts,
// google/tools-slides.ts) already do both; this pins pdf-tools' copy to the same.

import { describe, it, expect } from 'vitest';
import { hexToRgb01 } from '../pdf-tools.js';

describe('three-digit hex expands', () => {
  it('#fff is white', () => {
    const [r, g, b] = hexToRgb01('#fff');
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(1);
    expect(b).toBeCloseTo(1);
  });
  it('fff is white', () => {
    const [r, g, b] = hexToRgb01('fff');
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(1);
    expect(b).toBeCloseTo(1);
  });
  it('#f80 expands to ff8800', () => {
    const [r, g, b] = hexToRgb01('#f80');
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(0.5333333333); // 0x88 / 255
    expect(b).toBeCloseTo(0);
  });
});

describe('six-digit hex passes through', () => {
  it('ff0000 is red', () => {
    const [r, g, b] = hexToRgb01('ff0000');
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(0);
    expect(b).toBeCloseTo(0);
  });
  it('#00FF80', () => {
    const [r, g, b] = hexToRgb01('#00FF80');
    expect(r).toBeCloseTo(0);
    expect(g).toBeCloseTo(1);
    expect(b).toBeCloseTo(0.5019607843); // 0x80 / 255
  });
  it('336699', () => {
    const [r, g, b] = hexToRgb01('336699');
    expect(r).toBeCloseTo(0.2);
    expect(g).toBeCloseTo(0.4);
    expect(b).toBeCloseTo(0.6);
  });
});

describe('invalid hex falls back to black, never NaN', () => {
  const bad: Array<string | undefined> = ['zzzzzz', '#gg0000', '12345g', '#12345', '#1234567', '', undefined];
  for (const input of bad) {
    it(`returns black and finite for ${JSON.stringify(input)}`, () => {
      const [r, g, b] = hexToRgb01(input);
      expect([r, g, b]).toEqual([0, 0, 0]);
      expect(Number.isFinite(r)).toBe(true);
      expect(Number.isFinite(g)).toBe(true);
      expect(Number.isFinite(b)).toBe(true);
    });
  }
});
