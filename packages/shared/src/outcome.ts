// Outcome: the answer to "what happened?" (applied with proof, no_change, refused by a named gate, or failed).
// Boundaries refuse by returning, never throwing, and a caller is expected to read the `kind` it gets back.

// blocked: a gate said no, nothing ran. crashed: it ran and broke, the effect may have landed. cancelled:
// abandoned before an answer. invalid_args: a malformed call the door refused; retry with corrected arguments.
export type ToolSeamReason = 'blocked' | 'crashed' | 'cancelled' | 'invalid_args';

// One interface per arm so a boundary can intersect extra typed evidence onto a single arm.

export interface OutcomeApplied<T> {
  readonly kind: 'applied';
  readonly value: T;
  /** Human-readable colour. Never the carrier of a machine-read fact. */
  readonly detail?: string;
}

export interface OutcomeNoChange<R extends string = string> {
  readonly kind: 'no_change';
  readonly reason: R;
  readonly detail: string;
}

export interface OutcomeRefused<R extends string = string> {
  readonly kind: 'refused';
  readonly reason: R;
  readonly detail: string;
}

export interface OutcomeFailed<R extends string = string> {
  readonly kind: 'failed';
  readonly reason: R;
  readonly detail: string;
}

/** The four-way answer every boundary returns. */
export type LiveOutcome<T = void, R extends string = string> =
  | OutcomeApplied<T>
  | OutcomeNoChange<R>
  | OutcomeRefused<R>
  | OutcomeFailed<R>;


export function applied<T>(value: T, detail?: string): OutcomeApplied<T> {
  return detail === undefined ? { kind: 'applied', value } : { kind: 'applied', value, detail };
}

export function refused<R extends string>(reason: R, detail: string): OutcomeRefused<R> {
  return { kind: 'refused', reason, detail };
}

export function failed<R extends string>(reason: R, detail: string): OutcomeFailed<R> {
  return { kind: 'failed', reason, detail };
}
