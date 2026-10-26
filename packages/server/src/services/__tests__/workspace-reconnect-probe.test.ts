// ════════════════════════════════════════════════════════════════════════
// services/workspace-reconnect-probe — TWO TIMER/LOG DEFECTS, DRIVEN WITH FAKE TIMERS.
//
// (a) `startWorkspaceReconnectProbe` schedules the first sweep with a bare
//     `setTimeout(..., FIRST_PROBE_DELAY_MS)` whose handle is never stored, so
//     `stopWorkspaceReconnectProbe` clears only the interval. A probe stopped
//     inside its first 5 minutes still sweeps — and calls the providers'
//     reconnect attempts — afterwards. §2 and §4 prove the stop must cancel it.
//
// (b) that same first sweep ends in `sweep().catch(() => { /* logged inside */ })`,
//     but `sweep()` only logs per-account failures; a top-level throw (the
//     `import(...)`/`listReconnectable*Accounts()` awaits) rejects with NO log.
//     §3 proves the first sweep must log it the same way the interval does.
//
// No real provider is contacted: both auth modules are mocked, and the logger is
// captured so a swallowed failure cannot hide.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startWorkspaceReconnectProbe, stopWorkspaceReconnectProbe } from '../workspace-reconnect-probe.js';

const log = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => log.logger,
}));

const ms = vi.hoisted(() => ({
  listReconnectableMicrosoftAccounts: vi.fn(),
  attemptMicrosoftReconnect: vi.fn(),
}));
vi.mock('../../microsoft/auth.js', () => ({
  listReconnectableMicrosoftAccounts: ms.listReconnectableMicrosoftAccounts,
  attemptMicrosoftReconnect: ms.attemptMicrosoftReconnect,
}));

const google = vi.hoisted(() => ({
  listReconnectableGoogleAccounts: vi.fn(),
  attemptGoogleReconnect: vi.fn(),
}));
vi.mock('../../google/auth.js', () => ({
  listReconnectableGoogleAccounts: google.listReconnectableGoogleAccounts,
  attemptGoogleReconnect: google.attemptGoogleReconnect,
}));

const FIRST = 5 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  ms.listReconnectableMicrosoftAccounts.mockReturnValue([{ id: 'ms1' }]);
  google.listReconnectableGoogleAccounts.mockReturnValue([]);
  ms.attemptMicrosoftReconnect.mockResolvedValue('reconnected');
  google.attemptGoogleReconnect.mockResolvedValue('reconnected');
});

afterEach(() => {
  stopWorkspaceReconnectProbe();
  vi.useRealTimers();
});

describe('workspace reconnect probe', () => {
  it('case 1: the first sweep re-tests a benched Microsoft account', async () => {
    startWorkspaceReconnectProbe();
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(ms.attemptMicrosoftReconnect).toHaveBeenCalledTimes(1);
  });

  it('case 2: a stop cancels the first sweep too — no provider call after stop', async () => {
    startWorkspaceReconnectProbe();
    stopWorkspaceReconnectProbe();
    await vi.advanceTimersByTimeAsync(FIRST + 1000);
    expect(ms.attemptMicrosoftReconnect).not.toHaveBeenCalled();
  });

  it('case 3: a throwing list is logged, not swallowed', async () => {
    ms.listReconnectableMicrosoftAccounts.mockImplementation(() => { throw new Error('boom'); });
    startWorkspaceReconnectProbe();
    await vi.advanceTimersByTimeAsync(FIRST);
    const errCalls = log.logger.error.mock.calls;
    expect(errCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(errCalls)).toContain('boom');
  });

  it('case 4: starting again after a stop schedules a fresh first sweep', async () => {
    startWorkspaceReconnectProbe();
    stopWorkspaceReconnectProbe();
    startWorkspaceReconnectProbe();
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(ms.attemptMicrosoftReconnect).toHaveBeenCalledTimes(1);
  });
});
