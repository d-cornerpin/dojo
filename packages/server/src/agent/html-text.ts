// ════════════════════════════════════════════════════════════════════════════
// HTML → READABLE TEXT.
//
// Split out of `web-tools.ts` when the A-6 stop wiring pushed that file past the
// 400-line new-file cap, and the seam is real rather than arithmetic: everything
// left there DIALS — permissions, redirects, a rate limiter, an agent's stop — and
// this is a pure string transform with no network, no clock and no agent in it. It
// is the one part of `web_fetch` that can be reasoned about without a provider.
// ════════════════════════════════════════════════════════════════════════════

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
  // Decode common HTML entities in one pass so a decoded value is never decoded
  // again: `&amp;lt;` must stay `&lt;`, not collapse to `<`.
  const ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    '#39': "'",
    nbsp: ' ',
  };
  text = text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (match, name) => ENTITIES[name] ?? match);
  // Clean up whitespace
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]+/g, ' ');
  return text.trim();
}
