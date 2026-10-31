// The first update check reaches out to the release server and can land late. A channel the owner
// switched to in the meantime must win: the buttons and release info follow the newest answer.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

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
import { UpdateTab } from '../components/settings/UpdateTab';

const mocked = () => vi.mocked(api);
const check = (channel: 'stable' | 'preflight', latest: string) =>
  ({ currentVersion: '1.0.0', latestVersion: latest, updateAvailable: true, channel }) as never;

beforeEach(() => {
  mocked().getDbBackupStatus.mockResolvedValue({ ok: true, data: { backup: null } } as never);
  mocked().listReleases.mockResolvedValue({ ok: true, data: { currentVersion: '1.0.0', releases: [] } } as never);
});

const isPrimary = (name: string) => screen.getByText(name).className.includes('btn--primary');

describe('Settings > Update', () => {
  it('keeps the channel just switched to when the slow first check lands afterwards', async () => {
    let landFirstCheck: (v: unknown) => void = () => {};
    mocked().checkForUpdates.mockReturnValue(new Promise((res) => { landFirstCheck = res; }) as never);
    mocked().getUpdateChannel.mockResolvedValue({ ok: true, data: { channel: 'stable' } } as never);
    mocked().setUpdateChannel.mockResolvedValue({ ok: true, data: { channel: 'preflight', check: check('preflight', '2.0.0-pre') } } as never);

    render(<UpdateTab />);
    await waitFor(() => expect(mocked().getUpdateChannel).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Preflight'));
    await waitFor(() => expect(isPrimary('Preflight')).toBe(true));

    await act(async () => { landFirstCheck({ ok: true, data: check('stable', '1.5.0') }); });
    expect(isPrimary('Preflight')).toBe(true);
    expect(isPrimary('Stable')).toBe(false);
    expect(screen.queryByText('1.5.0')).toBeNull();
    expect(screen.getByText('2.0.0-pre')).toBeTruthy();
    // The check button is not left stuck.
    expect(screen.getByText('Check for Updates')).toBeTruthy();
  });
});
