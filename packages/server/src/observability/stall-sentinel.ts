// Event-loop stall sentinel: a timer woken every TICK_MS measures, by drift, how long the loop was blocked.
// Query paths leave a breadcrumb label so the warn can name the suspect; no breadcrumb is a finding too.

import { createLogger } from '../logger.js';

const logger = createLogger('stall-sentinel');

export const TICK_MS = 250;

export const STALL_THRESHOLD_MS = 1_000;

export interface QueryBreadcrumb {
  readonly label: string;
  readonly startedAtMs: number;
}

export interface StallReport {
  readonly stalledMs: number;
  readonly breadcrumb: QueryBreadcrumb | null;
  readonly breadcrumbAgeMs: number | null;
  readonly diagnosis: string;
}

/**
 * A stack, not a slot: a cheap query finishing inside a pinned one must not clear the pinned mark.
 * The sentinel reads the oldest mark, since the enclosing query has been blocking longest.
 */
let liveBreadcrumbs: QueryBreadcrumb[] = [];
let timer: NodeJS.Timeout | null = null;
let lastTickMs = 0;
let stallAlreadyReported = false;

/** A label, never a query: no user-typed text, because this string goes into logs pasted into bug reports. */
export function breadcrumbFor(subsystem: string, mode: string): string {
  return `${subsystem}:${mode}`;
}

/** Suffix for work run on the reader worker: context for `diagnose`, never the cause. */
export const OFF_THREAD_SUFFIX = '@reader';

export function offThreadBreadcrumb(label: string): string {
  return `${label}${OFF_THREAD_SUFFIX}`;
}

export function isOffThread(label: string): boolean {
  return label.endsWith(OFF_THREAD_SUFFIX);
}

export function markQueryDispatched(label: string): QueryBreadcrumb {
  const crumb: QueryBreadcrumb = { label, startedAtMs: Date.now() };
  liveBreadcrumbs.push(crumb);
  return crumb;
}

/** Clear one mark by identity, so an inner query finishing leaves the outer mark live. */
export function clearQueryDispatched(crumb: QueryBreadcrumb): void {
  const at = liveBreadcrumbs.indexOf(crumb);
  if (at >= 0) liveBreadcrumbs.splice(at, 1);
}

/** What the sentinel blames: the oldest live mark, whose age best explains a long stall. */
export function currentBreadcrumb(): QueryBreadcrumb | null {
  return liveBreadcrumbs.length > 0 ? liveBreadcrumbs[0] : null;
}

/**
 * The sentence a reader gets. A breadcrumb as old as the stall is the blocker; a younger one is only a
 * lead; none means no instrumented synchronous work was in flight (paging, WAL checkpoint, other path).
 */
export function diagnose(stalledMs: number, breadcrumb: QueryBreadcrumb | null, nowMs: number): StallReport {
  if (breadcrumb === null) {
    return {
      stalledMs,
      breadcrumb: null,
      breadcrumbAgeMs: null,
      diagnosis: `the event loop stalled ${stalledMs}ms with NO instrumented query in flight — `
        + 'suspect paging, a WAL checkpoint, or synchronous work on an uninstrumented path',
    };
  }
  const ageMs = Math.max(0, nowMs - breadcrumb.startedAtMs);
  // Off-thread work is context, not cause: it cannot have blocked the serving thread, so point at the
  // same suspects as the no-breadcrumb case.
  if (isOffThread(breadcrumb.label)) {
    return {
      stalledMs,
      breadcrumb,
      breadcrumbAgeMs: ageMs,
      diagnosis: `the event loop stalled ${stalledMs}ms with ${breadcrumb.label} in flight on the `
        + `reader worker (dispatched ${ageMs}ms ago, so it CANNOT be the blocker) — suspect paging, `
        + 'a WAL checkpoint, or synchronous work on an uninstrumented path',
    };
  }
  if (ageMs >= stalledMs) {
    return {
      stalledMs,
      breadcrumb,
      breadcrumbAgeMs: ageMs,
      diagnosis: `the event loop stalled ${stalledMs}ms while ${breadcrumb.label} was running `
        + `(dispatched ${ageMs}ms ago) — that query is the blocker`,
    };
  }
  return {
    stalledMs,
    breadcrumb,
    breadcrumbAgeMs: ageMs,
    diagnosis: `the event loop stalled ${stalledMs}ms; ${breadcrumb.label} was dispatched ${ageMs}ms `
      + 'ago, AFTER the stall began, so it is a lead and not the whole cause',
  };
}

export function evaluateTick(nowMs: number, previousTickMs: number): StallReport | null {
  const drift = nowMs - previousTickMs - TICK_MS;
  if (drift < STALL_THRESHOLD_MS) {
    stallAlreadyReported = false;
    return null;
  }
  if (stallAlreadyReported) return null;
  stallAlreadyReported = true;
  return diagnose(drift, currentBreadcrumb(), nowMs);
}

/** Idempotent, and `unref`'d so it can never keep a process from exiting. */
export function startStallSentinel(): void {
  if (timer) return;
  lastTickMs = Date.now();
  stallAlreadyReported = false;
  timer = setInterval(() => {
    const now = Date.now();
    const report = evaluateTick(now, lastTickMs);
    lastTickMs = now;
    if (report) {
      logger.warn(report.diagnosis, {
        stalledMs: report.stalledMs,
        breadcrumb: report.breadcrumb?.label ?? null,
        breadcrumbAgeMs: report.breadcrumbAgeMs,
      });
    }
  }, TICK_MS);
  timer.unref();
}

/** Test seam: the sentinel's own state, so a clause can drive ticks without waiting on wall time. */
export function resetSentinelForTest(): void {
  liveBreadcrumbs = [];
  stallAlreadyReported = false;
  lastTickMs = Date.now();
}
