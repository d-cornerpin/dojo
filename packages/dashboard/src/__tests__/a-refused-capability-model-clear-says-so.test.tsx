// A CLEAR THE SERVER REFUSES IS TOLD TO, NOT HIDDEN.
// The card's Save button checks the server's answer and toasts on refusal; its Clear button used to
// discard that answer — a refused clear emptied the selection and flashed "Saved!" over a model the
// server kept.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';

const toast = vi.hoisted(() => ({ calls: [] as Array<{ level: string; message: string }> }));
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  return stub;
});
vi.mock('../hooks/useToast', () => {
  const record = (level: string) => (message: string) => { toast.calls.push({ level, message }); };
  const value = { toasts: [], addToast: () => {}, addActionToast: () => {}, removeToast: () => {}, removeToastByKey: () => {}, info: record('info'), success: record('success'), warning: record('warning'), error: record('error') };
  return { useToast: () => value, ToastProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { FallbackVisionModelCard } from '../components/settings/CapabilityModelCards';

const models = [{ id: 'm-chat', name: 'A vision model', isEnabled: true, capabilities: ['vision'] }] as never;
const select = () => screen.getByRole('combobox') as HTMLSelectElement;

beforeEach(() => {
  toast.calls.length = 0;
  vi.mocked(api.getSetting).mockResolvedValue({ ok: true, data: { key: 'dojo_fallback_vision_model_id', value: 'm-chat' } } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('the capability model Clear button', () => {
  it('a refused clear is told, keeps the stored choice and does not say Saved', async () => {
    vi.mocked(api.setSetting).mockResolvedValue({ ok: false, error: 'nope' } as never);
    render(<FallbackVisionModelCard models={models} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(toast.calls).toContainEqual({ level: 'error', message: 'nope' }));
    expect(screen.queryByText('Saved!')).toBeNull();
    expect(select().value).toBe('m-chat');
  });

  it('a cleared model empties the selection and says Saved', async () => {
    vi.mocked(api.setSetting).mockResolvedValue({ ok: true, data: {} } as never);
    render(<FallbackVisionModelCard models={models} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.getByText('Saved!')).toBeTruthy());
    expect(select().value).toBe('');
  });
});
