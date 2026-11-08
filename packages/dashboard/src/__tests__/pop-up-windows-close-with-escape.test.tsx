// ════════════════════════════════════════════════════════════════════════════
// EVERY POP-UP WINDOW CLOSES ON ESCAPE AND BEHAVES LIKE A DIALOG.
//
// Twelve windows across Tracker, Agents, Memory, ContactsPanel, ModelsTab,
// MigrationExport and ImportWizard each hand-rolled their own `fixed inset-0`
// backdrop. None of them listened for Escape, none said `role="dialog"` to a
// screen reader, and focus could wander out of the window into the page behind
// it. Only `DojoTutorial` had ever bothered.
//
// The fix is one shared frame — `components/ModalShell` — and these clauses
// are its contract, unit-tested against the frame itself. The last clause
// proves the promise reaches a real window: the Tracker's create-project
// window, mounted exactly as the page mounts it, disappears on Escape.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

// The permissive factory `a-new-project-task-assignee-shows-the-truth.test.tsx`
// uses — every exported FUNCTION answers `{ ok: true, data: [] }`, every
// exported constant stays real — so the Tracker mounts on mocked doors.
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
    ToastContainer: () => null,
  };
});

import * as api from '../lib/api';
import { AuthProvider } from '../hooks/useAuth';
import { Tracker } from '../pages/Tracker';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { RightDockProvider } from '../components/RightDockProvider';
import { TechniqueSessionProvider } from '../components/TechniqueSessionProvider';
import { OrbProvider } from '../components/orb/OrbProvider';
import { ThemeProvider } from '../themes/ThemeProvider';
import { ModalShell } from '../components/ModalShell';

/** The shell `App.tsx` puts every page inside — same nesting as the smoke floor. */
const shell = (page: ReactElement) => (
  <MemoryRouter>
    <AuthProvider>
      <ThemeProvider>
        <OrbProvider>
          <ActiveAgentProvider>
            <RightDockProvider>
              <TechniqueSessionProvider>
                {page}
              </TechniqueSessionProvider>
            </RightDockProvider>
          </ActiveAgentProvider>
        </OrbProvider>
      </ThemeProvider>
    </AuthProvider>
  </MemoryRouter>
);

const mocked = () => vi.mocked(api);

/** A minimal window with two focusable buttons, as any call site uses it. */
const window_ = (onClose: () => void, extra?: { closeOnEscape?: boolean }) => (
  <ModalShell onClose={onClose} label="Unit window" {...extra}>
    <button type="button">First</button>
    <button type="button">Last</button>
  </ModalShell>
);

beforeEach(() => {
  resetFrames();
  mocked().getProjects.mockResolvedValue({ ok: true, data: [] } as never);
  mocked().getAgents.mockResolvedValue({
    ok: true,
    data: [{ id: 'a1', name: 'Helper', status: 'idle', agentType: 'standard' }],
  } as never);
  mocked().getTasks.mockResolvedValue({ ok: true, data: [] } as never);
  mocked().getTrackerHygiene.mockResolvedValue({ ok: false, error: 'x' } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('ModalShell', () => {
  it('Escape closes the window', () => {
    const onClose = vi.fn();
    render(window_(onClose));

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape does nothing while closeOnEscape is off', () => {
    const onClose = vi.fn();
    render(window_(onClose, { closeOnEscape: false }));

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('the panel is a modal dialog with a name', () => {
    render(window_(vi.fn()));

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Unit window');
  });

  it('opening moves focus into the panel', () => {
    render(window_(vi.fn()));

    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
  });

  it('closing returns focus to whatever opened the window', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(window_(vi.fn()));
    expect(document.activeElement).not.toBe(opener);

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('Tab from the last focusable wraps to the first', () => {
    render(window_(vi.fn()));
    const last = screen.getByRole('button', { name: 'Last' });
    last.focus();

    fireEvent.keyDown(last, { key: 'Tab' });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
  });
});

describe('the Tracker create-project window', () => {
  it('Escape closes it', async () => {
    render(shell(<Tracker />));
    fireEvent.click(await screen.findByRole('button', { name: '+ Create Project' }));
    await screen.findByRole('heading', { name: 'Create Project' });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Create Project' })).toBeNull());
  });
});
