// PHASE-4 T5 Step 3 — R23: A ROUTE THAT ANSWERS THE CLIENT MAY NOT SWALLOW THE REASON.
//
// Research 22:27 books this before Phase 4 for a reason it states plainly: "fix blind route
// catches BEFORE Phase 4 or R4 debugging reads logs missing the failures." A catch that
// returns a Response and logs nothing is the worst shape a failure can take on this box —
// the caller gets a confident answer, the server keeps no record, and the only evidence the
// operation ever failed is a sentence in a browser the owner has already dismissed.
//
// DERIVED AT THIS HEAD (the plan pinned no list, so #14 applies):
//   catch blocks under gateway/routes/       222
//   of those, blocks that ANSWER the client   97
//   of those 97, blocks that logged NOTHING   45   <- this task's target, now zero
// (command in `blind-route-catches.test.ts`, which re-derives it on every run and fails if
// the count ever rises again.)
//
// P364 is the class in one sentence: the Google/Microsoft toggle routes wrapped a whole
// handler body in `try { … } catch { return c.json({ ok:false, error:'Invalid request body' }, 400) }`,
// so a DB write failure, a schema mismatch or a missing account row was reported to the owner
// as a malformed request — and the real error was never written down anywhere.
//
// WHY A HELPER RATHER THAN 45 LOGGER CALLS: a rule 45 sites are each expected to remember is
// the rule those 45 sites already forgot. Here the log happens because the answer happens —
// they are the same statement, and there is no version of "answered but silent" left to
// write. The route and method come off the request rather than a hand-passed label, so the
// log line cannot drift from the endpoint it describes.

import type { Context } from 'hono';
import type { createLogger } from '../../logger.js';

type Logger = ReturnType<typeof createLogger>;

export interface RouteFailureOptions {
  /** HTTP status to answer with. Defaults to 500 — a thrown handler is a server fault. */
  status?: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502 | 503;
  /**
   * What the CLIENT is told, when that must stay different from what we log. Existing
   * wording is preserved verbatim wherever a route already had a message, so this change
   * adds a log line and moves nothing the dashboard reads.
   */
  message?: string;
  /** Prefix for the client message when it is built from the error, e.g. `'Failed to start auth: '`. */
  prefix?: string;
  /** `warn` for a fault the caller caused, `error` for one we did. Defaults to `error`. */
  level?: 'warn' | 'error';
}

export function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Log the failure, then answer. One statement, so neither half can be forgotten. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function routeFailure(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: Context<any>,
  logger: Logger,
  err: unknown,
  opts: RouteFailureOptions = {},
): Response {
  const status = opts.status ?? 500;
  const detail = errorMessageOf(err);
  noteRouteFailure(c, logger, err, opts.level ?? (status >= 500 ? 'error' : 'warn'), status);
  const message = opts.message ?? `${opts.prefix ?? ''}${detail}`;
  return c.json({ ok: false, error: message }, status);
}

/**
 * The same record for a catch that does NOT answer with a failure — the handler degrades to a
 * fallback shape and answers 200. Those are honest designs (a missing optional lookup should
 * not fail a page), but "we degraded" is still a fact the log has to hold, or the owner sees
 * a permanently empty panel with no reason recorded anywhere.
 */
export function noteRouteFailure(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: Context<any>,
  logger: Logger,
  err: unknown,
  level: 'warn' | 'error' = 'warn',
  status?: number,
): void {
  const method = safeRead(() => c.req.method) ?? '?';
  const path = safeRead(() => c.req.path) ?? '?';
  logger[level](`${method} ${path} failed: ${errorMessageOf(err)}`, {
    method,
    path,
    ...(status === undefined ? {} : { status }),
    error: errorMessageOf(err),
    stack: err instanceof Error ? err.stack?.split('\n').slice(0, 4).join(' | ') : undefined,
  });
}

/** A logger must never be the thing that throws inside a catch. */
function safeRead(read: () => string): string | null {
  try { return read(); } catch { return null; }
}
