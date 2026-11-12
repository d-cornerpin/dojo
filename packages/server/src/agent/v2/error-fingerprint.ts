// Same failure from two agents counts once: volatile parts mask (emails, urls, uuids, paths,
// numbers), case drops, first 200 chars are the identity; the user_ twin folds to its base tool.

export function canonicalToolName(toolName: string): string {
  return toolName.startsWith('user_') ? toolName.slice('user_'.length) : toolName;
}

type Mask = [RegExp, string | ((match: string, gap?: string, num?: string, paren?: string) => string)];

const isStatus = (n: string): boolean => /^[1-5]\d\d$/.test(n);

const MASKS: Mask[] = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  [/\bhttps?:\/\/\S+/g, '<url>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/(?<!\w)[A-Za-z]:\\(?:[^\\\s'"`,;:)\]}]+\\?)+/g, '<path>'],
  // POSIX path starts at /, ~/, ./ or ../, never glued to a word char: text/html and work/school stay.
  [/(?<![\w/.~-])(?:~|\.{1,2})?(?:\/[^\s/'"`,;:)\]}]+)+/g, '<path>'],
  [/\b(?=[a-z0-9_-]*\d)[a-z0-9_-]{12,}\b/gi, '<id>'],
  [/\b[A-Za-z0-9]{24,}\b/g, '<id>'],
  // Numbers mask unless a status: 100-599 right after http, error, status or code, or alone in parens.
  [/\b(?:http\/\d(?:\.\d)?|http|error|status|code)([\s:=/]*)(\d+(?:\.\d+)?)|\((\d+)\)|\d+(?:\.\d+)?/gi,
    (m, _gap, num, paren) => {
      if (num !== undefined) return isStatus(num) ? m : `${m.slice(0, m.length - num.length)}<n>`;
      if (paren !== undefined) return isStatus(paren) ? m : '(<n>)';
      return '<n>';
    }],
];

export const FINGERPRINT_CHARS = 200;

/** The error text with what varies masked, wording kept; safe to store and print: no address, path or id. */
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

// Engine notes append last: a blank line and `[Engine note:`; read stored results through this.
export function stripEngineNotes(storedResult: string): string {
  const i = storedResult.indexOf('\n\n[Engine note:');
  return i < 0 ? storedResult : storedResult.slice(0, i);
}
