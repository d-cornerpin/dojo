// After "Update Now" or a rollback the page reloads only when the server it reconnects to reports
// the expected new (or rolled-back) version. A server that still answers with the old version is
// not the restarted one; a failed update says so; nothing waits silently and nothing gives up on a
// timer. Each wait is tied to real signals: the version and the server's update-episode state.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactElement } from 'react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: false, error: 'not in this test' })) : actual[key];
  }
  return stub;
});
vi.mock('../components/DataBackupNotice', () => ({ DataBackupNotice: () => null }));
vi.mock('../components/DiskSpaceNotice', () => ({ DiskSpaceNotice: () => null }));

import * as api from '../lib/api';
import { waitForRestart } from '../lib/wait-for-restart';
import { UpdateTab } from '../components/settings/UpdateTab';

const mocked = () => vi.mocked(api);
type V = { version: string; episode: null | { phase: string; targetVersion: string | null; previousVersion: string | null; failedReason: string | null } };
const up = (version: string, episode: V['episode'] = null) => ({ ok: true, data: { version, episode } }) as never;
const down = () => ({ ok: false, error: 'Network error' }) as never;
const ep = (phase: string, targetVersion = '2.0.0') => ({ phase, targetVersion, previousVersion: '1.0.0', failedReason: null });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const run = (opts: Partial<Parameters<typeof waitForRestart>[0]> = {}) => {
  const ac = new AbortController();
  const statuses: string[] = [];
  const p = waitForRestart({ expectedVersion: '2.0.0', previousVersion: '1.0.0', signal: ac.signal, onStatus: (s) => statuses.push(s), ...opts });
  return { ac, p, statuses };
};
const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };

describe('waitForRestart', () => {
  it('does not accept the old server still answering with the old version, however long that lasts', async () => {
    mocked().getVersion.mockResolvedValue(up('1.0.0'));
    const { p, ac, statuses } = run();
    let settled = false; void p.then(() => { settled = true; });
    await tick(10 * 60_000);
    expect(settled).toBe(false);
    expect(statuses.length).toBeGreaterThan(0);
    ac.abort();
    expect(await p).toEqual({ state: 'cancelled' });
  });

  it('is ready when the server reports the expected version', async () => {
    mocked().getVersion.mockResolvedValueOnce(up('1.0.0')).mockResolvedValue(up('2.0.0'));
    const { p } = run();
    await tick(10_000);
    expect(await p).toEqual({ state: 'ready' });
  });

  it('treats a leading v on either side as the same version', async () => {
    mocked().getVersion.mockResolvedValue(up('v2.0.0'));
    const { p } = run();
    await tick(2_000);
    expect(await p).toEqual({ state: 'ready' });
  });

  it('without an expected version, needs a different version or a down-then-up', async () => {
    mocked().getVersion.mockResolvedValueOnce(up('1.0.0')).mockResolvedValueOnce(down()).mockResolvedValue(up('1.0.0'));
    const { p } = run({ expectedVersion: null });
    await tick(10_000);
    expect(await p).toEqual({ state: 'ready' });
  });

  it('says a rolled-back update failed, naming both versions', async () => {
    mocked().getVersion.mockResolvedValueOnce(down()).mockResolvedValue(up('1.0.0', ep('rolled-back')));
    const { p } = run();
    await tick(10_000);
    const r = await p;
    expect(r.state).toBe('failed');
    expect(r.state === 'failed' && r.message).toMatch(/2\.0\.0/);
    expect(r.state === 'failed' && r.message).toMatch(/1\.0\.0/);
  });

  it('says so when the update could not go back on its own', async () => {
    mocked().getVersion.mockResolvedValue(up('2.0.0', ep('failed-permanently', '2.0.0')));
    mocked().getVersion.mockResolvedValue(up('1.5.0', ep('failed-permanently')));
    const { p } = run();
    await tick(4_000);
    const r = await p;
    expect(r.state).toBe('failed');
  });

  it('ignores an old episode that belongs to a different target version', async () => {
    mocked().getVersion.mockResolvedValueOnce(up('1.0.0', ep('rolled-back', '0.9.0'))).mockResolvedValue(up('2.0.0'));
    const { p } = run();
    await tick(10_000);
    expect(await p).toEqual({ state: 'ready' });
  });

  it('is ready when the expected version runs, even if a leftover episode says rolled-back for it', async () => {
    mocked().getVersion.mockResolvedValue(up('2.0.0', ep('rolled-back', '2.0.0')));
    const { p } = run();
    await tick(2_000);
    expect(await p).toEqual({ state: 'ready' });
  });

  it('takes no episode as this request\'s when the expected version is unknown', async () => {
    mocked().getVersion.mockResolvedValue(up('1.0.0', ep('failed-permanently', '0.5.0')));
    const { p, ac } = run({ expectedVersion: null });
    let settled = false; void p.then(() => { settled = true; });
    await tick(30_000);
    expect(settled).toBe(false);
    ac.abort();
    await p;
  });

  it('after a few minutes the status says how long and points to the menu bar, and keeps waiting', async () => {
    mocked().getVersion.mockResolvedValue(down());
    const { p, ac, statuses } = run();
    await tick(4 * 60_000);
    expect(statuses[statuses.length - 1]).toMatch(/Still waiting after \d+ minutes.*menu bar/);
    ac.abort();
    expect(await p).toEqual({ state: 'cancelled' });
  });

  it('stops polling when cancelled', async () => {
    mocked().getVersion.mockResolvedValue(up('1.0.0'));
    const { p, ac } = run();
    await tick(5_000);
    ac.abort();
    expect(await p).toEqual({ state: 'cancelled' });
    const calls = mocked().getVersion.mock.calls.length;
    await tick(20_000);
    expect(mocked().getVersion.mock.calls.length).toBe(calls);
  });
});

describe('Update Now', () => {
  it('shows the failure and frees the button when the server rolled the update back', async () => {
    vi.stubGlobal('confirm', () => true);
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    mocked().checkForUpdates.mockResolvedValue({ ok: true, data: { currentVersion: '1.0.0', latestVersion: '2.0.0', updateAvailable: true, channel: 'stable' } } as never);
    mocked().getUpdateChannel.mockResolvedValue({ ok: true, data: { channel: 'stable' } } as never);
    mocked().getDbBackupStatus.mockResolvedValue({ ok: true, data: { backup: null } } as never);
    mocked().listReleases.mockResolvedValue({ ok: true, data: { currentVersion: '1.0.0', releases: [] } } as never);
    mocked().applyUpdate.mockResolvedValue({ ok: true, data: { message: 'Updated', previousVersion: '1.0.0', newVersion: '2.0.0', backupDir: '' } } as never);
    mocked().getVersion.mockResolvedValueOnce(down()).mockResolvedValue(up('1.0.0', ep('rolled-back')));

    render(<UpdateTab /> as ReactElement);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    fireEvent.click(screen.getByText('Update Now'));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText(/did not start/i)).toBeTruthy();
    expect(screen.getByText('Update Now')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });
});
