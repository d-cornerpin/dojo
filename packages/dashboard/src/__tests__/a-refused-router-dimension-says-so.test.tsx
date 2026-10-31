// A REFUSED ROUTER DIMENSION SAVE SAYS SO — Settings → Router must show the server's refusal,
// not silently snap the row back.
//
// `RouterTab.tsx` `handleUpdateDimension` awaited `api.updateDimension(...)` and reloaded without
// checking the answer, so a refused change (the server keeps the weights summing to 1) just snapped
// the control back and the owner never learned why. The sibling `handleUpdateTierModels` above it
// already toasts the refusal. The server here is the stubbed `api` module.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';

const REFUSAL = 'weights must sum to 1';
const toasts = vi.hoisted(() => ({ calls: [] as Array<{ level: string; message: string }> }));
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const t = fakeToast();
  toasts.calls = t.calls;
  return { useToast: () => t.value, ToastProvider: ({ children }: { children: ReactElement }) => children, ToastContainer: () => null };
});

// The permissive factory — every exported FUNCTION answers `{ ok: true, data: [] }`, every
// exported constant stays real — so the tab mounts on its own terms and the doors this file is
// about are the only overrides.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.clearToken = vi.fn(() => undefined);
  return stub;
});

import * as api from '../lib/api';
import { RouterTab } from '../components/settings/RouterTab';
import { ToastProvider } from '../hooks/useToast';

const mocked = () => vi.mocked(api);

beforeEach(() => {
  toasts.calls.length = 0;
  mocked().getRouterConfig.mockResolvedValue({
    ok: true,
    data: {
      tiers: [],
      dimensions: [{ id: 'task-fit', displayName: 'Task fit', weight: 0.5, isEnabled: true }],
      window: null,
    },
  } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('a refused router dimension save says so', () => {
  it('switching a dimension off against a refusal toasts the server\'s sentence', async () => {
    mocked().updateDimension.mockResolvedValue({ ok: false, error: REFUSAL } as never);
    render(<ToastProvider><RouterTab /></ToastProvider>);
    await screen.findByText('Task fit');
    fireEvent.click(document.querySelector('.toggle-switch') as HTMLElement);
    await waitFor(() => expect(api.updateDimension).toHaveBeenCalledWith('task-fit', { isEnabled: false }));
    await waitFor(() => expect(toasts.calls).toContainEqual({ level: 'error', message: REFUSAL }));
  });
});
