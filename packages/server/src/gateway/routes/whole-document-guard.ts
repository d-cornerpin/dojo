// A document the dashboard saves WHOLE (an agent's prompt, USER.md) must be saved on top of the text the
// page last read. `base` is that text. The save is refused, writing nothing, when the stored text has
// moved since (409), and a caller that names no base may not replace a saved document with a blank (400).
// One rule for every whole-document door; the safe-sender lists and the briefing apply the same rule to
// their own stored form.

export interface DocumentRefusal { status: 400 | 409; error: string }

export function refuseStaleWholeDocument(
  what: string, next: string, base: unknown, stored: string,
): DocumentRefusal | null {
  if (typeof base === 'string') {
    if (base !== stored) {
      return { status: 409, error: `This ${what} changed since you loaded it, so it was not saved. Reload it and make your change again.` };
    }
    return null;
  }
  if (!next.trim() && stored.trim()) {
    return { status: 400, error: `A blank ${what} was not saved over the existing one. Reload the page and try again.` };
  }
  return null;
}
