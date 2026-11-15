// 8105 — In Settings > Models, a refused price save, price-unit switch or thinking switch shows the
// server's reason and shows the value the server actually kept.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';

const toasts = vi.hoisted(() => ({ calls: [] as Array<{ level: string; message: string }> }));
vi.mock('../hooks/useToast', () => {
  const rec = (level: string) => (message: string) => { toasts.calls.push({ level, message }); };
  const value = { toasts: [], addToast: () => {}, addActionToast: () => {}, removeToast: () => {}, removeToastByKey: () => {}, info: rec('info'), success: rec('success'), warning: rec('warning'), error: rec('error') };
  return { useToast: () => value, ToastProvider: ({ children }: { children: ReactElement }) => children };
});
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    updateModelPricing: vi.fn(async () => ({ ok: false, error: 'nope' })),
    updateModelThinking: vi.fn(async () => ({ ok: false, error: 'nope' })),
  };
});

import { ModelRow } from '../components/settings/ModelRows';

const MODEL = {
  id: 'm1', name: 'Test model', apiModelId: 'test-model', providerId: 'p', capabilities: ['image_generation', 'thinking'],
  isEnabled: true, inputCostPerM: 1, outputCostPerM: 2, pricingUnit: 'token', thinkingEnabled: true,
} as never;
const renderRow = () => render(<ModelRow model={MODEL} providerType="openrouter" isPrimaryModel={false} onToggle={() => {}} onPricingChange={() => {}} />);

beforeEach(() => { toasts.calls.length = 0; });

describe('a refused change in a model row', () => {
  it('a refused unit switch goes back to the unit the server kept and says why', async () => {
    renderRow();
    const token = screen.getByRole('button', { name: 'Token' });
    fireEvent.click(screen.getByRole('button', { name: 'Megapixel' }));
    await waitFor(() => expect(toasts.calls.map((c) => c.message)).toContain('nope'));
    expect(token.className).toContain('bg-cp-amber/20');
    expect(screen.getByRole('button', { name: 'Megapixel' }).className).not.toContain('bg-cp-amber/20');
  });
  it('a refused thinking switch goes back and says why', async () => {
    renderRow();
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(toasts.calls.map((c) => c.message)).toContain('nope'));
    expect(box.checked).toBe(true);
  });
  it('a refused price save says why', async () => {
    renderRow();
    const input = screen.getAllByRole('spinbutton')[0];
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    await waitFor(() => expect(toasts.calls.map((c) => c.message)).toContain('nope'));
  });
});
