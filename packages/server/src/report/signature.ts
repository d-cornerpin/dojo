import { createHash } from 'node:crypto';

/** Closed on purpose: the lane rides into the signature and the public attachment, never as free text. */
export const FAILURE_LANES = ['tool-error', 'wrong-answer', 'silence', 'permission', 'other'] as const;
export type FailureLane = typeof FAILURE_LANES[number];

export function isFailureLane(v: unknown): v is FailureLane {
  return typeof v === 'string' && (FAILURE_LANES as readonly string[]).includes(v);
}

export interface DominantFailure {
  readonly toolFailures: readonly { tool: string; result: string; count: number }[];
  readonly turnExits: readonly { exitReason: string; count: number }[];
}

/** Tool failures outrank turn exits. Callers rank by count desc, key asc: only each list's head is read. */
export function dominantToken(d: DominantFailure): string {
  const t = d.toolFailures[0];
  if (t) return `tool:${t.tool}:${t.result}`;
  const e = d.turnExits[0];
  if (e) return `turn:${e.exitReason}`;
  return 'none';
}

/** No user text, no version: a re-report after an update finds its issue. `ds2-` never matches `ds1-`. */
export function deriveReportSignature(lane: FailureLane, dominant: DominantFailure): string {
  const input = `${lane}|${dominantToken(dominant)}`;
  return `ds2-${createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 12)}`;
}
