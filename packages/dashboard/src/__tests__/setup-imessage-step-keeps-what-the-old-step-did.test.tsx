// The wizard's iMessage step keeps what the old step did: Skip, Next locked while editing, an honest failed welcome text.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const welcome = vi.hoisted(() => ({ result: { ok: true, data: {} } as { ok: boolean; data?: unknown; error?: string } }));
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    getSetting: vi.fn(async () => ({ ok: true, data: { value: null } })),
    setSetting: vi.fn(async () => ({ ok: true, data: {} })),
    request: vi.fn(async (path: string) => (String(path).includes('/system/imessage/welcome') ? welcome.result : { ok: true, data: {} })),
  };
});

import * as api from '../lib/api';
import { IMessageStep } from '../pages/Setup';

beforeEach(() => { vi.mocked(api.setSetting).mockClear(); welcome.result = { ok: true, data: {} }; });

const lastReady = (onReady: ReturnType<typeof vi.fn>) => onReady.mock.calls.at(-1)?.[0];
const enableAndAddOwner = async () => {
  fireEvent.click(await screen.findByRole('button', { pressed: false }));
  fireEvent.click(screen.getByRole('button', { name: /Add sender/ }));
  fireEvent.change(screen.getByPlaceholderText('+15551234567 or user@example.com'), { target: { value: '+15550001111' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add sender' }));
};

describe('the setup iMessage step', () => {
  it('Skip (Leave Disabled) saves the bridge off and opens Next', async () => {
    const onReady = vi.fn();
    render(<IMessageStep onReady={onReady} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip (Leave Disabled)' }));
    await waitFor(() => expect(lastReady(onReady)).toBe(true));
    expect(vi.mocked(api.setSetting).mock.calls.some((c) => c[0] === 'imessage_enabled' && c[1] === 'false')).toBe(true);
    expect(await screen.findByRole('status')).toBeTruthy();
  });
  it('an edit after the save shuts Next again', async () => {
    const onReady = vi.fn();
    render(<IMessageStep onReady={onReady} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip (Leave Disabled)' }));
    await waitFor(() => expect(lastReady(onReady)).toBe(true));
    fireEvent.click(screen.getByRole('button', { pressed: false }));
    await waitFor(() => expect(lastReady(onReady)).toBe(false));
  });
  it('a welcome text that goes says configured, in the green box', async () => {
    render(<IMessageStep />);
    await enableAndAddOwner();
    fireEvent.click(screen.getByRole('button', { name: /Save & Test iMessage/ }));
    expect((await screen.findByRole('status')).textContent).toContain('iMessage bridge configured!');
  });
  it('a welcome text that fails shows as a failure and never as configured', async () => {
    welcome.result = { ok: false, error: 'no permission' };
    render(<IMessageStep />);
    await enableAndAddOwner();
    fireEvent.click(screen.getByRole('button', { name: /Save & Test iMessage/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('the welcome message did not send: no permission');
    expect(screen.queryByText(/configured!/)).toBeNull();
  });
});
