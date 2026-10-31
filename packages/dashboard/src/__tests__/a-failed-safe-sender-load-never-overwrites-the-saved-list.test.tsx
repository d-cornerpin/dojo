// ════════════════════════════════════════════════════════════════════════════
// A FAILED LOAD OF A SAFE-SENDER LIST NEVER BECOMES THE BASE OF A SAVE.
//
// The list decides who the agent may auto-reply to. If it could not be read, the
// panel says so and offers Retry; no edit is offered, nothing is written. Edits
// are built on the last list that was read, and carry the stored text they were
// built on so the server can refuse a stale one.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const getSetting = vi.hoisted(() => vi.fn());
const setSetting = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, getSetting, setSetting };
});

import { ChannelSafeSenders } from '../components/ChannelSafeSenders';

const entry = (address: string) => ({ address, name: address, is_primary: false, sharing_level: 'dont_overshare' });
const GOOD = JSON.stringify([entry('a@x.test'), entry('b@x.test')]);

const mount = () => render(
  <ChannelSafeSenders configKey="gmail_approved_senders_acct1" channelLabel="Gmail" description="d" addressPlaceholder="name@x.test" />,
);

beforeEach(() => {
  getSetting.mockReset();
  setSetting.mockReset();
  setSetting.mockResolvedValue({ ok: true, data: { key: 'k', value: 'v' } });
});

describe('a safe-sender list that could not be loaded', () => {
  it('says so, offers Retry, offers no edit and writes nothing', async () => {
    getSetting.mockResolvedValue({ ok: false, error: 'server not ready' });
    mount();
    await waitFor(() => expect(screen.getByText('Retry')).toBeTruthy());
    expect(screen.queryByText(/List is empty/)).toBeNull();
    expect(screen.queryByText(/Add safe gmail sender/)).toBeNull();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('treats an unreadable stored value the same way', async () => {
    getSetting.mockResolvedValue({ ok: true, data: { key: 'k', value: '{not json' } });
    mount();
    await waitFor(() => expect(screen.getByText('Retry')).toBeTruthy());
    expect(screen.queryByText(/Add safe gmail sender/)).toBeNull();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('Retry loads the real list and edits then build on it', async () => {
    getSetting.mockResolvedValueOnce({ ok: false, error: 'x' }).mockResolvedValue({ ok: true, data: { key: 'k', value: GOOD } });
    mount();
    fireEvent.click(await screen.findByText('Retry'));
    await screen.findByText('Add safe gmail sender'.replace('Add', '+ Add'));
    fireEvent.click(screen.getAllByTitle(/^Remove /)[0]);
    await waitFor(() => expect(setSetting).toHaveBeenCalledTimes(1));
    const [, value, base] = setSetting.mock.calls[0];
    expect(JSON.parse(value).map((s: { address: string }) => s.address)).toEqual(['b@x.test']);
    expect(base).toBe(GOOD);
  });
});

describe('edits on a good load', () => {
  it('a second edit builds on the first, not on the first load', async () => {
    getSetting.mockResolvedValue({ ok: true, data: { key: 'k', value: GOOD } });
    mount();
    await screen.findByText('+ Add safe gmail sender');
    fireEvent.click(screen.getAllByTitle(/^Remove /)[0]);
    await waitFor(() => expect(setSetting).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByTitle(/^Remove /).length).toBe(1));
    fireEvent.click(screen.getAllByTitle(/^Remove /)[0]);
    await waitFor(() => expect(setSetting).toHaveBeenCalledTimes(2));
    expect(JSON.parse(setSetting.mock.calls[1][1])).toEqual([]);
    expect(setSetting.mock.calls[1][2]).toBe(setSetting.mock.calls[0][1]);
  });

  it('a refused (out-of-date) save shows the server message and reloads the current list', async () => {
    getSetting.mockResolvedValue({ ok: true, data: { key: 'k', value: GOOD } });
    setSetting.mockResolvedValue({ ok: false, error: 'This list changed since you loaded it, so it was not saved.' });
    mount();
    await screen.findByText('+ Add safe gmail sender');
    fireEvent.click(screen.getAllByTitle(/^Remove /)[0]);
    await screen.findByText(/changed since you loaded it/);
    expect(getSetting).toHaveBeenCalledTimes(2);
  });
});
