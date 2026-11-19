import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fns = vi.hoisted(() => ({ getModels: vi.fn(), getDreamingConfig: vi.fn(), updateDreamingConfig: vi.fn() }));
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, ...fns };
});
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));

import { DreamerStep } from '../pages/Setup';

const ok = (data: unknown) => ({ ok: true, data });
beforeEach(() => {
  for (const f of Object.values(fns)) f.mockReset();
  fns.getModels.mockResolvedValue(ok([]));
  fns.updateDreamingConfig.mockResolvedValue(ok({}));
});

describe('setup Dreamer step', () => {
  it('offers no dream mode and saves only the model and the time', async () => {
    fns.getDreamingConfig.mockResolvedValue(ok({ modelId: 'm1', dreamTime: '03:00' }));
    render(<DreamerStep />);
    await screen.findByText(/Saved/);
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.change(document.querySelector('input[type="time"]')!, { target: { value: '04:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fns.updateDreamingConfig).toHaveBeenCalledWith({ modelId: 'm1', dreamTime: '04:30' }));
  });
});
