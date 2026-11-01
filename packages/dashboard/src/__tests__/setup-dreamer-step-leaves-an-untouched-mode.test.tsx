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
  it('does not send a mode the owner did not touch', async () => {
    fns.getDreamingConfig.mockResolvedValue(ok({ modelId: 'm1', dreamTime: '03:00', dreamMode: 'off' }));
    render(<DreamerStep />);
    await screen.findByText(/Saved/);
    fireEvent.change(document.querySelector('input[type="time"]')!, { target: { value: '04:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fns.updateDreamingConfig).toHaveBeenCalled());
    const sent = fns.updateDreamingConfig.mock.calls[0][0];
    expect(sent.dreamTime).toBe('04:30');
    expect('dreamMode' in sent).toBe(false);
  });
  it('sends the mode once the owner picks one', async () => {
    fns.getDreamingConfig.mockResolvedValue(ok({ modelId: 'm1', dreamTime: '03:00', dreamMode: 'off' }));
    render(<DreamerStep />);
    await screen.findByText(/Saved/);
    fireEvent.click(screen.getByRole('radio', { name: /Light Dream/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fns.updateDreamingConfig).toHaveBeenCalledWith(expect.objectContaining({ dreamMode: 'light' })));
  });
});
