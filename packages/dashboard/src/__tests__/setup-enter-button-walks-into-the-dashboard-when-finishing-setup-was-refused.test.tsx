// 8115 — in setup, "Enter" stays on the wizard and says why when the server refuses to finish setup, and
// the Google sign-in wait has a Cancel so closing the Google window is not a dead end.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    completeSetup: vi.fn(async () => ({ ok: false, error: 'No primary agent' })),
    request: vi.fn(async (path: string) => {
      if (path === '/google/connect') return { ok: true, data: { authUrl: 'https://example.invalid/auth' } };
      return { ok: true, data: { connected: false, email: null } };
    }),
  };
});

import { WorkspaceStep } from '../pages/Setup';
import { LaunchButton } from '../components/SetupLaunchButton';

const Where = () => <div data-testid="where">{useLocation().pathname}</div>;

beforeEach(() => { vi.spyOn(window, 'open').mockImplementation(() => null); });

describe('the Enter button', () => {
  it('stays on the wizard and shows the sentence when setup is refused', async () => {
    render(<MemoryRouter initialEntries={['/setup']}><LaunchButton /><Where /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    await screen.findByText('No primary agent');
    expect(screen.getByTestId('where').textContent).toBe('/setup');
    expect((screen.getByRole('button', { name: 'Enter' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('the Google sign-in wait', () => {
  it('Cancel brings the Sign in button back', async () => {
    render(<MemoryRouter><WorkspaceStep /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Sign in with Google' }) as HTMLButtonElement).disabled).toBe(false));
  });
});
