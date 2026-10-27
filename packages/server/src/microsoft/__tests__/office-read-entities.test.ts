// The three Office readers decode XML entities before the model sees text, so a
// cell reads AT&T not AT&amp;T, and a double-encoded &amp;lt; decodes once to the
// text &lt; (not <).

import { describe, it, expect } from 'vitest';
import { paragraphPreview, extractTableText, extractSlideText } from '../tools-office.js';

describe('paragraphPreview — entities in the text', () => {
  it('decodes every stored entity in the run', () => {
    const out = paragraphPreview('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Q&amp;A &lt;draft&gt; &quot;final&quot; it&apos;s</w:t></w:r></w:p>');
    expect(out).toEqual({ text: 'Q&A <draft> "final" it\'s', isHeading: true, level: 1 });
  });

  it('decodes a double-encoded entity exactly once', () => {
    const out = paragraphPreview('<w:p><w:r><w:t>&amp;lt;</w:t></w:r></w:p>');
    expect(out.text).toBe('&lt;');
  });

  it('leaves plain text and a raw & untouched', () => {
    expect(paragraphPreview('<w:p><w:r><w:t>no entities here</w:t></w:r></w:p>').text).toBe('no entities here');
    expect(paragraphPreview('<w:p><w:r><w:t>A & B</w:t></w:r></w:p>').text).toBe('A & B');
  });
});

describe('extractTableText — entities in the cells', () => {
  it('decodes every stored entity in each cell', () => {
    const rows = extractTableText('<w:tbl><w:tr><w:tc><w:p><w:r><w:t>AT&amp;T</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>5 &gt; 3</w:t></w:r></w:p></w:tc></w:tr></w:tbl>');
    expect(rows).toEqual([['AT&T', '5 > 3']]);
  });
});

describe('extractSlideText — entities in the slide', () => {
  it('decodes the title and the body', () => {
    const slide = '<p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>R&amp;D plan</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>Profit &amp; loss &lt; 5%</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>';
    const out = extractSlideText(slide);
    expect(out).toEqual({ title: 'R&D plan', body: ['Profit & loss < 5%'] });
  });
});
