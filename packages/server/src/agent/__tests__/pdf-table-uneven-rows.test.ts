// v35 — renderTable must treat every row as exactly `cols` cells, padding a
// short row with empty cells, instead of indexing a per-row cellLines array
// past its end (which threw `lines is not iterable` on ragged tables).
import { describe, it, expect } from 'vitest';
import { renderTable } from '../pdf-tools.js';

// A font whose width grows linearly with string length — deterministic, no real
// pdf-lib font metrics needed. Used for font, fontBold and fontItalic.
function makeFont() {
  return { widthOfTextAtSize: (s: string, size: number) => s.length * size * 0.5 };
}

// A page that records what the renderer asked of it: text strings in draw order,
// and a count of header-shading vs. border rectangles (a rectangle with a
// `color` option is header shading; one with `borderColor` is a border).
function makePage() {
  const records = { texts: [] as string[], shading: 0, borders: 0 };
  const page = {
    drawText: (text: string) => { records.texts.push(text); },
    drawRectangle: (opts: { color?: unknown; borderColor?: unknown }) => {
      if (opts.color) records.shading++;
      else if (opts.borderColor) records.borders++;
    },
    drawLine: () => {},
  };
  return { page, records };
}

function makeCtx(page: object) {
  const font = makeFont();
  return {
    font, fontBold: font, fontItalic: font,
    pageW: 612, pageH: 792, marginPt: 72, defaultSize: 12,
    pages: [page], currentPage: page, cursorY: 700,
    pdfDoc: { addPage: () => page },
    options: {},
  };
}

// Renders `rows` through renderTable and returns the recorded page calls plus the
// ending cursorY. Throws if the renderer throws.
function runTable(rows: string[][]) {
  const { page, records } = makePage();
  const ctx = makeCtx(page);
  renderTable(ctx, { type: 'table' as const, rows });
  return { records, cursorY: ctx.cursorY };
}

describe('renderTable with uneven rows', () => {
  it('even rows draw every cell, 3 shading + 6 borders, cursorY ~646.4', () => {
    const { records, cursorY } = runTable([['A', 'B', 'C'], ['1', '2', '3']]);
    expect(records.texts).toEqual(['A', 'B', 'C', '1', '2', '3']);
    expect(records.shading).toBe(3);
    expect(records.borders).toBe(6);
    expect(cursorY).toBeCloseTo(646.4, 5);
  });

  it('a short last row is padded and does not throw', () => {
    let result: ReturnType<typeof runTable> | undefined;
    expect(() => { result = runTable([['A', 'B', 'C'], ['1', '2']]); }).not.toThrow();
    expect(result!.records.texts.filter((t) => t !== '')).toEqual(['A', 'B', 'C', '1', '2']);
    expect(result!.records.shading).toBe(3);
    expect(result!.records.borders).toBe(6);
    expect(result!.cursorY).toBeCloseTo(646.4, 5);
  });

  it('a short first row is padded and every cell text is drawn', () => {
    let result: ReturnType<typeof runTable> | undefined;
    expect(() => { result = runTable([['A'], ['1', '2', '3']]); }).not.toThrow();
    expect(result!.records.texts.filter((t) => t !== '')).toEqual(['A', '1', '2', '3']);
  });

  it('an empty row gets a normal height and does not throw', () => {
    let result: ReturnType<typeof runTable> | undefined;
    expect(() => { result = runTable([['A', 'B'], []]); }).not.toThrow();
    expect(Number.isFinite(result!.cursorY)).toBe(true);
    expect(result!.cursorY).toBeLessThan(700);
  });

  it('no rows and only-empty rows draw nothing and do not throw', () => {
    const empties: string[][][] = [[], [[]]];
    for (const rows of empties) {
      let result: ReturnType<typeof runTable> | undefined;
      expect(() => { result = runTable(rows); }).not.toThrow();
      expect(result!.records.texts).toEqual([]);
      expect(result!.records.shading).toBe(0);
      expect(result!.records.borders).toBe(0);
    }
  });
});
