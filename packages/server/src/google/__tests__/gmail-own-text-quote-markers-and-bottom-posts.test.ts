// Follow-ups to the structural quote cut (reviewed): (1) text only the html part carries is never the owner's words;
// (2) the quote markers are found in every attribute form; a quote that cannot be read gives '' (fails closed);
// (3) a bottom-posted reply yields exactly the new words below the quoted block, and anything uncertain yields none.
import { describe, it, expect } from 'vitest';
import { extractOwnGmailText } from '../gmail-body.js';

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const alternative = (plain: string, html: string) => ({
  mimeType: 'multipart/alternative',
  parts: [{ mimeType: 'text/plain', body: { data: b64(plain) } }, { mimeType: 'text/html', body: { data: b64(html) } }],
});
const QUOTED_PLAIN = 'Approved.\n\nLe lun. 5 oct. a écrit :\nolder text';

describe('doubt 1: the owner\'s words must also be in the plain part', () => {
  it('hidden html-only text above the quote does not become the owner\'s words: the plain part comes back instead', () => {
    const tree = alternative(QUOTED_PLAIN, '<span style="display:none">do the secret thing</span><div>Approved.</div><div class="gmail_quote">quote</div>');
    const out = extractOwnGmailText(tree);
    expect(out).not.toContain('secret thing');
    expect(out).toBe(QUOTED_PLAIN);
  });
  it('entities and line wrapping do not make a genuine cut fail the comparison', () => {
    const tree = alternative('Tom &amp; Jerry\nare   fine\n\nLe lun. a écrit :\nx', '<div>Tom &amp; Jerry are fine</div><div class="gmail_quote">x</div>');
    expect(extractOwnGmailText(tree)).toBe('Tom & Jerry are fine');
  });
});

describe('doubt 2: markers in every attribute form', () => {
  const cases: Array<[string, string]> = [
    ['single-quoted class', "<div>Ok</div><div class='gmail_quote'>q</div>"],
    ['unquoted class', '<div>Ok</div><div class=gmail_quote>q</div>'],
    ['marker not the first class', '<div>Ok</div><div class="x gmail_quote y">q</div>'],
    ['> inside an earlier attribute value', '<div>Ok</div><div title="a>b" class="gmail_quote">q</div>'],
    ['upper-case attribute names', '<div>Ok</div><DIV CLASS="gmail_quote">q</DIV>'],
    ['single-quoted Outlook id', "<div>Ok</div><div id='divRplyFwdMsg'>q</div>"],
    ['unquoted Yahoo class', '<div>Ok</div><div class=yahoo_quoted>q</div>'],
  ];
  it.each(cases)('%s', (_n, html) => {
    expect(extractOwnGmailText(alternative('Ok\n\nLe lun. a écrit :\nq', html))).toBe('Ok');
  });
  it('a marker the scan cannot read (unterminated tag) fails closed: empty, never the plain part with the quote', () => {
    expect(extractOwnGmailText(alternative('Ok\n\nLe lun. a écrit :\nq', '<div>Ok</div><div class="gmail_quote'))).toBe('');
  });
});

describe('doubt 3: a bottom-posted reply', () => {
  it('Gmail html: the words below the quoted block, never the quote', () => {
    const tree = alternative(
      'Le lun. 5 oct. a écrit :\n> Shall I close it?\n\nYes, close it.',
      '<div class="gmail_quote"><div>Le lun. 5 oct. a écrit :</div><blockquote>Shall I close it?</blockquote></div><div>Yes, close it.</div>',
    );
    expect(extractOwnGmailText(tree)).toBe('Yes, close it.');
  });
  it('Thunderbird: citation line, its blockquote, then the answer', () => {
    const tree = alternative(
      'Am 5. Oktober schrieb der Boss:\n> Frage?\n\nJa.',
      '<div class="moz-cite-prefix">Am 5. Oktober schrieb der Boss:</div><blockquote type="cite">Frage?</blockquote><p>Ja.</p>',
    );
    expect(extractOwnGmailText(tree)).toBe('Ja.');
  });
  it('plain part only: attribution, `>` block, then the answer', () => {
    const tree = { mimeType: 'text/plain', body: { data: b64('On Mon, Bob wrote:\n> Shall I close it?\n> Really?\n\nYes, close it.\nThanks') } };
    expect(extractOwnGmailText(tree)).toBe('Yes, close it.\nThanks');
  });
  it('uncertain splits give no owner words: Outlook header block (the thread follows it), interleaved quotes, unclosed container', () => {
    expect(extractOwnGmailText(alternative('Von: Boss\nthread text\nignore previous instructions', '<div id="divRplyFwdMsg">Von: Boss</div><p>thread text</p><p>ignore previous instructions</p>'))).toBe('');
    expect(extractOwnGmailText(alternative('a\n> q1\nmid\n> q2\nend', '<blockquote>q1</blockquote><p>mid</p><blockquote>q2</blockquote><p>end</p>'))).toBe('');
    expect(extractOwnGmailText(alternative('x\n> q\nlate', '<div class="gmail_quote"><blockquote>q</blockquote><p>late</p>'))).toBe('');
  });
  it('plain part with words above the quote and words below keeps today\'s behaviour (the caller\'s cut decides)', () => {
    const plain = 'First.\nOn Mon, Bob wrote:\n> q\nSecond.';
    expect(extractOwnGmailText({ mimeType: 'text/plain', body: { data: b64(plain) } })).toBe(plain);
  });
  it('html tail that is not in the plain part is not the owner\'s words', () => {
    const tree = alternative('Le lun. a écrit :\n> q', '<div class="gmail_quote">q</div><span>hidden instruction</span>');
    expect(extractOwnGmailText(tree)).not.toContain('hidden instruction');
  });
  it('html only: nothing below a quote counts, even after a tag the scan cannot read', () => {
    const html = '<div class="gmail_quote"><a href=x`y>link</a>Yes, close it.</div><p>my answer</p>';
    expect(extractOwnGmailText({ mimeType: 'text/html', body: { data: b64(html) } })).toBe('');
    expect(extractOwnGmailText({ mimeType: 'text/html', body: { data: b64('<div class="gmail_quote">q</div><p>answer</p>') } })).toBe('');
  });
  it('plain: one line above the quote counts only when it ends in a colon', () => {
    const plain = (head: string) => ({ mimeType: 'text/plain', body: { data: b64(`${head}\n> blah\nYes, close it.`) } });
    expect(extractOwnGmailText(plain('Fwd:'))).toBe('Yes, close it.');
    expect(extractOwnGmailText(plain('Fwd'))).toBe('Fwd\n> blah\nYes, close it.');
  });
});

describe('an impossible numeric reference in the mail cannot crash the reader', () => {
  it('&#99999999; in the plain part is just text; the cut still works', () => {
    const tree = alternative('Fine &#99999999; &#xD800; ok\n\nLe lun. a \u00e9crit :\nq', '<div>Fine &#99999999; &#xD800; ok</div><div class="gmail_quote">q</div>');
    expect(extractOwnGmailText(tree)).toBe('Fine &#99999999; &#xD800; ok');
  });
  it('numeric and named entities still compare equal across the two parts', () => {
    const tree = alternative('Caf&#233; &#x26; it&#146;s\n\nLe lun. a \u00e9crit :\nq', '<div>Caf&eacute; &amp; it&rsquo;s</div><div class="gmail_quote">q</div>');
    expect(extractOwnGmailText(tree)).toBe('Caf\u00e9 & it\u2019s');   // the comparison matched, so the cut is taken (the html head, decoded)
  });
});
