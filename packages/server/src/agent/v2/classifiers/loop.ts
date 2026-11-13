// Loop detector: blocks a tool call whose canonical signature repeats MAX_REPEATS times in the window.

import type { ToolCall } from '@dojo/shared';

export const RECENT_TOOL_WINDOW = 8;       // calls remembered per turn
export const MAX_REPEATS_BEFORE_BREAK = 3; // identical signatures allowed before blocking

// Token-set Jaccard catches reworded repeats cheaply; short replies stay exact ("Done." twice is legit).
export function isNearDuplicateText(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size < 8 || tb.size < 8) return a.trim() === b.trim();
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  return jaccard >= 0.9;
}

export type LoopDecision = 'ok' | 'block';

export interface LoopCheckResult {
  decision: LoopDecision;
  signature: string;        // canonical sig of this call (caller appends to window)
  repeatCount: number;      // how many times this sig appeared in the window (incl. current)
  refusalMessage?: string;  // populated when decision === 'block'
}

/** 32-bit FNV-1a, hex: tells a capped value from a same-head, same-length twin. Never a security hash. */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const LONG_VALUE_CHARS = 80;
const VALUE_PREFIX_CHARS = 60;
const ARRAY_HEAD_ITEMS = 5;

// "A successful mutating call is forward progress": decided at the detectTaskThrashing call site.

/** Identity = tool name + EVERY argument key, keys sorted: same signature only when
 *  the model asked for the same work (no allow-list). Runs of 6+ digits become '*' so a
 *  re-rendered artifact counts as one operation; residual: distinct all-numeric ids also
 *  collapse, none on the live surface pass such an id. Long values and array tails are
 *  CAPPED with a digest of the rest, never dropped, so tail differences stay distinct.
 *  Varied-argument spinning is not caught here by design: the thrash gate's drift arms
 *  (steps/pre-call-gates/thrash-gate.ts) and the checkpoint window cover it. */
export function canonicalToolSignature(
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  if (!args) return `${name}:{}`;
  const scrubDigits = (s: string): string => s.replace(/\d{6,}/g, '*');
  const cap = (s: string): string =>
    s.length > LONG_VALUE_CHARS
      ? `${s.slice(0, VALUE_PREFIX_CHARS)}…[len=${s.length}#${fnv1a32(s)}]`
      : s;
  const normalized: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) {
    const v = args[k];
    if (typeof v === 'string') {
      normalized[k] = cap(scrubDigits(v));
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      normalized[k] = v;
    } else if (Array.isArray(v)) {
      const head: unknown[] = v.slice(0, ARRAY_HEAD_ITEMS).map((item: unknown) =>
        (typeof item === 'string' ? cap(scrubDigits(item)) : item));
      if (v.length > ARRAY_HEAD_ITEMS) {
        // The folded tail stays in the signature: two arrays with a shared head are two different asks.
        let tail: string;
        try { tail = JSON.stringify(v.slice(ARRAY_HEAD_ITEMS)); } catch { tail = `unserializable:${v.length}`; }
        head.push(`…[n=${v.length}#${fnv1a32(scrubDigits(tail))}]`);
      }
      normalized[k] = head;
    } else {
      try {
        normalized[k] = cap(scrubDigits(JSON.stringify(v)));
      } catch {
        normalized[k] = '<unserializable>';
      }
    }
  }
  return `${name}:${JSON.stringify(normalized)}`;
}

export function loopDetector(
  call: ToolCall,
  recentSignatures: string[],
): LoopCheckResult {
  const signature = canonicalToolSignature(call.name, call.arguments);
  const repeatCount = recentSignatures.filter((s) => s === signature).length;
  if (repeatCount >= MAX_REPEATS_BEFORE_BREAK) {
    return {
      decision: 'block',
      signature,
      repeatCount: repeatCount + 1,
      refusalMessage:
        `STOP, you have called \`${call.name}\` ${repeatCount + 1} times with substantially-similar arguments in the last few turns. ` +
        `The person you are talking to does not need more verification. The previous result is the answer; trust it. ` +
        `Respond to the person you are talking to with TEXT now, do NOT call this tool again, and do NOT call related verification tools (file_read, exec, ls, etc.) on the same artifact. ` +
        `If you genuinely need different information, ask the person you are talking to a direct question instead.`,
    };
  }

  // Only an identical signature blocks; a same-tool-name count would stop legitimate batches.
  return { decision: 'ok', signature, repeatCount: repeatCount + 1 };
}
