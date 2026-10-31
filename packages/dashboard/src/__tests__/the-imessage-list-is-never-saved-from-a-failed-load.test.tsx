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
