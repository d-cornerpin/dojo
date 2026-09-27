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
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/h[1-6]>/gi, '\n\n');
  text = text.replace(/<li>/gi, '- ');
  text = text.replace(/<\/li>/gi, '\n');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  // Clean up whitespace
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]+/g, ' ');
  return text.trim();
}
