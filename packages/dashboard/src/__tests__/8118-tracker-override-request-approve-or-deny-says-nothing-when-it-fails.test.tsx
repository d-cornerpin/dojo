// An override request the server refuses must say so: the owner typed a reason,
// clicked Approve, and (before) nothing at all happened on screen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  return stub;
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  (globalThis as { __toast?: unknown }).__toast = stub;
  return { useToast: () => stub.value, ToastProvider: ({ children }: { children: ReactElement }) => children, ToastContainer: () => null };
});

import * as api from '../lib/api';
import { OverrideQueuePanel } from '../components/OverrideQueuePanel';

const row = {
  id: 'o1', requested_by: 'worker', requested_status: 'done', attempts_attached: 1,
  task_id: 'abcdefgh1234', task_title: 'A task', task_goal: null, justification: 'because',
  last_engine_error: null, created_at: '2026-10-27T00:00:00.000Z',
} as unknown as api.OverrideRequestRow;

beforeEach(() => { vi.spyOn(window, 'prompt').mockReturnValue('because'); });
afterEach(() => { vi.restoreAllMocks(); });

describe('a refused override decision says so', () => {
  it('shows the server error and does not refresh the list', async () => {
    vi.mocked(api.resolveOverrideRequest).mockResolvedValue({ ok: false, error: 'already resolved' } as never);
    const onResolved = vi.fn();
    render(<OverrideQueuePanel overrides={[row]} onResolved={onResolved} />);
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(vi.mocked(api.resolveOverrideRequest)).toHaveBeenCalled());
    const stub = (globalThis as unknown as { __toast: { calls: Array<{ level: string; message: string }> } }).__toast;
    await waitFor(() => expect(stub.calls).toContainEqual({ level: 'error', message: 'already resolved' }));
    expect(onResolved).not.toHaveBeenCalled();
  });
});
