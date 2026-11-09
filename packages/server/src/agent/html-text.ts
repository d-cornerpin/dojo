// HTML to readable text: strip markup, decode character references, keep paragraph breaks. A pure string
// transform with no network, no clock and no agent in it.

/** Strip markup, decode the common entities, and leave paragraph breaks intact. */
export function stripHtmlTags(html: string): string {
  // Remove script and style blocks entirely
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // Replace br and p tags with newlines
  text = text.replace(/<br\b[^>]*>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/h[1-6]>/gi, '\n\n');
  text = text.replace(/<li\b[^>]*>/gi, '- ');
  text = text.replace(/<\/li>/gi, '\n');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');
  text = decodeHtmlEntities(text);
  // Clean up whitespace
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]+/g, ' ');
  return text.trim();
}

// ── HTML character references to text ──

const LATIN1 = ('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
  'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml').split(' ');
const GREEK_UPPER = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho'.split(' ');   // U+0391..U+03A1
const GREEK_UPPER_2 = 'Sigma Tau Upsilon Phi Chi Psi Omega'.split(' ');                                                   // U+03A3..U+03A9
const GREEK_LOWER = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega'.split(' '); // U+03B1..U+03C9

/** The HTML 4 named entities (the set mail and web pages actually use), by name. `nbsp` is a plain space, not U+00A0, so the whitespace clean-up that follows can collapse it. */
const NAMED_ENTITIES: Record<string, string> = (() => {
  const t: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  LATIN1.forEach((n, i) => { t[n] = String.fromCodePoint(160 + i); });
  GREEK_UPPER.forEach((n, i) => { t[n] = String.fromCodePoint(0x391 + i); });
  GREEK_UPPER_2.forEach((n, i) => { t[n] = String.fromCodePoint(0x3a3 + i); });
  GREEK_LOWER.forEach((n, i) => { t[n] = String.fromCodePoint(0x3b1 + i); });
  const more: Record<string, number> = {
    OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732, thetasym: 977, upsih: 978, piv: 982,
    ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212,
    lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226,
    hellip: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250, oline: 8254, frasl: 8260, euro: 8364,
    image: 8465, weierp: 8472, real: 8476, trade: 8482, alefsym: 8501, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596,
    crarr: 8629, lArr: 8656, uArr: 8657, rArr: 8658, dArr: 8659, hArr: 8660, forall: 8704, part: 8706, exist: 8707, empty: 8709,
    nabla: 8711, isin: 8712, notin: 8713, ni: 8715, prod: 8719, sum: 8721, minus: 8722, lowast: 8727, radic: 8730, prop: 8733,
    infin: 8734, ang: 8736, and: 8743, or: 8744, cap: 8745, cup: 8746, int: 8747, there4: 8756, sim: 8764, cong: 8773, asymp: 8776,
    ne: 8800, equiv: 8801, le: 8804, ge: 8805, sub: 8834, sup: 8835, nsub: 8836, sube: 8838, supe: 8839, oplus: 8853, otimes: 8855,
    perp: 8869, sdot: 8901, lceil: 8968, rceil: 8969, lfloor: 8970, rfloor: 8971, lang: 9001, rang: 9002, loz: 9674,
    spades: 9824, clubs: 9827, hearts: 9829, diams: 9830,
  };
  for (const [n, cp] of Object.entries(more)) t[n] = String.fromCodePoint(cp);
  t.nbsp = ' ';
  return t;
})();

/** Numeric references 128-159 mean the Windows-1252 characters, as browsers read them (old Outlook/Word HTML writes `&#146;` for an apostrophe). The five slots 1252 leaves undefined are not listed. */
const WINDOWS_1252: Record<number, number> = {
  128: 0x20ac, 130: 0x201a, 131: 0x192, 132: 0x201e, 133: 0x2026, 134: 0x2020, 135: 0x2021, 136: 0x2c6, 137: 0x2030, 138: 0x160,
  139: 0x2039, 140: 0x152, 142: 0x17d, 145: 0x2018, 146: 0x2019, 147: 0x201c, 148: 0x201d, 149: 0x2022, 150: 0x2013, 151: 0x2014,
  152: 0x2dc, 153: 0x2122, 154: 0x161, 155: 0x203a, 156: 0x153, 158: 0x17e, 159: 0x178,
};

/**
 * Decode HTML character references in ONE pass, so a decoded value is never decoded again
 * (`&amp;lt;` stays `&lt;`). Handles every decimal (`&#39;`) and hex (`&#x27;`) reference that names a real
 * character (128-159 as Windows-1252), and the HTML 4 named set. An unknown name, a control character other than tab, newline
 * and carriage return, or a number that is not a character, is left as written.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,9}));/g, (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? match;
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex as string, 16);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return match;
    if (cp >= 128 && cp <= 159 && WINDOWS_1252[cp] !== undefined) return String.fromCodePoint(WINDOWS_1252[cp]);
    if (cp < 32 ? (cp !== 9 && cp !== 10 && cp !== 13) : (cp >= 127 && cp <= 159)) return match;
    return String.fromCodePoint(cp);
  });
}
