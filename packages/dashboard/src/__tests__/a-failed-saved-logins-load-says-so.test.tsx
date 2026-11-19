import { describe, it, expect, vi, afterEach } from 'vitest';
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
  return { useToast: () => stub.value, ToastProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { CredentialsPanel } from '../components/CredentialsPanel';

afterEach(() => { vi.clearAllMocks(); });

describe('the saved logins list', () => {
  it('a failed load says so, with Retry, and never says none are stored', async () => {
    vi.mocked(api.listCredentials).mockResolvedValue({ ok: false, error: 'down' } as never);
    render(<CredentialsPanel />);
    expect(await screen.findByText(/Could not load your saved logins/)).toBeTruthy();
    expect(screen.queryByText(/No credentials stored yet/)).toBeNull();
    vi.mocked(api.listCredentials).mockResolvedValue({ ok: true, data: { credentials: [] } } as never);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText(/No credentials stored yet/)).toBeTruthy());
  });
});
