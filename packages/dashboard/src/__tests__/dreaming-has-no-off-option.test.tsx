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
  mocked().getDreamingConfig.mockResolvedValue({ ok: true, data: { modelId: null, dreamTime: '03:00' } } as never);
  mocked().getModels.mockResolvedValue({ ok: true, data: [] } as never);
  mocked().getLatestDream.mockResolvedValue({ ok: true, data: null } as never);
  mocked().updateDreamingConfig.mockResolvedValue({ ok: true, data: {} } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('saving the dreaming settings', () => {
  it('offers no dream mode and saves only the model and the time', async () => {
    render(<DreamingTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('radio')).toBeNull();
    await waitFor(() => expect(mocked().updateDreamingConfig).toHaveBeenCalledWith({ modelId: undefined, dreamTime: '03:00' }));
  });

  it('does not save defaults when the stored settings could not be read', async () => {
    mocked().getDreamingConfig.mockResolvedValue({ ok: false, error: 'down' } as never);
    render(<DreamingTab />);
    await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(mocked().updateDreamingConfig).not.toHaveBeenCalled();
  });
});
