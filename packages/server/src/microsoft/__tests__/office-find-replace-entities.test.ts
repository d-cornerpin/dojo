// XML entities in stored Word/PowerPoint text are decoded before the find/replace
// runs, so a find holding &, <, > or a stored apostrophe matches what the owner
// typed, and an unmatched node is kept byte-for-byte.

import { describe, it, expect } from 'vitest';
import { replaceTextInDocumentXml, replaceTextInSlideXml } from '../tools-office.js';

const D = '<w:p><w:r><w:t xml:space="preserve">Smith &amp; Sons said 5 &lt; 6</w:t></w:r></w:p>';

describe('replaceTextInDocumentXml — entities in the find', () => {
  it('find "Smith & Sons" replaces the decoded run', () => {
    const { newXml, replacements } = replaceTextInDocumentXml(D, 'Smith & Sons', 'Jones & Co');
    expect(replacements).toBe(1);
    expect(newXml).toBe('<w:p><w:r><w:t xml:space="preserve">Jones &amp; Co said 5 &lt; 6</w:t></w:r></w:p>');
  });

  it('find "5 < 6" replaces the decoded run', () => {
    const { newXml, replacements } = replaceTextInDocumentXml(D, '5 < 6', 'x');
    expect(replacements).toBe(1);
    expect(newXml).toBe('<w:p><w:r><w:t xml:space="preserve">Smith &amp; Sons said x</w:t></w:r></w:p>');
  });

  it('find "&" replaces the decoded ampersand and leaves &lt; intact', () => {
    const { newXml, replacements } = replaceTextInDocumentXml(D, '&', 'and');
    expect(replacements).toBe(1);
    expect(newXml).toBe('<w:p><w:r><w:t xml:space="preserve">Smith and Sons said 5 &lt; 6</w:t></w:r></w:p>');
  });

  it('find "amp" matches nothing, so the file is unchanged byte-for-byte', () => {
    const { newXml, replacements } = replaceTextInDocumentXml(D, 'amp', 'X');
    expect(replacements).toBe(0);
    expect(newXml).toBe(D);
  });

  it('find "Smith" replaces and re-escapes the replacement text', () => {
    const { newXml, replacements } = replaceTextInDocumentXml(D, 'Smith', 'Jones & Co');
    expect(replacements).toBe(1);
    expect(newXml).toBe('<w:p><w:r><w:t xml:space="preserve">Jones &amp; Co &amp; Sons said 5 &lt; 6</w:t></w:r></w:p>');
  });
});

describe('replaceTextInDocumentXml — a stored apostrophe', () => {
  it('find "it\'s" replaces the decoded apostrophe', () => {
    const xml = '<w:t>it&apos;s fine</w:t>';
    const { newXml, replacements } = replaceTextInDocumentXml(xml, "it's", 'it is');
    expect(replacements).toBe(1);
    expect(newXml).toContain('it is fine');
  });
});

describe('replaceTextInDocumentXml — nothing matched stays byte-for-byte', () => {
  it('an unmatched find leaves the node unchanged', () => {
    const xml = '<w:t>say "hi" now</w:t>';
    const { newXml, replacements } = replaceTextInDocumentXml(xml, 'zzz', 'q');
    expect(replacements).toBe(0);
    expect(newXml).toBe(xml);
  });

  it('an empty find leaves the document unchanged', () => {
    const { newXml, replacements } = replaceTextInDocumentXml(D, '', 'q');
    expect(replacements).toBe(0);
    expect(newXml).toBe(D);
  });
});

describe('replaceTextInSlideXml — entities in the find', () => {
  const S = '<a:p><a:r><a:t>AT&amp;T and R&amp;D</a:t></a:r></a:p>';

  it('find "AT&T" replaces the decoded run', () => {
    const { newXml, replacements } = replaceTextInSlideXml(S, 'AT&T', 'Verizon');
    expect(replacements).toBe(1);
    expect(newXml).toBe('<a:p><a:r><a:t>Verizon and R&amp;D</a:t></a:r></a:p>');
  });

  it('find "R&D" replaces the decoded run', () => {
    const { newXml, replacements } = replaceTextInSlideXml(S, 'R&D', 'Research');
    expect(replacements).toBe(1);
    expect(newXml).toBe('<a:p><a:r><a:t>AT&amp;T and Research</a:t></a:r></a:p>');
  });
});
