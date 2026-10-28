// ════════════════════════════════════════════════════════════════════════════
// A FAILED IMPORT'S RETRY MUST RUN THE IMPORT AGAIN.
//
// When `/migration/import` fails, the restore step shows the error and a Retry
// button. The restore is STARTED by an effect that fires once when the step is
// entered — but by the time Retry is clickable the wizard is already on that
// step, so "set the step again" changes nothing: the effect never re-runs, the
// button looks live and does nothing, and the owner can only close the wizard
// and begin again. Retry must call the restore itself. The wizard is mounted
// for real; only the network door and the websocket are replaced.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, request: vi.fn() };
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { ImportWizard } from '../components/ImportWizard';

// The first import hits a full disk; the retried one succeeds.
let importAttempts = 0;

const importCalls = (): number =>
  vi.mocked(api.request).mock.calls.filter((c) => c[0] === '/migration/import').length;

beforeEach(() => {
  importAttempts = 0;
  vi.mocked(api.request).mockImplementation((async (path: string) => {
    if (path === '/migration/manifest') {
      return { ok: true, data: { exported_from: { hostname: 'old-mac' }, contents: {} } };
    }
    if (path === '/migration/preflight') {
      return {
        ok: true,
        data: {
          manifest: {
            contents: {
              database_size_bytes: 0, agents_count: 0, techniques_count: 0,
              vault_entries_count: 0, providers: [], ollama_models: [],
            },
          },
          integrityOk: true, passwordOk: true, diskOk: true, freeBytes: 1e9,
        },
      };
    }
    if (path === '/migration/import') {
      importAttempts += 1;
      return importAttempts === 1 ? { ok: false, error: 'disk full' } : { ok: true, data: { checks: [] } };
    }
    return { ok: true, data: {} };
  }) as never);
});

// Pick a file, type the password, scan, press Import — until the restore step
// shows the failure.
async function importUntilItFails() {
  const { container } = render(<ImportWizard />);
  fireEvent.change(container.querySelector('input[type=file]') as HTMLInputElement,
    { target: { files: [new File(['x'], 'dojo.zip')] } });
  await waitFor(() => expect(screen.getByText('dojo.zip')).toBeTruthy());
  fireEvent.change(container.querySelector('input[type=password]') as HTMLInputElement,
    { target: { value: 'longenough1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
  await waitFor(() => expect(screen.getByText('Archive integrity')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Import' }));
  await waitFor(() => expect(screen.getByText('disk full')).toBeTruthy());
}

describe('the import retry', () => {
  it('a failed import shows the real error and a Retry button on the restore step', async () => {
    await importUntilItFails();
    expect(screen.getByText('disk full')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('clicking Retry runs the import again — the door gets a second /migration/import', async () => {
    await importUntilItFails();
    expect(importCalls()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(importCalls()).toBe(2));
  });

  it('after the retried import succeeds, the wizard moves on to the dependencies', async () => {
    await importUntilItFails();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(
      screen.queryByText('Dependencies installed.') ?? screen.queryByText('Installing dependencies…'),
    ).toBeTruthy());
  });
});
