// `parseBodyBlocks` cuts `<w:body>` into the top-level blocks that the Word tools then
// number, insert between and delete from, and a rebuild joins those blocks back together.
// So a block list that drops or mis-cuts a child saves a SHORTER document. These clauses pin
// the scanner on children it used to trip over: a self-closing paragraph, a nested table, a
// text box, a content control, a bookmark.

import { describe, it, expect } from 'vitest';
import { parseBodyBlocks } from '../tools-office.js';

const A = '<w:p><w:r><w:t>A</w:t></w:r></w:p>';
const B = '<w:p><w:r><w:t>B</w:t></w:r></w:p>';
const C = '<w:p><w:r><w:t>C</w:t></w:r></w:p>';
const NEST = '<w:tbl><w:tr><w:tc><w:tbl><w:tr><w:tc>' + A + '</w:tc></w:tr></w:tbl>' + B + '</w:tc></w:tr></w:tbl>';
const TX = '<w:p><w:r><w:pict><w:txbxContent><w:p><w:r><w:t>inner</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p>';
const SDT = '<w:sdt><w:sdtContent>' + B + '</w:sdtContent></w:sdt>';
const EMPTY_P = '<w:p/>';
const EMPTY_P_ATTR = '<w:p w:rsidR="00AB"/>';
const BOOKMARK_START = '<w:bookmarkStart w:id="0" w:name="x"/>';
const BOOKMARK_END = '<w:bookmarkEnd w:id="0"/>';
const WITH_PPR = '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>';
const SPACED = `${A}\n  ${B}\n   ${C}\n`;

describe('parseBodyBlocks', () => {
  it('splits plain paragraphs, ignoring the whitespace between children', () => {
    expect(parseBodyBlocks(A + B + C)).toEqual([A, B, C]);
    expect(parseBodyBlocks(SPACED)).toEqual([A, B, C]);
  });

  it('gives a self-closing paragraph its own block', () => {
    expect(parseBodyBlocks(A + EMPTY_P + B + C)).toEqual([A, EMPTY_P, B, C]);
    expect(parseBodyBlocks(A + EMPTY_P_ATTR + B)).toEqual([A, EMPTY_P_ATTR, B]);
  });

  it('ends a table at its own close tag, not at a nested table\'s', () => {
    expect(parseBodyBlocks(NEST + C)).toEqual([NEST, C]);
  });

  it('ends a paragraph holding a text box at its own close tag', () => {
    expect(parseBodyBlocks(TX + B)).toEqual([TX, B]);
  });

  it('makes a content control its own block', () => {
    expect(parseBodyBlocks(A + SDT + C)).toEqual([A, SDT, C]);
  });

  it('makes a bookmark its own block', () => {
    expect(parseBodyBlocks(A + BOOKMARK_START + B + BOOKMARK_END + C))
      .toEqual([A, BOOKMARK_START, B, BOOKMARK_END, C]);
  });

  it('keeps a paragraph with properties as one block', () => {
    expect(parseBodyBlocks(WITH_PPR + C)).toEqual([WITH_PPR, C]);
  });

  it('returns no blocks for an empty body', () => {
    expect(parseBodyBlocks('')).toEqual([]);
  });

  it('joins back to the input, minus the whitespace between children', () => {
    const inputs: Array<[string, string]> = [
      [A + B + C, A + B + C],
      [SPACED, A + B + C],
      [A + EMPTY_P + B + C, A + EMPTY_P + B + C],
      [A + EMPTY_P_ATTR + B, A + EMPTY_P_ATTR + B],
      [NEST + C, NEST + C],
      [TX + B, TX + B],
      [A + SDT + C, A + SDT + C],
      [A + BOOKMARK_START + B + BOOKMARK_END + C, A + BOOKMARK_START + B + BOOKMARK_END + C],
      [WITH_PPR + C, WITH_PPR + C],
      ['', ''],
    ];
    for (const [body, rebuilt] of inputs) {
      expect(parseBodyBlocks(body).join(''), `rebuilding ${body}`).toBe(rebuilt);
    }
  });
});
