// The iMessage approved-senders card follows the same rule as the channel lists: a list that could
// not be read is never shown as empty or saved over; a save names the stored text it was built on.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const getSetting = vi.hoisted(() => vi.fn());
const setSetting = vi.hoisted(() => vi.fn());
const request = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, getSetting, setSetting, request };
});

import { IMBridgeSettings } from '../components/settings/IMBridgeSettings';

const STORED = JSON.stringify([{ address: 'a@x.test', name: 'A', is_primary: true, sharing_level: 'open_book' }]);
const ok = (value: string | null) => ({ ok: true, data: { key: 'k', value } });

beforeEach(() => {
  getSetting.mockReset(); setSetting.mockReset(); request.mockReset();
  request.mockResolvedValue({ ok: true, data: {} });
  setSetting.mockResolvedValue(ok('v'));
});

describe('the iMessage approved-senders card', () => {
  it('a failed load shows Retry, offers no Save and writes nothing', async () => {
    getSetting.mockImplementation(async (k: string) => k === 'imessage_approved_senders' ? { ok: false, error: 'x' } : ok('true'));
    render(<IMBridgeSettings />);
    await screen.findByText('Retry');
    expect(screen.queryByText('Save')).toBeNull();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('an unreadable stored list is treated the same way', async () => {
    getSetting.mockImplementation(async (k: string) => k === 'imessage_approved_senders' ? ok('{oops') : ok('true'));
    render(<IMBridgeSettings />);
    await screen.findByText('Retry');
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('a save names the stored text it was built on, and the list is written first', async () => {
    getSetting.mockImplementation(async (k: string) => k === 'imessage_approved_senders' ? ok(STORED) : ok('true'));
    render(<IMBridgeSettings />);
    fireEvent.click(await screen.findByText(/^Save/));
    await waitFor(() => expect(setSetting).toHaveBeenCalled());
    expect(setSetting.mock.calls[0][0]).toBe('imessage_approved_senders');
    expect(setSetting.mock.calls[0][2]).toBe(STORED);
  });

  it('a refused list save shows the server message and writes nothing else', async () => {
    getSetting.mockImplementation(async (k: string) => k === 'imessage_approved_senders' ? ok(STORED) : ok('true'));
    setSetting.mockResolvedValue({ ok: false, error: 'This list changed since you loaded it, so it was not saved.' });
    render(<IMBridgeSettings />);
    fireEvent.click(await screen.findByText(/^Save/));
    await screen.findByText(/changed since you loaded it/);
    expect(setSetting).toHaveBeenCalledTimes(1);
  });
});

describe('the iMessage on/off switch read', () => {
  it('a failed read of whether the bridge is on is also a failed load', async () => {
    getSetting.mockImplementation(async (k: string) => k === 'imessage_enabled' ? { ok: false, error: 'x' } : ok(STORED));
    render(<IMBridgeSettings />);
    await screen.findByText('Retry');
    expect(setSetting).not.toHaveBeenCalled();
  });
});

// Owner ruling: the star (the owner entry) never moves on its own; removing it is a deliberate, confirmed act.
const TWO = JSON.stringify([
  { address: 'a@x.test', name: 'A', is_primary: true, sharing_level: 'open_book' },
  { address: 'b@x.test', name: 'B', is_primary: false, sharing_level: 'dont_overshare' },
]);

describe('the owner star', () => {
  const open = async () => {
    getSetting.mockImplementation(async (k: string) => k === 'imessage_approved_senders' ? ok(TWO) : ok('true'));
    const view = render(<IMBridgeSettings />);
    await screen.findByText('a@x.test');
    return view;
  };

  it('removing the starred owner (confirmed) leaves NO owner, says so to the server, and clears the legacy keys', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = await open();
    fireEvent.click(container.querySelectorAll('button.ml-2')[0] as HTMLElement);   // the x on the first (starred) row
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(setSetting).toHaveBeenCalled());
    const [key, value, , opts] = setSetting.mock.calls[0];
    expect(key).toBe('imessage_approved_senders');
    expect(JSON.parse(value).map((s: { is_primary: boolean }) => s.is_primary)).toEqual([false]);
    expect(opts).toEqual({ ownerChange: true });
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith('imessage_default_sender', ''));
  });

  it('declining the confirm removes nothing', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { container } = await open();
    fireEvent.click(container.querySelectorAll('button.ml-2')[0] as HTMLElement);
    expect(screen.getByText('a@x.test')).toBeTruthy();
  });

  it('removing a non-owner entry asks nothing and does not touch the owner', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = await open();
    fireEvent.click(container.querySelectorAll('button.ml-2')[1] as HTMLElement);
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(setSetting).toHaveBeenCalled());
    const [, value, , opts] = setSetting.mock.calls[0];
    expect(JSON.parse(value)).toHaveLength(1);
    expect(opts).toEqual({ ownerChange: false });
  });

  it('a list that arrives with no starred entry is shown without an owner and saved without one', async () => {
    const NONE = JSON.stringify([{ address: 'a@x.test', name: 'A', is_primary: false, sharing_level: 'dont_overshare' }]);
    getSetting.mockImplementation(async (k: string) => k === 'imessage_approved_senders' ? ok(NONE) : ok('true'));
    render(<IMBridgeSettings />);
    fireEvent.click(await screen.findByText('Save'));
    await waitFor(() => expect(setSetting).toHaveBeenCalled());
    expect(JSON.parse(setSetting.mock.calls[0][1])[0].is_primary).toBe(false);
  });
});
