// 8113 — in setup, the iMessage step does not say "saved" or send the welcome text when the server
// refused to store the approved sender list.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    getSetting: vi.fn(async () => ({ ok: true, data: { value: null } })),
    setSetting: vi.fn(async (key: string) => (key === 'imessage_approved_senders' ? { ok: false, error: 'locked' } : { ok: true, data: {} })),
    request: vi.fn(async () => ({ ok: true, data: {} })),
  };
});

import * as api from '../lib/api';
import { IMessageStep } from '../pages/Setup';

beforeEach(() => { vi.mocked(api.request).mockClear(); });

describe('the iMessage setup step', () => {
  it('shows the refusal, sends no welcome message and does not report ready', async () => {
    const onReady = vi.fn();
    render(<IMessageStep onReady={onReady} />);
    fireEvent.click(await screen.findByRole('button', { pressed: false }));   // enable the bridge
    fireEvent.click(screen.getByRole('button', { name: /Add sender/ }));      // opens the add form
    fireEvent.change(screen.getByPlaceholderText('+15551234567 or user@example.com'), { target: { value: '+15550001111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add sender' }));
    fireEvent.click(screen.getByRole('button', { name: /Save & Test iMessage/ }));
    await screen.findByText(/locked/);
    expect(vi.mocked(api.request).mock.calls.some((c) => String(c[0]).includes('/system/imessage/welcome'))).toBe(false);
    await waitFor(() => expect(onReady).not.toHaveBeenCalledWith(true));
    expect(screen.queryByText(/configured!/)).toBeNull();
  });
});
