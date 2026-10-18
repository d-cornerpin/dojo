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
 * What a failed child said, in words: its message if it has one, else the tail of its stderr,
 * else "exited with code N" / "stopped by SIGNAL". Accepts an Error, a `ChildRunFailure`, or a
 * string; never returns an object's `toString()`.
 */
export function childFailureText(err: unknown): string {
  if (typeof err === 'string') return err.trim() || 'failed with no explanation';
  const o = asObject(err);
  if (!o) return err === null || err === undefined ? 'failed with no explanation' : String(err);
  const message = asText(o.message);
  if (message) return message;
  const stderr = asText(o.stderr).replace(/\s+/g, ' ');
  if (stderr) return stderr.length > TAIL_CHARS ? `…${stderr.slice(-TAIL_CHARS)}` : stderr;
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
