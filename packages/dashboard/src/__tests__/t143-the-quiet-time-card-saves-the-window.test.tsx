// ════════════════════════════════════════════════════════════════════════════════════════
// t143 (OR-LONG-JOBS) — THE "LONG JOBS" CARD IS THE OWNER'S DOOR TO THE PER-AGENT SILENT WINDOW.
//
// The owner confirmed the 2-hour window AS A PER-AGENT SETTING, so a known-slow agent can be
// given longer. This card sits in the agent's settings beside the Memory card and writes the one
// field the server reads (`PUT /agents/:id { silentWindowMinutes }`). Mounted for real; only the
// network door and the toast queue are replaced.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { AgentDetail } from '@dojo/shared';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, updateAgentConfig: vi.fn(async () => ({ ok: true, data: {} })) };
});
const toasts = vi.hoisted(() => ({ success: [] as string[], error: [] as string[] }));
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({
    success: (m: string) => { toasts.success.push(m); },
    error: (m: string) => { toasts.error.push(m); },
  }),
  ToastProvider: ({ children }: { children: ReactElement }) => children,
}));

import * as api from '../lib/api';
import { QuietTimeCard, DEFAULT_QUIET_MINUTES } from '../components/QuietTimeCard';

const agent = (silentWindowMinutes: number | null): AgentDetail =>
  ({ id: 'helper', name: 'Helper', silentWindowMinutes } as unknown as AgentDetail);
const field = (): HTMLInputElement => screen.getByLabelText(/Quiet time before you are told/i) as HTMLInputElement;

beforeEach(() => {
  vi.mocked(api.updateAgentConfig).mockClear();
  toasts.success.length = 0;
  toasts.error.length = 0;
});

describe('the Long jobs card', () => {
  it('an unset agent shows the 2-hour default as the placeholder, not as a stored value', () => {
    render(<QuietTimeCard agent={agent(null)} onUpdated={() => {}} />);
    expect(field().value).toBe('');
    expect(field().placeholder).toBe(String(DEFAULT_QUIET_MINUTES));
    expect(DEFAULT_QUIET_MINUTES).toBe(120);
  });

  it('saving 10 minutes writes silentWindowMinutes: 10 through the agent door', async () => {
    const onUpdated = vi.fn();
    render(<QuietTimeCard agent={agent(null)} onUpdated={onUpdated} />);
    fireEvent.change(field(), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(api.updateAgentConfig).toHaveBeenCalledWith('helper', { silentWindowMinutes: 10 }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
  });

  it('clearing the field sends null — back to the default — and a bad value is refused before the network', async () => {
    render(<QuietTimeCard agent={agent(300)} onUpdated={() => {}} />);
    expect(field().value).toBe('300');
    fireEvent.change(field(), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(api.updateAgentConfig).not.toHaveBeenCalled();
    expect(toasts.error).toHaveLength(1);
    fireEvent.change(field(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(api.updateAgentConfig).toHaveBeenCalledWith('helper', { silentWindowMinutes: null }));
  });
});
