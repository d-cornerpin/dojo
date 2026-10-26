// Unit tests for agent/html-text.ts — the pure HTML → text transform that
// `web_fetch` hands an agent. Two contracts these pin:
//  - entities decode in ONE pass, so a decoded value is never decoded again
//    (`&amp;lt;` must stay `&lt;`, not collapse to `<`).
//  - <li> and <br> match with optional attributes (`<li class="x">` keeps its
//    bullet, `<br class="x">` still breaks the line).

import { describe, it, expect } from 'vitest';
import { stripHtmlTags } from '../html-text.js';

describe('stripHtmlTags — entity decoding in a single pass', () => {
  it('a double-encoded entity is decoded once, not twice', () => {
    // The page literally shows `&lt;b&gt;`; in the HTML that arrives as
    // `&amp;lt;b&amp;gt;`. One pass must leave it as `&lt;b&gt;`.
    expect(stripHtmlTags('a &amp;lt;b&amp;gt; c')).toBe('a &lt;b&gt; c');
  });

  it('single-encoded entities still decode (the one-pass change must not break these)', () => {
    expect(stripHtmlTags('Tom &amp; Jerry &lt;3')).toBe('Tom & Jerry <3');
  });

  it('quot, #39 and nbsp decode together (nbsp stays a space)', () => {
    expect(stripHtmlTags('&quot;hi&quot; &#39;x&#39;&nbsp;y')).toBe('"hi" \'x\' y');
  });
});

describe('stripHtmlTags — list items and line breaks keep their attributes', () => {
  it('an <li> with attributes keeps its bullet, and so does an uppercase one', () => {
    const out = stripHtmlTags('<ul><li class="x">one</li><LI>two</LI></ul>');
    expect(out).toContain('- one');
    expect(out).toContain('- two');
    expect(out).toBe('- one\n- two'); // separate lines
  });

  it('a <br> with attributes still breaks the line', () => {
    expect(stripHtmlTags('a<br class="x">b')).toBe('a\nb');
  });
});

describe('stripHtmlTags — markup removal and paragraph breaks', () => {
  it('a script block and a comment are removed', () => {
    expect(stripHtmlTags('<script>secret()</script>hello<!-- note -->world')).toBe('helloworld');
  });

  it('paragraph tags leave a blank line between paragraphs', () => {
    expect(stripHtmlTags('<p>a</p><p>b</p>')).toBe('a\n\nb');
  });
});
