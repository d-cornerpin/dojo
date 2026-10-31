import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  getDreamingConfig: vi.fn(),
  getModels: vi.fn(),
  getLatestDream: vi.fn(),
  updateDreamingConfig: vi.fn(),
  triggerDream: vi.fn(),
}));
vi.mock('../components/settings/CapabilityModelCards', () => ({ HealerCard: () => null }));

import * as api from '../lib/api';
import { DreamingTab } from '../components/settings/DreamingTab';

const mocked = () => vi.mocked(api);

beforeEach(() => {
  mocked().getDreamingConfig.mockResolvedValue({ ok: true, data: { modelId: null, dreamTime: '03:00', dreamMode: 'off' } } as never);
  mocked().getModels.mockResolvedValue({ ok: true, data: [] } as never);
  mocked().getLatestDream.mockResolvedValue({ ok: true, data: null } as never);
  mocked().updateDreamingConfig.mockResolvedValue({ ok: true, data: {} } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('saving the dreaming settings', () => {
  it('shows an off dreamer as Off', async () => {
    render(<DreamingTab />);
    const off = await screen.findByRole('radio', { name: /Off/ });
    expect((off as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /Full Dream/ }) as HTMLInputElement).checked).toBe(false);
  });

  it('keeps it off when only the time is changed', async () => {
    render(<DreamingTab />);
    await screen.findByRole('radio', { name: /Off/ });
    fireEvent.change(document.querySelector('input[type="time"]')!, { target: { value: '04:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocked().updateDreamingConfig).toHaveBeenCalled());
    expect(mocked().updateDreamingConfig).toHaveBeenCalledWith(expect.objectContaining({ dreamTime: '04:30', dreamMode: 'off' }));
  });

  it('saves Full when the owner picks it', async () => {
    render(<DreamingTab />);
    fireEvent.click(await screen.findByRole('radio', { name: /Full Dream/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocked().updateDreamingConfig).toHaveBeenCalledWith(expect.objectContaining({ dreamMode: 'full' })));
  });

  it('does not save defaults when the stored settings could not be read', async () => {
    mocked().getDreamingConfig.mockResolvedValue({ ok: false, error: 'down' } as never);
    render(<DreamingTab />);
    const save = await screen.findByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save);
    expect(mocked().updateDreamingConfig).not.toHaveBeenCalled();
  });
});
