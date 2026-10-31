import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: false, error: 'unmocked' })) : actual[key];
  }
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  const stable = fakeUseWebSocket();
  return { useWebSocket: () => stable, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});
const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

import * as api from '../lib/api';
import { TechniqueSessionProvider, useTechniqueSession } from '../components/TechniqueSessionProvider';
import type { TechniqueSessionApi } from '../components/TechniqueSessionProvider';

let session: TechniqueSessionApi;
const Probe = () => { session = useTechniqueSession(); return null; };

beforeEach(() => {
  resetFrames();
  navigate.mockClear();
  vi.mocked(api).getSetting.mockResolvedValue({ ok: true, data: { key: 'k', value: '' } } as never);
  vi.mocked(api).getChatHistory.mockResolvedValue({ ok: true, data: [] } as never);
  vi.mocked(api).request.mockImplementation((async (path: string, opts?: { method?: string }) => {
    if (path.endsWith('/publish')) return { ok: false, error: 'needs setup' };
    if (path === '/techniques/t1' && opts?.method === 'PUT') return { ok: true, data: {} };
    return { ok: false, error: 'not needed' };
  }) as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('publishing a technique', () => {
  it('stays on the Mat and says so when the publish call is refused', async () => {
    render(<MemoryRouter><TechniqueSessionProvider><Probe /></TechniqueSessionProvider></MemoryRouter>);
    act(() => { session.start('edit', 't1'); });
    await waitFor(() => expect(session.ready).toBe(true));
    act(() => { session.handleCanvasChange({ displayName: 'My technique' }); });
    await act(async () => { await session.saveTechnique(true); });
    expect(session.error).toContain('could not publish');
    expect(session.error).toContain('needs setup');
    expect(navigate).not.toHaveBeenCalledWith('/techniques/t1');
  });
});
