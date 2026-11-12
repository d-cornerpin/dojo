// One reader turns a failed child into text: `child-idle-bound.ts` rejects with a plain object
// (`ChildRunFailure`), not an Error, so `String(err)` would print "[object Object]".

const TAIL_CHARS = 300;

const asObject = (err: unknown): Record<string, unknown> | null =>
  err !== null && typeof err === 'object' ? err as Record<string, unknown> : null;
const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The tools' own error lines, best first (unanchored: the text can arrive with line breaks collapsed). */
const TOOL_ERROR_LINES: readonly RegExp[] = [
  /curl: \(\d+\) [^\r\n]*/g,
  /(?:unzip|rsync): [^\r\n]*/g,
  /(?:[\w-]+: )?No space left on device/gi,
];

/** curl's progress meter rows. */
const isMeterFragment = (s: string): boolean =>
  /^(?:%\s+Total\b|Dload\s+Upload\b)/.test(s) || /^[\d\s.kMGTPB:%-]*$/.test(s);

function saidOnItsOwn(stderr: string, stdout: string): string {
  const lines = (text: string) => text.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !isMeterFragment(l));
  const own = lines(stderr);
  const everything = [...own, ...lines(stdout)].join('\n');
  for (const re of TOOL_ERROR_LINES) {
    const found = everything.match(re);
    if (found) return found[found.length - 1].trim().replace(/\s+/g, ' ');
  }
  const tail = own.join(' ').replace(/\s+/g, ' ');
  // A tail that must be cut starts at a word, never in the middle of a path.
  return tail.length > TAIL_CHARS ? `\u2026${tail.slice(-TAIL_CHARS).replace(/^\S*\s/, '')}` : tail;
}

/** What a failed child said, in words; accepts an Error, a `ChildRunFailure` or a string. */
export function childFailureText(err: unknown): string {
  if (typeof err === 'string') return err.trim() || 'failed with no explanation';
  const o = asObject(err);
  if (!o) return err === null || err === undefined ? 'failed with no explanation' : String(err);
  const message = asText(o.message);
  if (message) return message;
  const said = saidOnItsOwn(asText(o.stderr), asText(o.stdout));
  if (said) return said;
  if (typeof o.signal === 'string' && o.signal) return `stopped by ${o.signal}`;
  if (typeof o.code === 'number') return `exited with code ${o.code}`;
  if (typeof o.code === 'string' && o.code) return `failed (${o.code})`;
  return 'failed with no explanation';
}

export function childFailureEvidence(err: unknown): string {
  const o = asObject(err);
  if (!o) return childFailureText(err);
  return [asText(o.message), asText(o.stderr), asText(o.stdout)].filter(Boolean).join('\n');
}

/** curl exit 23 names no cause; the caller counts it as a disk problem only if the volume is also short. */
export function isUnnamedWriteFailure(err: unknown): boolean {
  const o = asObject(err);
  return o?.code === 23 || /curl: \(23\)|Failure writing output to destination/i.test(childFailureEvidence(err));
}
