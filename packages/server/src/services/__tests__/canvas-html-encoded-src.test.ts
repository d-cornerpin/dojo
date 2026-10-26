// A local asset whose filename contains a space is referenced in HTML by its
// percent-encoded form ("my%20pic.png"), but resolveRef looked the path up
// literally, so the file was never found and the image stayed broken. resolveRef
// now tries the percent-DECODED path first and falls back to the text as written,
// so "my%20pic.png" finds "my pic.png", while a file literally named "a%20b.png"
// and a malformed "bad%zz.png" resolve the way they did before.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inlineHtmlAssets } from '../canvas-html.js';

// The inliner only base64-encodes whatever bytes the asset file holds, so a
// marker string stands in for an image; we assert on the exact data URI.
const uri = (s: string) => 'data:image/png;base64,' + Buffer.from(s).toString('base64');

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-html-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, contents: string) =>
  fs.writeFileSync(path.join(dir, name), contents);

describe('inlineHtmlAssets — percent-encoded local refs', () => {
  it('inlines a space in the filename given as %20 in an <img src>', () => {
    write('my pic.png', 'PNG');
    write('page.html', '<img src="my%20pic.png">');

    expect(inlineHtmlAssets(path.join(dir, 'page.html'))).toBe(`<img src="${uri('PNG')}">`);
  });

  it('inlines a %20 filename inside a CSS url() ref', () => {
    write('my pic.png', 'PNG');
    write('page.html', '<div style="background:url(my%20pic.png)"></div>');

    expect(inlineHtmlAssets(path.join(dir, 'page.html'))).toContain(`url(${uri('PNG')})`);
  });

  it('still inlines the unencoded filename', () => {
    write('my pic.png', 'PNG');
    write('page.html', '<img src="my pic.png">');

    expect(inlineHtmlAssets(path.join(dir, 'page.html'))).toBe(`<img src="${uri('PNG')}">`);
  });

  it('still inlines a file literally named a%20b.png without decoding it', () => {
    write('a%20b.png', 'LIT');
    write('page.html', '<img src="a%20b.png">');

    expect(inlineHtmlAssets(path.join(dir, 'page.html'))).toBe(`<img src="${uri('LIT')}">`);
  });

  it('leaves a malformed %escape (bad%zz.png) untouched and does not throw', () => {
    write('page.html', '<img src="bad%zz.png">');

    expect(inlineHtmlAssets(path.join(dir, 'page.html'))).toBe('<img src="bad%zz.png">');
  });

  it('strips ?query and #fragment before looking up the decoded file', () => {
    write('a.png', 'Q');
    write('page.html', '<img src="a.png?v=2#x">');

    expect(inlineHtmlAssets(path.join(dir, 'page.html'))).toBe(`<img src="${uri('Q')}">`);
  });
});
