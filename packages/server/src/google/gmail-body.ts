import { stripHtmlTags, decodeHtmlEntities } from '../agent/html-text.js';

export interface GmailBodyPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: GmailBodyPart[];
}

function decode(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

// Every leaf part that carries inline text and is not an attachment, in message order.
function collectTextLeaves(part: GmailBodyPart, out: GmailBodyPart[]): void {
  if (part.parts && part.parts.length > 0) {
    for (const child of part.parts) collectTextLeaves(child, out);
    return;
  }
  const isAttachment = !!(part.filename && part.filename.length > 0) || !!part.body?.attachmentId;
  if (!isAttachment && part.body?.data) out.push(part);
}

/** The readable text of a Gmail message: the first text/plain part anywhere in the tree, else the first text/html part with its tags stripped, else any other inline text, else ''. */
export function extractGmailBodyText(payload: GmailBodyPart | null | undefined): string {
  if (!payload) return '';
  const leaves: GmailBodyPart[] = [];
  collectTextLeaves(payload, leaves);
  const type = (p: GmailBodyPart) => (p.mimeType ?? '').toLowerCase();
  const plain = leaves.find((p) => type(p) === 'text/plain');
  if (plain) return decode(plain.body!.data!);
  const html = leaves.find((p) => type(p) === 'text/html');
  if (html) return stripHtmlTags(decode(html.body!.data!));
  const other = leaves.find((p) => type(p) === '');
  return other ? decode(other.body!.data!) : '';
}

// The sender's OWN text leaves: walk multipart containers, but never into an attached message (message/rfc822 and its
// kin carry another person's mail, with its own text parts, inside the same tree).
function collectOwnLeaves(part: GmailBodyPart, out: GmailBodyPart[]): void {
  const type = (part.mimeType ?? '').toLowerCase();
  if (type.startsWith('message/')) return;
  if (part.parts && part.parts.length > 0) { for (const child of part.parts) collectOwnLeaves(child, out); return; }
  if (!part.filename && !part.body?.attachmentId && part.body?.data) out.push(part);
}

// The mail program marks its quote in the html with language-free markup, so no word lists are needed (unlike
// mail-quoted-text.ts). Tags are read with an attribute-aware scan (values may hold `>`), never by text match.
//   'wrap'   the element holds the whole quoted thread (Gmail, Yahoo, a blockquote): what follows its end is NOT quote.
//   'header' only the "who wrote this" block: what follows may be the quoted thread itself, so nothing after it is
//            trusted (except a blockquote that directly follows a Thunderbird citation line, which is its thread).
interface HtmlTag { start: number; end: number; name: string; closing: boolean; selfClosing: boolean; attrs: Map<string, string> }
type QuoteKind = 'wrap' | 'header';

const TAG = /<(\/?)([a-z][a-z0-9:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*)\s*(\/?)>/gi;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/g;

function scanTags(html: string): HtmlTag[] {
  const tags: HtmlTag[] = [];
  for (const m of html.matchAll(TAG)) {
    const attrs = new Map<string, string>();
    for (const a of m[3].matchAll(ATTR)) attrs.set(a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '');
    tags.push({ start: m.index, end: m.index + m[0].length, name: m[2].toLowerCase(), closing: m[1] === '/', selfClosing: m[4] === '/', attrs });
  }
  return tags;
}

function quoteKind(t: HtmlTag): QuoteKind | null {
  if (t.closing) return null;
  if (t.name === 'blockquote') return 'wrap';
  const classes = (t.attrs.get('class') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (classes.some((c) => c.startsWith('gmail_quote') || c === 'yahoo_quoted')) return 'wrap';
  if (classes.includes('moz-cite-prefix')) return 'header';
  const id = (t.attrs.get('id') ?? '').toLowerCase();
  return id === 'divrplyfwdmsg' || id === 'appendonsend' ? 'header' : null;
}

function elementEnd(tags: HtmlTag[], i: number): number {
  if (tags[i].selfClosing) return tags[i].end;
  let depth = 0;
  for (let j = i; j < tags.length; j++) {
    if (tags[j].name !== tags[i].name || tags[j].selfClosing) continue;
    depth += tags[j].closing ? -1 : 1;
    if (depth === 0) return tags[j].end;
  }
  return -1;
}

// A marker word anywhere in the html that no scanned tag carries (broken or odd markup) means the quote was not found.
const MARKER_WORD = /gmail_quote|moz-cite-prefix|yahoo_quoted|divRplyFwdMsg|appendonsend|<blockquote/i;

type HtmlSplit =
  | { found: false; unreadable: boolean }
  | { found: true; head: string; tail: string | null };

/** The html above the first quote marker, and the html after the quote ends (null when that cannot be told). */
function splitAtQuote(html: string): HtmlSplit {
  const tags = scanTags(html);
  const i = tags.findIndex((t) => quoteKind(t) !== null);
  if (i < 0) return { found: false, unreadable: MARKER_WORD.test(html) };
  let end = elementEnd(tags, i);
  if (quoteKind(tags[i]) === 'header') {
    // Only a Thunderbird citation line directly followed by its blockquote has a known end.
    const next = tags.findIndex((t) => t.start >= (end < 0 ? Infinity : end));
    const direct = end >= 0 && next >= 0 && tags[next].name === 'blockquote' && !tags[next].closing && html.slice(end, tags[next].start).trim() === '';
    end = direct && (tags[i].attrs.get('class') ?? '').toLowerCase().includes('moz-cite-prefix') ? elementEnd(tags, next) : -1;
  }
  const tail = end < 0 ? null : html.slice(end);
  // Another quote below the first means interleaved replies: where the owner's words end is a guess.
  const more = end >= 0 && tags.some((t) => t.start >= end && quoteKind(t) !== null);
  return { found: true, head: html.slice(0, tags[i].start), tail: more ? null : tail };
}

// The same text compared across the plain and html renderings: entities decoded, every whitespace run one space.
function normalise(text: string): string {
  return decodeHtmlEntities(text).replace(/\s+/g, ' ').trim();
}

/** Plain text, bottom-posted: an optional single attribution line, a `>` quote block, then the owner's words. The text
 *  below the block, or null when the shape is anything else (words above the quote, words between quoted runs). */
function plainBottomPost(plain: string): string | null {
  const lines = plain.split(/\r?\n/);
  const isQuote = (l: string): boolean => l.trimStart().startsWith('>');
  const first = lines.findIndex(isQuote);
  if (first < 0) return null;
  const last = lines.length - 1 - [...lines].reverse().findIndex(isQuote);
  const above = lines.slice(0, first).filter((l) => l.trim() !== '');
  if (above.length > 1 || (above.length === 1 && !above[0].trimEnd().endsWith(':'))) return null;
  if (lines.slice(first, last + 1).some((l) => l.trim() !== '' && !isQuote(l))) return null;
  const tail = lines.slice(last + 1).join('\n').trim();
  return tail === '' ? null : tail;
}

/** The text the sender newly wrote in the message's own body part, never that of an attached message. '' when none.
 *  When the html carries a quote container the mail program wrote, the text is cut there: above it, or (bottom-posted)
 *  below the block when its end is known. It is accepted only if it is also in the plain part (compared after
 *  whitespace and entities); else the plain part is returned. An unreadable quote gives '' (never quote text). */
export function extractOwnGmailText(payload: GmailBodyPart | null | undefined): string {
  if (!payload) return '';
  const leaves: GmailBodyPart[] = [];
  collectOwnLeaves(payload, leaves);
  const type = (p: GmailBodyPart) => (p.mimeType ?? '').toLowerCase();
  const htmlPart = leaves.find((p) => type(p) === 'text/html');
  const plainPart = leaves.find((p) => type(p) === 'text/plain');
  const html = htmlPart ? decode(htmlPart.body!.data!) : '';
  const plain = plainPart ? decode(plainPart.body!.data!) : null;
  if (htmlPart) {
    const split = splitAtQuote(html);
    if (split.found || split.unreadable) {
      if (!split.found) return '';
      let own = stripHtmlTags(split.head);
      // Below a quote only with a plain part to confirm it: html alone cannot tell where the quote really ended.
      if (own === '' && split.tail !== null && plain !== null) own = stripHtmlTags(split.tail);
      if (plain === null || normalise(plain).includes(normalise(own))) return own;
      return plain;
    }
  }
  if (plain !== null) return plainBottomPost(plain) ?? plain;
  return htmlPart ? stripHtmlTags(html) : '';
}
