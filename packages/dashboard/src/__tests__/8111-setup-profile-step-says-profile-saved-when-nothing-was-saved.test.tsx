// The first-run profile step must only say "Profile saved!" (and open Next)
// when the server actually stored the name and the "about you" text.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    getSetting: vi.fn(async () => ({ ok: true, data: { value: null } })),
    getIdentity: vi.fn(async () => ({ ok: true, data: { content: '' } })),
    setSetting: vi.fn(async () => ({ ok: false, error: 'disk full' })),
    updateIdentity: vi.fn(async () => ({ ok: true, data: {} })),
  };
});

import * as api from '../lib/api';
import { YourProfileStep } from '../pages/Setup';

const fillAndSave = () => {
  const onReady = vi.fn();
  render(<YourProfileStep onReady={onReady} />);
  fireEvent.change(screen.getByPlaceholderText(/e\.g\., Alex/), { target: { value: 'Sam' } });
  fireEvent.change(screen.getByPlaceholderText(/small tech company/), { target: { value: 'I like short answers' } });
  fireEvent.click(screen.getByRole('button', { name: /save profile/i }));
  return onReady;
};

beforeEach(() => {
  vi.mocked(api.setSetting).mockReset();
  vi.mocked(api.updateIdentity).mockReset();
  vi.mocked(api.updateIdentity).mockResolvedValue({ ok: true, data: {} } as never);
});

describe('profile step honesty', () => {
  it('shows the refusal and does not claim the profile was saved', async () => {
    vi.mocked(api.setSetting).mockResolvedValue({ ok: false, error: 'disk full' } as never);
    const onReady = fillAndSave();
    await screen.findByText('disk full');
    expect(screen.queryByText('Profile saved!')).toBeNull();
    expect(onReady).not.toHaveBeenCalledWith(true);
    expect(api.updateIdentity).not.toHaveBeenCalled();
  });

  it('says saved when every call is accepted', async () => {
    vi.mocked(api.setSetting).mockResolvedValue({ ok: true, data: {} } as never);
    const onReady = fillAndSave();
    await screen.findByText('Profile saved!');
    await waitFor(() => expect(onReady).toHaveBeenCalledWith(true));
  });
});
