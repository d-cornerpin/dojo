// ════════════════════════════════════════════════════════════════════════════
// PLAUD LOGIN — CANCEL MUST NOT REPORT A FAILURE, AND A REPLACED CHILD MUST
// NOT CLOBBER THE LIVE LOGIN
//
// OWNER REPORT: `startPlaudLogin` keeps ONE long-lived child in the module
// variable `loginProcess`. When the owner presses Cancel on the Connect modal,
// `cancelPlaudLogin` sends SIGTERM; the child then exits with `code = null,
// signal = 'SIGTERM'`, and the exit handler's `wasSuccessful` is false — so the
// dashboard receives `plaud:login_failed` ("Plaud CLI exited with code SIGTERM.")
// for something the owner did on purpose. Worse, if the owner cancels and
// presses Connect again at once, the OLD child's exit event later clears
// `loginProcess`/`pendingLoginUrl` even though the NEW child is the live login:
// `isLoginInProgress()` turns false, a third click starts a second login on top
// of the new one, and Cancel no longer reaches it. The `error` handler has the
// same shape.
//
// THE SHAPE OF THE FIX: in the `exit` and `error` handlers, when the child
// that fired is no longer `loginProcess` (it was cancelled or replaced), do
// nothing to the shared state and broadcast nothing — logging is fine. A
// cancelled login must NOT broadcast `plaud:login_failed`. Everything else
// stays: a genuine non-zero exit of the current child still broadcasts
// `login_failed`, a zero exit still marks connected and broadcasts
// `plaud:connected`, a second `startPlaudLogin` while one runs still returns
// `{ started: false, alreadyRunning: true }`, and auth-URL capture is unchanged.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';

// ── The subprocess, faked at the process boundary ──
// A minimal EventEmitter stand-in so the test can drive the child's
// `exit`/`error`/`data` events without importing node:events in the hoisted
// factory. Each `spawn` call hands back a fresh child with `stdout`/`stderr`
// members and a `kill` spy.
vi.mock('node:child_process', () => {
  class Emitter {
    private handlers: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
    on(event: string, fn: (...args: unknown[]) => void): void {
      this.handlers.push({ event, fn });
    }
    emit(event: string, ...args: unknown[]): void {
      for (const h of this.handlers) if (h.event === event) h.fn(...args);
    }
  }
  const makeChild = (): Record<string, unknown> => {
    const child = new Emitter() as unknown as Record<string, unknown>;
    child.stdout = new Emitter();
    child.stderr = new Emitter();
    child.kill = vi.fn(() => undefined);
    return child;
  };
  return { spawn: vi.fn(() => makeChild()) };
});

vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../db/connection.js', () => ({ getDb: () => { throw new Error('no db'); } }));
vi.mock('../../agent/tool-config-generation.js', () => ({ bumpToolConfigGeneration: vi.fn() }));
vi.mock('../client.js', () => ({
  runPlaudCommand: vi.fn(async () => ({ ok: false, stdout: '', stderr: '' })),
  runPlaudJson: vi.fn(async () => ({ ok: false })),
}));

const { startPlaudLogin, cancelPlaudLogin, isLoginInProgress } = await import('../auth.js');
const { broadcast } = await import('../../gateway/ws.js');
const spawnMock = vi.mocked(spawn);

const childAt = (i: number): Record<string, unknown> =>
  spawnMock.mock.results[i].value as unknown as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  // Cancel any login left in progress so each test starts from a clean state.
  cancelPlaudLogin();
});

describe('a cancelled login does not report a failure', () => {
  it('THE RED: cancel + SIGTERM exit broadcasts NO plaud:login_failed', async () => {
    await startPlaudLogin();
    expect(cancelPlaudLogin()).toEqual({ cancelled: true });

    const child = childAt(0);
    child.emit('exit', null, 'SIGTERM');

    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'plaud:login_failed' }));
    expect(isLoginInProgress()).toBe(false);
  });

  it('a replaced login is not clobbered by the OLD child exit', async () => {
    await startPlaudLogin();          // child A
    expect(cancelPlaudLogin()).toEqual({ cancelled: true });
    await startPlaudLogin();          // child B
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // The OLD child's exit arrives after B is the live login.
    childAt(0).emit('exit', null, 'SIGTERM');

    // B is still the live login: state must not have been cleared by A's exit.
    expect(isLoginInProgress()).toBe(true);
    expect(cancelPlaudLogin()).toEqual({ cancelled: true });
    expect((childAt(1).kill as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('the genuine outcomes still work', () => {
  it('a real non-zero exit of the current child broadcasts login_failed', async () => {
    await startPlaudLogin();
    childAt(0).emit('exit', 1, null);

    expect(broadcast).toHaveBeenCalledWith({
      type: 'plaud:login_failed',
      error: 'Plaud CLI exited with code 1.',
    });
    expect(isLoginInProgress()).toBe(false);
  });

  it('a second start while a login runs returns alreadyRunning and does not spawn again', async () => {
    await startPlaudLogin();
    const second = await startPlaudLogin();
    expect(second).toEqual({ started: false, alreadyRunning: true });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('captures the auth URL and broadcasts it exactly once', async () => {
    await startPlaudLogin();
    const child = childAt(0);
    child.stdout.emit('data', Buffer.from('open https://example.com/auth?x=1 to sign in'));

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({ type: 'plaud:auth_url', url: 'https://example.com/auth?x=1' });

    child.stdout.emit('data', Buffer.from('another https://other.example/auth to sign in'));
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});

describe('the spawn error handler', () => {
  it('an error on the CURRENT child broadcasts login_failed and clears state', async () => {
    await startPlaudLogin();
    childAt(0).emit('error', new Error('ENOENT'));

    expect(broadcast).toHaveBeenCalledWith({ type: 'plaud:login_failed', error: 'ENOENT' });
    expect(isLoginInProgress()).toBe(false);
  });

  it('the same error on a cancelled (stale) child broadcasts nothing', async () => {
    await startPlaudLogin();          // child A
    expect(cancelPlaudLogin()).toEqual({ cancelled: true });

    childAt(0).emit('error', new Error('ENOENT'));

    expect(broadcast).not.toHaveBeenCalled();
  });
});
