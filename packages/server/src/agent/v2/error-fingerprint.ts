// ════════════════════════════════════════
// A tool error's FINGERPRINT (K37): the error text with everything that varies from one
// occurrence to the next masked out, so the same failure hit by two agents counts as one.
//
// Masked: emails, URLs, uuids, paths (POSIX and Windows), long identifier-looking tokens, numbers.
// What DISTINGUISHES one error from another stays: an HTTP status (a 3-digit number straight
// after http / status / code, so 403 is not 500) and slashed words such as content types
// (`text/html` is not `application/json`) or `work/school`. The fingerprint is that text
// lowercased, whitespace collapsed, cut to the first 200 characters. The tool's own name is
// folded to its canonical form so the base tool and its `user_` twin fingerprint the same.
//
// `maskVolatile` is the same masking without the lowercasing and cut: what is safe to STORE and
// to PRINT (the ledger's sample), since it carries no address, path or id.
// ════════════════════════════════════════

/** The base tool a `user_`-prefixed call stands for: one tool, however it was called. */
export function canonicalToolName(toolName: string): string {
  return toolName.startsWith('user_') ? toolName.slice('user_'.length) : toolName;
}

type Mask = [RegExp, string | ((match: string, gap?: string, num?: string, paren?: string) => string)];

const isStatus = (n: string): boolean => /^[1-5]\d\d$/.test(n);

const MASKS: Mask[] = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  [/\bhttps?:\/\/\S+/g, '<url>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  // A Windows path: a drive letter, then backslash-separated segments.
  [/(?<!\w)[A-Za-z]:\\(?:[^\\\s'"`,;:)\]}]+\\?)+/g, '<path>'],
  // A POSIX path starts at /, ~/, ./ or ../ and is NOT glued to a word character, so `text/html`,
  // `and/or` and `work/school` are left alone.
  [/(?<![\w/.~-])(?:~|\.{1,2})?(?:\/[^\s/'"`,;:)\]}]+)+/g, '<path>'],
  // An identifier-looking token: 12+ id characters containing a digit (message ids, hashes), or a
  // 24+ run of letters and digits (API keys). Neither is part of what an error means.
  [/\b(?=[a-z0-9_-]*\d)[a-z0-9_-]{12,}\b/gi, '<id>'],
  [/\b[A-Za-z0-9]{24,}\b/g, '<id>'],
  // A number is masked unless it is a status: 100-599 standing alone right after http/<version>, http,
  // error, status or code, or alone in parentheses. Anything else (counts, ids, versions) is masked.
  [/\b(?:http\/\d(?:\.\d)?|http|error|status|code)([\s:=/]*)(\d+(?:\.\d+)?)|\((\d+)\)|\d+(?:\.\d+)?/gi,
    (m, _gap, num, paren) => {
      if (num !== undefined) return isStatus(num) ? m : `${m.slice(0, m.length - num.length)}<n>`;
      if (paren !== undefined) return isStatus(paren) ? m : '(<n>)';
      return '<n>';
    }],
];

// The first 200 characters of the masked text are the fingerprint; past that is detail, not identity.
export const FINGERPRINT_CHARS = 200;

/** The error text with everything that varies masked; case and wording kept. */
export function maskVolatile(toolName: string, errorText: string): string {
  let text = String(errorText ?? '');
  const canonical = canonicalToolName(toolName);
  if (canonical !== toolName) text = text.split(toolName).join(canonical);
  for (const [re, mask] of MASKS) text = text.replace(re, mask as string);
  return text.replace(/\s+/g, ' ').trim();
}

export function fingerprint(toolName: string, errorText: string): string {
  return maskVolatile(toolName, errorText).toLowerCase().slice(0, FINGERPRINT_CHARS);
}
