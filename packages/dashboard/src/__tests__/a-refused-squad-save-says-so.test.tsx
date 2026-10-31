// ════════════════════════════════════════════════════════════════════════════
// A REFUSED SQUAD SAVE SAYS SO — `GroupCard.handleSave` awaited `updateGroupApi`
// and then closed the editor and reloaded whatever the server answered, so a
// refused rename left the old name on screen, the editor gone, the typed text
// lost and not one word about it. A refusal must toast, keep the editor open
// with what was typed, and NOT reload; an accepted save closes and reloads once.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The permissive factory the smoke floor uses — every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real — so the card
// mounts on its own terms and the door this file is about is the only override.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.clearToken = vi.fn(() => undefined);
  return stub;
});

import * as api from '../lib/api';
import type { AgentGroup } from '../lib/api';
import { ToastProvider, ToastContainer } from '../hooks/useToast';
import { GroupCard } from '../components/GroupCard';

const GROUP: AgentGroup = {
  id: 'g1',
  name: 'Atlas',
  description: 'the crew',
  createdBy: 'owner',
  color: '#888888',
  memberCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const renderCard = () => {
  const onReload = vi.fn();
  render(
    <ToastProvider>
      <GroupCard group={GROUP} agents={[]} models={[]} providerNameById={{}} onReload={onReload} />
      <ToastContainer />
    </ToastProvider>,
  );
  return onReload;
};

const renameAndSave = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByDisplayValue('Atlas'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
};

beforeEach(() => {
  vi.mocked(api.updateGroupApi).mockResolvedValue({ ok: true, data: [] });
});
afterEach(() => { vi.clearAllMocks(); });

describe('a refused squad save says so', () => {
  it('the refusal is toasted, the editor stays open with the typed text, nothing reloads', async () => {
    vi.mocked(api.updateGroupApi).mockResolvedValue({ ok: false, error: 'name taken' });
    const onReload = renderCard();

    renameAndSave('Renamed');

    await waitFor(() => expect(screen.getByText('name taken')).toBeTruthy());
    expect((screen.getByDisplayValue('Renamed') as HTMLInputElement).value).toBe('Renamed');
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(onReload).not.toHaveBeenCalled();
  });

  it('an accepted save closes the editor and reloads once', async () => {
    const onReload = renderCard();

    renameAndSave('Renamed');

    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    expect(screen.queryByDisplayValue('Renamed')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
