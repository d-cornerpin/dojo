// The "Administrator privileges" dropdown must show what the server enforces: a refused save puts
// the old choice back and says why; a failed read leaves the dropdown disabled with a Retry.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));

import * as api from '../lib/api';
import { SudoPolicyCard } from '../components/settings/SecurityTab';

const mocked = () => vi.mocked(api);
const select = () => screen.getByLabelText('admin privileges policy') as HTMLSelectElement;

beforeEach(() => {
  mocked().getSetting.mockReset().mockResolvedValue({ ok: true, data: { key: 'k', value: 'blocked' } } as never);
  mocked().setSetting.mockReset();
});

describe('admin privileges policy dropdown', () => {
  it('goes back to the stored choice and shows the reason when a save is refused', async () => {
    mocked().setSetting.mockResolvedValue({ ok: false, error: 'nope' } as never);
    render(<SudoPolicyCard />);
    await waitFor(() => expect(select().disabled).toBe(false));
    expect(select().value).toBe('blocked');
    fireEvent.change(select(), { target: { value: 'free' } });
    expect(await screen.findByText(/nope/)).toBeTruthy();
    await waitFor(() => expect(select().value).toBe('blocked'));
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it('stays disabled with a Retry when the stored policy cannot be read', async () => {
    mocked().getSetting.mockResolvedValue({ ok: false, error: 'offline' } as never);
    render(<SudoPolicyCard />);
    expect(await screen.findByText(/Could not read the current policy: offline/)).toBeTruthy();
    expect(select().disabled).toBe(true);

    mocked().getSetting.mockResolvedValue({ ok: true, data: { key: 'k', value: 'free' } } as never);
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(select().disabled).toBe(false));
    expect(select().value).toBe('free');
    expect(screen.queryByText(/Could not read/)).toBeNull();
  });

  it('keeps the new choice and says Saved. when the save succeeds', async () => {
    mocked().setSetting.mockResolvedValue({ ok: true, data: { key: 'k', value: 'free' } } as never);
    render(<SudoPolicyCard />);
    await waitFor(() => expect(select().disabled).toBe(false));
    fireEvent.change(select(), { target: { value: 'free' } });
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(select().value).toBe('free');
  });
});
