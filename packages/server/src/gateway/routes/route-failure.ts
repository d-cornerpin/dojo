// A route that answers the client may not swallow the reason: routeFailure logs and answers in
// one call, taking method and path from the request so the log cannot drift from the endpoint.

import type { Context } from 'hono';
import type { createLogger } from '../../logger.js';

type Logger = ReturnType<typeof createLogger>;

export interface RouteFailureOptions {
  status?: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502 | 503;
  /** What the client is told when that must differ from what is logged. */
  message?: string;
  prefix?: string;
  level?: 'warn' | 'error';
}

export function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

/** The same log record for a catch that degrades to a fallback and answers 200. */
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
