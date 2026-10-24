// v3.5 A6 — A LOCAL MODEL THAT WILL NOT FIT IS REFUSED BY THE SERVER, AND THE PERSON IS TOLD WHY.
// Owner ruling 2026-10-19: "Pop up an error letting them know why." No new UX: the server's refusal
// sentence rides the dashboard's existing toast. Before this, the Summarization card and a router
// tier discarded the server's answer and said "Saved!" over a refusal.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';

const SENTENCE = 'big-local:9b needs about 6.4 GB of memory. This box has 16 GB; after the desktop, the engine, the embedder and the Dojo\'s own two models, about 2.5 GB is open. Choose a smaller local model or a cloud model.';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  return stub;
});
const toast = vi.hoisted(() => ({ calls: [] as Array<{ level: string; message: string }> }));
vi.mock('../hooks/useToast', () => {
  const record = (level: string) => (message: string) => { toast.calls.push({ level, message }); };
  const value = { toasts: [], addToast: () => {}, addActionToast: () => {}, removeToast: () => {}, removeToastByKey: () => {}, info: record('info'), success: record('success'), warning: record('warning'), error: record('error') };
  return { useToast: () => value, ToastProvider: ({ children }: { children: ReactElement }) => children, ToastContainer: () => null };
});

import * as api from '../lib/api';
import { CompactionModelCard } from '../components/settings/CapabilityModelCards';

beforeEach(() => {
  toast.calls.length = 0;
  vi.mocked(api.getSetting).mockResolvedValue({ ok: true, data: { key: 'compaction_model_id', value: '' } } as never);
  vi.mocked(api.setSetting).mockResolvedValue({ ok: false, error: SENTENCE } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('the Summarization card', () => {
  it('shows the server\'s refusal and does not say Saved', async () => {
    const models = [{ id: 'm-big', name: 'big-local:9b', isEnabled: true, capabilities: ['chat'] }] as never;
    render(<CompactionModelCard models={models} />);
    await waitFor(() => expect(screen.getByText('Summarization Model')).toBeTruthy());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'm-big' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.calls).toContainEqual({ level: 'error', message: SENTENCE }));
    expect(screen.queryByText('Saved!')).toBeNull();
  });
});
