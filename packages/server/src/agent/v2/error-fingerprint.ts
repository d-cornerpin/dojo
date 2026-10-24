// ════════════════════════════════════════
// A tool error's FINGERPRINT (K37): the error text with everything that varies from one
// occurrence to the next masked out, so the same failure hit by two agents counts as one.
//
// Masked: emails, URLs, uuids, paths, long identifier-looking tokens, numbers. Then lowercased,
// whitespace collapsed, cut to the first 200 characters. The tool's own name is folded to its
// canonical form so the base tool and its `user_` twin fingerprint the same.
// ════════════════════════════════════════

/** The base tool a `user_`-prefixed call stands for: one tool, however it was called. */
export function canonicalToolName(toolName: string): string {
  return toolName.startsWith('user_') ? toolName.slice('user_'.length) : toolName;
}

const MASKS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  [/\bhttps?:\/\/\S+/g, '<url>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>'],
  // A path: starts at ~/, ./, ../ or / and runs to whitespace or a closing delimiter.
  [/(?:~|\.{1,2})?(?:\/[^\s/'"`,;:)\]}]+)+/g, '<path>'],
  // An identifier-looking token: 12+ id characters containing a digit (message ids, hashes).
  [/\b(?=[a-z0-9_-]*\d)[a-z0-9_-]{12,}\b/gi, '<id>'],
  [/\d+(?:\.\d+)?/g, '<n>'],
];

// The first 200 characters of the masked text are the fingerprint; past that is detail, not identity.
export const FINGERPRINT_CHARS = 200;

export function fingerprint(toolName: string, errorText: string): string {
  let text = String(errorText ?? '');
  const canonical = canonicalToolName(toolName);
  if (canonical !== toolName) text = text.split(toolName).join(canonical);
  for (const [re, mask] of MASKS) text = text.replace(re, mask);
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, FINGERPRINT_CHARS);
}
