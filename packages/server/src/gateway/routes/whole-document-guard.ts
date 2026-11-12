// A whole-document save must build on the text the page last read (`base`): refused with 409 when the stored
// text has moved, and with 400 when no base is given and it would blank a saved document. Every door uses it.

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
