// ════════════════════════════════════════════════════════════════════════════════════════
// THE EVENT-LOOP STALL SENTINEL — so the next freeze is a one-line diagnosis.
//
// ⚠ WHY THIS IS THE FIRST THING IN THE PACKAGE, in the words of the capture that asked for it: the
// exact job responsible for one set of freeze windows was UNNAMED, because a 10-second sample missed
// the window by seconds. A box can be pinned at 100% CPU for 40-50 seconds out of every 60, with the
// server COMPLETELY DEAF (health probes returning nothing at a 5-second timeout), and the log can still
// not say what was running — the timer line that eventually prints lands ~20 seconds INTO the window,
// because a delayed timer logs late. Everything else in this package is a fix for a mechanism we
// believe in; this is the instrument that makes the NEXT one measurable instead of inferred.
//
// ── WHAT IT MEASURES, AND WHY THAT IS ENOUGH ──
// A timer that asks to be woken every `TICK_MS` and is woken `TICK_MS + drift` later has measured, by
// arithmetic, how long the loop refused to run it. That is the whole instrument: no profiler, no
// sampling, no async hooks — one interval and a subtraction, which is what makes it safe to leave on
// forever. A synchronous C++ call (a B-tree walk inside one `.all()`) cannot be interrupted by
// anything in JavaScript, so drift is the ONLY signal available from inside the process.
//
// ── AND IT NAMES THE SUSPECT, WHICH IS THE POINT ──
// Drift alone would say "something blocked the loop for 43 seconds", which is what the user's log
// already said in its own way. So the retrieval paths leave a BREADCRUMB — one label, set before a
// query and cleared after — and the warn names it. When a stall happens with NO breadcrumb live, that
// absence is itself a finding and the warn says so: the capture that motivated this file also recorded
// free memory collapsed to ~60 MB in the same window, which makes page-fault stalls a live alternative
// to a pinned query, and a sentinel that only ever blamed queries would have sent the next reader down
// the wrong path.
// ════════════════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';

const logger = createLogger('stall-sentinel');

/**
 * How often the sentinel asks to be woken. 250 ms is four wakeups a second — far below anything that
 * shows up in a CPU profile, and fine enough that a one-second stall is measured as roughly one second
 * rather than rounded up to the next multiple of a coarse interval.
 */
export const TICK_MS = 250;

/**
 * The drift that counts as a stall. The brief asks for >1s and that is the right line: ordinary GC
 * pauses and a busy loop under load produce tens of milliseconds, a slow synchronous query produces
 * seconds. Anything under a second is noise nobody can act on.
 */
export const STALL_THRESHOLD_MS = 1_000;

export interface QueryBreadcrumb {
  /** What was dispatched — a SHAPE, never a user's text. See `breadcrumbFor`. */
  readonly label: string;
  readonly startedAtMs: number;
}

export interface StallReport {
  readonly stalledMs: number;
  /** The breadcrumb live when the loop stopped, or `null` — which is a finding of its own. */
  readonly breadcrumb: QueryBreadcrumb | null;
  /** How long the breadcrumbed work had been running when the loop came back. */
  readonly breadcrumbAgeMs: number | null;
  /** The one-line human sentence, which is what a reader of the log actually needs. */
  readonly diagnosis: string;
}

/**
 * ⚠ A STACK, NOT A SLOT, and my own clause is what proved it has to be. With one slot, a cheap query
 * completing INSIDE a pinned one clears the mark — so the stall that follows reports "no instrumented
 * query in flight" while a 43-second scan is still running. That is worse than no instrument: it is a
 * confident wrong answer pointing at paging. The stack keeps every live mark and the sentinel reads the
 * OLDEST one, because the enclosing query is the one that has been blocking longest.
 */
let liveBreadcrumbs: QueryBreadcrumb[] = [];
let timer: NodeJS.Timeout | null = null;
let lastTickMs = 0;
/** One warn per stall window, not one per tick: a 43-second stall must produce ONE line, not 172. */
let stallAlreadyReported = false;

/**
 * ⚠ A LABEL, NEVER A QUERY. The breadcrumb is a SHAPE — `history_search:fts`, `vault_search:like` — and
 * never the pattern a person typed, because this string goes into a log that gets pasted into bug
 * reports. The brief's own constraint says no user query text in any shipped surface, and a
 * breadcrumb is the easiest place in this package to violate it by accident.
 */
export function breadcrumbFor(subsystem: string, mode: string): string {
  return `${subsystem}:${mode}`;
}

/** Mark work as dispatched. Returns the token to clear, so nesting cannot clear somebody else's mark. */
export function markQueryDispatched(label: string): QueryBreadcrumb {
  const crumb: QueryBreadcrumb = { label, startedAtMs: Date.now() };
  liveBreadcrumbs.push(crumb);
  return crumb;
}

/** Clear ONE mark by identity, wherever it sits — an inner query finishing leaves the outer mark live. */
export function clearQueryDispatched(crumb: QueryBreadcrumb): void {
  const at = liveBreadcrumbs.indexOf(crumb);
  if (at >= 0) liveBreadcrumbs.splice(at, 1);
}

/**
 * What the sentinel blames: the OLDEST live mark. The enclosing query has been running longest, so its
 * age is the number that explains a long stall; an inner mark would under-report the age and turn a
 * verdict into a "lead".
 */
export function currentBreadcrumb(): QueryBreadcrumb | null {
  return liveBreadcrumbs.length > 0 ? liveBreadcrumbs[0] : null;
}

/**
 * The sentence a reader gets. Three cases, each actionable in a different direction:
 *   · a breadcrumb that has been running the whole stall — the query is the blocker, by name;
 *   · a breadcrumb younger than the stall — something else blocked first and this started after, so the
 *     name is a lead rather than a verdict, and the line says which;
 *   · no breadcrumb at all — NOT "unknown": it means no instrumented synchronous work was in flight,
 *     which points at paging, the WAL checkpoint, or an uninstrumented path. The capture that motivated
 *     this file had free memory at ~60 MB, so this branch is the one that would have been right there.
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

/** Exposed for the wire clause and for a status surface: one tick's worth of the decision. */
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

/**
 * Start the sentinel. Idempotent, and `unref`'d so it can never be the reason a process refuses to
 * exit — an instrument that keeps the server alive is a bug of its own.
 */
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

export function stopStallSentinel(): void {
  if (timer) clearInterval(timer);
  timer = null;
  liveBreadcrumbs = [];
  stallAlreadyReported = false;
}

/** Test seam: the sentinel's own state, so a clause can drive ticks without waiting on wall time. */
export function resetSentinelForTest(): void {
  liveBreadcrumbs = [];
  stallAlreadyReported = false;
  lastTickMs = Date.now();
}
