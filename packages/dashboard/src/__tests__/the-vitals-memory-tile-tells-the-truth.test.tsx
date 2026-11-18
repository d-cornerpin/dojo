// ════════════════════════════════════════════════════════════════════════════
// THE VITALS MEMORY TILE TELLS THE TRUTH.
//
// When the resources read failed, the memory tile fell back to the health
// read's `memory.used` - the Dojo's own heap, about 100 MB - and drew it
// against the Mac's whole memory as if it were the Mac's use. The Mac's figure
// comes from the resources read alone; when that read has no answer, the tile
// and the Resources row show the page's own `--`, not a figure for the wrong
// machine.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

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
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return {
    useToast: () => stub.value,
    ToastProvider: ({ children }: { children: ReactElement }) => children,
  };
});

import * as api from '../lib/api';
import { Health } from '../pages/Health';
import { AuthProvider } from '../hooks/useAuth';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { RightDockProvider } from '../components/RightDockProvider';
import { TechniqueSessionProvider } from '../components/TechniqueSessionProvider';
import { OrbProvider } from '../components/orb/OrbProvider';

/** Same nesting App.tsx puts every page in; see `every-major-page-mounts.test.tsx`. */
const shell = (page: ReactElement) => (
  <MemoryRouter>
    <AuthProvider>
      <OrbProvider>
        <ActiveAgentProvider>
          <RightDockProvider>
            <TechniqueSessionProvider>
              {page}
            </TechniqueSessionProvider>
          </RightDockProvider>
        </ActiveAgentProvider>
      </OrbProvider>
    </AuthProvider>
  </MemoryRouter>
);

// Shapes the render reads once loading clears; the default `data: []` would
// throw there. HEALTH also lets the test wait for the health read to land.
const HEALTH = { uptime: 3600, db: 'ok', agents: 3, memory: { used: 100, total: 1000 } };
const WATCHDOG = { running: true, lastHeartbeat: '2026-01-01T00:00:00.000Z', lastAlert: null };
const IM_BRIDGE = { enabled: false, connected: false };
// WatcherCards reads data.gmail.enabled etc. (WatcherCards.tsx:141); the default
// `data: []` has no .gmail and throws there once the fetch resolves. All three
// disabled → anyEnabled is false → the panel returns null.
const noWatcher = { enabled: false };
const WATCHERS = { gmail: noWatcher, outlook: noWatcher, teams: noWatcher };

beforeEach(() => {
  resetFrames();
  vi.mocked(api).getLogs.mockResolvedValue({ ok: true, data: [] } as never);
  vi.mocked(api).getHealth.mockResolvedValue({ ok: true, data: HEALTH } as never);
  vi.mocked(api).getResources.mockResolvedValue({ ok: false, error: 'down' } as never);
  vi.mocked(api).getWatchdogStatus.mockResolvedValue({ ok: true, data: WATCHDOG } as never);
  vi.mocked(api).getIMBridgeStatus.mockResolvedValue({ ok: true, data: IM_BRIDGE } as never);
  vi.mocked(api).getWatcherStatus.mockResolvedValue({ ok: true, data: WATCHERS } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('the Vitals memory tile', () => {
  it('shows -- when the resources read has no answer', async () => {
    render(shell(<Health />));
    const label = await screen.findByText('Memory', { selector: '.stat__label' });
    await waitFor(() => expect(screen.getByText('Uptime', { selector: '.stat__label' }).nextElementSibling!.textContent).not.toBe('--'));
    expect(label.nextElementSibling!.textContent).toBe('--');
  });
});
