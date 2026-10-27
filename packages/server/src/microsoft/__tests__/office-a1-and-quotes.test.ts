import { describe, it, expect } from 'vitest';
import {
  colLettersToIndex,
  columnIndexToLetter,
  parseA1Range,
  splitDocumentXml,
  xmlEscape,
  smartenQuotes,
  contentWidthDxa,
} from '../tools-office.js';

describe('colLettersToIndex — A1 column letters to a 1-based index', () => {
  it('maps single and multi-letter columns', () => {
    expect(colLettersToIndex('A')).toBe(1);
    expect(colLettersToIndex('Z')).toBe(26);
    expect(colLettersToIndex('AA')).toBe(27);
    expect(colLettersToIndex('AB')).toBe(28);
    expect(colLettersToIndex('XFD')).toBe(16384);
  });
  it('is case-insensitive', () => {
    expect(colLettersToIndex('az')).toBe(52);
  });
});

describe('columnIndexToLetter — a 0-based index to A1 letters', () => {
  it('maps the wrapped column boundaries', () => {
    expect(columnIndexToLetter(0)).toBe('A');
    expect(columnIndexToLetter(1)).toBe('B');
    expect(columnIndexToLetter(25)).toBe('Z');
    expect(columnIndexToLetter(26)).toBe('AA');
    expect(columnIndexToLetter(27)).toBe('AB');
    expect(columnIndexToLetter(51)).toBe('AZ');
    expect(columnIndexToLetter(52)).toBe('BA');
    expect(columnIndexToLetter(701)).toBe('ZZ');
    expect(columnIndexToLetter(702)).toBe('AAA');
    expect(columnIndexToLetter(16383)).toBe('XFD');
  });
  it('is the inverse of colLettersToIndex across the low range', () => {
    for (let i = 0; i <= 800; i++) {
      expect(colLettersToIndex(columnIndexToLetter(i))).toBe(i + 1);
    }
  });
});

describe('parseA1Range — a range string into 1-based inclusive bounds', () => {
  it('parses a single cell and an open range', () => {
    expect(parseA1Range('A1')).toEqual({ startRow: 1, startCol: 1, endRow: 1, endCol: 1 });
    expect(parseA1Range('A1:C3')).toEqual({ startRow: 1, startCol: 1, endRow: 3, endCol: 3 });
  });
  it('strips absolute-reference dollars and orders the bounds', () => {
    expect(parseA1Range('$B$2:$B$10')).toEqual({ startRow: 2, startCol: 2, endRow: 10, endCol: 2 });
    expect(parseA1Range('c3:a1')).toEqual({ startRow: 1, startCol: 1, endRow: 3, endCol: 3 });
  });
  it('handles a multi-letter column', () => {
    expect(parseA1Range('AA10')).toEqual({ startRow: 10, startCol: 27, endRow: 10, endCol: 27 });
  });
  it('rejects malformed ranges with null', () => {
    expect(parseA1Range('a1:b')).toBeNull();
    expect(parseA1Range('Sheet1!A1')).toBeNull();
    expect(parseA1Range('A')).toBeNull();
    expect(parseA1Range('1')).toBeNull();
    expect(parseA1Range('')).toBeNull();
  });
});

describe('xmlEscape — escapes a string for XML content', () => {
  it('escapes ampersand, angle brackets and both quote kinds', () => {
    expect(xmlEscape('a&b <c> "d" \'e\'')).toBe('a&amp;b &lt;c&gt; &quot;d&quot; &apos;e&apos;');
  });
  it('leaves the empty string alone', () => {
    expect(xmlEscape('')).toBe('');
  });
});

describe('smartenQuotes — straight quotes to curly', () => {
  it('pairs double and single quotes by opener/closer position', () => {
    expect(smartenQuotes('He said "hi" to us')).toBe('He said “hi” to us');
    expect(smartenQuotes("It's fine")).toBe('It’s fine');
    expect(smartenQuotes("'quoted' text")).toBe('‘quoted’ text');
    expect(smartenQuotes('("a") [\'b\']')).toBe('(“a”) [‘b’]');
    expect(smartenQuotes('"start')).toBe('“start');
    expect(smartenQuotes('end"')).toBe('end”');
  });
  it('leaves the empty string alone', () => {
    expect(smartenQuotes('')).toBe('');
  });
});

describe('contentWidthDxa — usable page width in DXA', () => {
  it('subtracts two margins of inches x 1440', () => {
    expect(contentWidthDxa(12240, 1)).toBe(9360);
    expect(contentWidthDxa(11906, 0.5)).toBe(10466);
  });
});

describe('splitDocumentXml — splits a Word document.xml at the body and sectPr', () => {
  it('keeps the leading sectPr with the suffix', () => {
    const parts = splitDocumentXml(
      '<w:document><w:body><w:p><w:r><w:t>One</w:t></w:r></w:p><w:sectPr><w:pgSz/></w:sectPr></w:body></w:document>',
    );
    expect(parts.prefix).toBe('<w:document><w:body>');
    expect(parts.bodyInner).toBe('<w:p><w:r><w:t>One</w:t></w:r></w:p>');
    expect(parts.suffix).toBe('<w:sectPr><w:pgSz/></w:sectPr></w:body></w:document>');
  });
  it('tolerates the absence of a sectPr', () => {
    const parts = splitDocumentXml('<d><w:body><w:p>a</w:p></w:body></d>');
    expect(parts.prefix).toBe('<d><w:body>');
    expect(parts.bodyInner).toBe('<w:p>a</w:p>');
    expect(parts.suffix).toBe('</w:body></d>');
  });
  it('throws when the body markers are missing', () => {
    expect(() => splitDocumentXml('<w:document></w:document>')).toThrow(/Malformed document.xml/);
  });
});
