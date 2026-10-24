// ════════════════════════════════════════════════════════════════════════════════════════
// t219 — ONE READER FOR A FAILED CHILD, SO THE OWNER IS TOLD THE FACT IN WORDS.
//
// `child-idle-bound.ts` rejects with a plain object (`ChildRunFailure`: stdout, stderr, the exit
// number, often no `message`), not an `Error`. Every reader in the update path assumed an Error,
// so `String(err)` printed "[object Object]" and a full disk read as a generic failure (t217
// leg 6). This is the one place a failure becomes text; no site renders one with `String()`.
// ════════════════════════════════════════════════════════════════════════════════════════

/** How much of a child's stderr is kept as its "tail" when it said nothing else. */
const TAIL_CHARS = 300;

const asObject = (err: unknown): Record<string, unknown> | null =>
  err !== null && typeof err === 'object' ? err as Record<string, unknown> : null;
const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The tools' OWN error lines, best first. A download or an unpack that dies prints its cause as
 * one line of its own, amid a progress meter and warnings; that line is the owner's detail.
 * Unanchored on purpose: the same text arrives with its line breaks collapsed.
 */
const TOOL_ERROR_LINES: readonly RegExp[] = [
  /curl: \(\d+\) [^\r\n]*/g,
  /(?:unzip|rsync): [^\r\n]*/g,
  /(?:[\w-]+: )?No space left on device/gi,
];

/** curl's progress meter: its two header rows and the rows of bare numbers, sizes and times. */
const isMeterFragment = (s: string): boolean =>
  /^(?:%\s+Total\b|Dload\s+Upload\b)/.test(s) || /^[\d\s.kMGTPB:%-]*$/.test(s);

/** What a failed child said on its own, in one line: a recognised tool error, else its stderr tail. */
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

/**
 * What a failed child said, in words: its message if it has one, else one line of what it
 * printed (a recognised tool error line, or the tail of its stderr with any progress meter
 * removed), else "exited with code N" / "stopped by SIGNAL". Accepts an Error, a
 * `ChildRunFailure`, or a string; never returns an object's `toString()`.
 */
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

/** Everything a failed child printed (message, stderr, stdout), for recognising a cause in it. */
export function childFailureEvidence(err: unknown): string {
  const o = asObject(err);
  if (!o) return childFailureText(err);
  return [asText(o.message), asText(o.stderr), asText(o.stdout)].filter(Boolean).join('\n');
}

/**
 * A write failure that does not name its cause: curl's exit 23 ("Failure writing output to
 * destination"). It is a disk problem only if the volume is also measured short, which the
 * caller checks; this only says the failure is of that kind.
 */
export function isUnnamedWriteFailure(err: unknown): boolean {
  const o = asObject(err);
  return o?.code === 23 || /curl: \(23\)|Failure writing output to destination/i.test(childFailureEvidence(err));
}
