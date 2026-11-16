// A slow answer for technique A never fills the Mat once technique B is open, and a chat history
// that could not be read never starts the Trainer on a fresh session.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const request = vi.hoisted(() => vi.fn());
const getSetting = vi.hoisted(() => vi.fn());
const getChatHistory = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, request, getSetting, getChatHistory };
});
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));

import { TechniqueSessionProvider, useTechniqueSession, type TechniqueSessionApi } from '../components/TechniqueSessionProvider';

let latest: TechniqueSessionApi;
const Probe = () => { latest = useTechniqueSession(); return null; };
const mount = () => render(<MemoryRouter><TechniqueSessionProvider><Probe /></TechniqueSessionProvider></MemoryRouter>);
const tech = (id: string) => ({ ok: true, data: { id, name: `Name ${id}`, description: '', tags: [], instructions: '', files: [], updatedAt: 'u', state: 'draft', directoryPath: '/x' } });

beforeEach(() => {
  request.mockReset(); getSetting.mockReset(); getChatHistory.mockReset();
  getSetting.mockResolvedValue({ ok: true, data: { key: 'k', value: 'trainer-1' } });
  getChatHistory.mockResolvedValue({ ok: true, data: [] });
});

describe('the technique session', () => {
  it('a late load for technique A never fills the Mat while B is open', async () => {
    let resolveA!: (v: unknown) => void;
    request.mockImplementation((path: string) => {
      if (path === '/techniques/A') return new Promise((r) => { resolveA = r; });
      if (path === '/techniques/B') return Promise.resolve(tech('B'));
      return Promise.resolve({ ok: true, data: {} });
    });
    mount();
    act(() => latest.start('edit', 'A'));
    act(() => latest.start('edit', 'B'));
    await waitFor(() => expect(latest.canvas.name).toBe('B'));
    await act(async () => { resolveA(tech('A')); await Promise.resolve(); await Promise.resolve(); });
    expect(latest.canvas.name).toBe('B');
    expect(latest.canvas.displayName).toBe('Name B');
  });

  it('an unreadable chat history does not start the Trainer on a fresh session', async () => {
    getChatHistory.mockResolvedValue({ ok: false, error: 'down' });
    request.mockResolvedValue({ ok: true, data: {} });
    mount();
    await waitFor(() => expect(getSetting).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    act(() => latest.start('new'));
    await waitFor(() => expect(latest.ready).toBe(true));
    expect(request.mock.calls.some((c) => c[0] === '/chat/trainer-1/new-session')).toBe(false);
  });

  it('a history that was read and does not match starts a fresh session', async () => {
    getChatHistory.mockResolvedValue({ ok: true, data: [{ role: 'user', content: 'something else' }, { role: 'assistant', content: 'x' }] });
    request.mockResolvedValue({ ok: true, data: {} });
    mount();
    await act(async () => { await Promise.resolve(); });
    act(() => latest.start('new'));
    await waitFor(() => expect(latest.ready).toBe(true));
    expect(request.mock.calls.some((c) => c[0] === '/chat/trainer-1/new-session')).toBe(true);
  });
});
