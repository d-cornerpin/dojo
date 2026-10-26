// route-failure — the one statement a route's catch uses to record a failure in the log and
// answer the client. A pure test: a fake context and a fake logger, no router, no DB. It pins the
// status default, the warn/error split, the client-message rules and the unreadable-request path
// that dozens of route catches answer the dashboard through.

import { describe, it, expect, vi } from 'vitest';
import { errorMessageOf, routeFailure, noteRouteFailure } from '../route-failure.js';

const POST = { method: 'POST', path: '/api/x' } as const;

function makeContext(req: Record<string, unknown> = POST) {
  return { json: vi.fn((body: unknown, status: number) => ({ body, status })), req } as never;
}
function makeLogger() {
  return { error: vi.fn(), warn: vi.fn() } as never;
}

/** The (message, meta) a fake logger recorded on its last call — the line the owner reads. */
function lastCall(mock: ReturnType<typeof vi.fn>): [unknown, unknown] | undefined {
  const calls = mock.mock.calls;
  return calls[calls.length - 1] as [unknown, unknown] | undefined;
}

describe('errorMessageOf — the text the log and the client both start from', () => {
  it('reads the message off an Error', () => {
    expect(errorMessageOf(new Error('m'))).toBe('m');
    expect(errorMessageOf(new TypeError('t'))).toBe('t');
  });

  it('everything else falls through to String()', () => {
    expect(errorMessageOf('plain')).toBe('plain');
    expect(errorMessageOf(42)).toBe('42');
    expect(errorMessageOf(null)).toBe('null');
    expect(errorMessageOf(undefined)).toBe('undefined');
  });
});

describe('routeFailure — log it, then answer', () => {
  it('defaults to a 500 error and forwards whatever c.json returned to the caller', () => {
    const sentinel = { ok: false, error: 'boom' } as { ok: boolean; error: string };
    const c = { json: vi.fn(() => sentinel), req: POST } as never;
    const logger = makeLogger();

    const out = routeFailure(c, logger, new Error('boom'));

    expect(c.json).toHaveBeenCalledTimes(1);
    expect(c.json).toHaveBeenCalledWith({ ok: false, error: 'boom' }, 500);
    expect(out).toBe(sentinel);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [msg, meta] = lastCall(logger.error)!;
    expect(msg).toBe('POST /api/x failed: boom');
    expect(meta).toMatchObject({ method: 'POST', path: '/api/x', status: 500, error: 'boom' });
  });

  it('a status under 500 logs as a warning, not an error', () => {
    const c = makeContext();
    const logger = makeLogger();

    routeFailure(c, logger, new Error('bad'), { status: 404 });

    expect(c.json).toHaveBeenCalledWith({ ok: false, error: 'bad' }, 404);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('an explicit level overrides the status-derived one', () => {
    const warnCtx = makeContext(), warnLogger = makeLogger();
    routeFailure(warnCtx, warnLogger, new Error('x'), { status: 500, level: 'warn' });
    expect(warnLogger.warn).toHaveBeenCalledTimes(1);
    expect(warnLogger.error).not.toHaveBeenCalled();

    const errCtx = makeContext(), errLogger = makeLogger();
    routeFailure(errCtx, errLogger, new Error('x'), { status: 400, level: 'error' });
    expect(errLogger.error).toHaveBeenCalledTimes(1);
    expect(errLogger.warn).not.toHaveBeenCalled();
  });

  it('a message is what the client sees while the log keeps the real error', () => {
    const c = makeContext();
    const logger = makeLogger();

    routeFailure(c, logger, new Error('boom'), { message: 'Something went wrong' });

    expect(c.json).toHaveBeenCalledWith({ ok: false, error: 'Something went wrong' }, 500);
    expect(lastCall(logger.error)![0]).toBe('POST /api/x failed: boom');
  });

  it('a prefix is joined to the real error for the client', () => {
    const c = makeContext();
    const logger = makeLogger();

    routeFailure(c, logger, new Error('boom'), { prefix: 'Failed to start auth: ' });

    expect(c.json).toHaveBeenCalledWith({ ok: false, error: 'Failed to start auth: boom' }, 500);
    expect(lastCall(logger.error)![0]).toBe('POST /api/x failed: boom');
  });

  it('with both set, the message wins over the prefix', () => {
    const c = makeContext();
    routeFailure(c, makeLogger(), new Error('boom'), { message: 'Something went wrong', prefix: 'Failed to start auth: ' });
    expect(c.json).toHaveBeenCalledWith({ ok: false, error: 'Something went wrong' }, 500);
  });

  it('a non-Error input is String()ed and carries no stack', () => {
    const c = makeContext();
    const logger = makeLogger();

    routeFailure(c, logger, 'plain string');

    expect(c.json).toHaveBeenCalledWith({ ok: false, error: 'plain string' }, 500);
    const [, meta] = lastCall(logger.error)!;
    expect(meta).toMatchObject({ error: 'plain string' });
    expect((meta as Record<string, unknown>).stack).toBeUndefined();
  });

  it('trims the logged stack to its first four lines, joined by " | "', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\nat a\nat b\nat c\nat d';
    const c = makeContext();
    const logger = makeLogger();

    routeFailure(c, logger, err);

    const [, meta] = lastCall(logger.error)!;
    expect((meta as Record<string, unknown>).stack).toBe('Error: boom | at a | at b | at c');
  });
});

describe('noteRouteFailure — the record a non-answering catch leaves', () => {
  it('warns by default, answers nothing, and omits a status it was not given', () => {
    const c = makeContext();
    const logger = makeLogger();

    const out = noteRouteFailure(c, logger, new Error('x'));

    expect(out).toBeUndefined();
    expect(c.json).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect('status' in (lastCall(logger.warn)![1] as object)).toBe(false);
  });

  it('carries a status through to the meta when one is passed', () => {
    const c = makeContext();
    const logger = makeLogger();

    noteRouteFailure(c, logger, new Error('x'), 'warn', 502);

    expect((lastCall(logger.warn)![1] as Record<string, unknown>).status).toBe(502);
  });
});

describe('a request that cannot be read', () => {
  it('a throwing method getter logs "?" and does not throw', () => {
    const c = makeContext({ get method() { throw new Error('boom'); }, path: '/p' });
    const logger = makeLogger();

    expect(() => routeFailure(c, logger, new Error('boom'))).not.toThrow();

    const [msg, meta] = lastCall(logger.error)!;
    expect(msg).toBe('? /p failed: boom');
    expect((meta as Record<string, unknown>).method).toBe('?');
  });

  it('a throwing path getter logs "?" and does not throw', () => {
    const c = makeContext({ method: 'POST', get path() { throw new Error('boom'); } });
    const logger = makeLogger();

    expect(() => routeFailure(c, logger, new Error('boom'))).not.toThrow();

    expect(lastCall(logger.error)![0]).toBe('POST ? failed: boom');
  });
});
