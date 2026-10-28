// ════════════════════════════════════════════════════════════════════════════
// A FAILED DEPENDENCY CHECK OFFERS A WAY OUT, NOT A SPINNER FOREVER.
//
// The first-run check can fail while the server is still starting. The rows must
// not stay on "checking" with nothing to press: the failure lands as 'failed'
// with the server's message on every row, so the owner sees why and "Retry All"
// appears. The second answer is the good one — the same door, one round later.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const request = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, request };
});

vi.mock('../components/settings/StandardModels', () => ({ StandardModels: () => null }));

import { SetupDeps } from '../components/SetupDeps';

const CHECK_FAILED = { ok: false, error: 'server not ready' };
const CHECK_OK = {
  ok: true,
  data: {
    node: { installed: true, version: 'v20' },
    brew: { installed: true },
    ollama: { installed: true, running: true },
    cliclick: { installed: true },
    playwright: { installed: true },
    nomic: { installed: true },
    gws: { installed: true },
    gcloud: { installed: true },
  },
};

// The first GET /setup/deps/check fails (the server was still starting); every
// check after it answers installed. Every other path answers an empty list.
beforeEach(() => {
  request.mockClear();
  let checks = 0;
  request.mockImplementation((path: string) => {
    if (path === '/setup/deps/check') {
      checks += 1;
      return Promise.resolve(checks === 1 ? CHECK_FAILED : CHECK_OK);
    }
    return Promise.resolve({ ok: true, data: [] });
  });
});

describe('a failed dependency check', () => {
  it('says the check failed and offers Retry All', async () => {
    render(<SetupDeps onReady={() => {}} />);
    await waitFor(() => expect(screen.getAllByText('server not ready').length).toBeGreaterThan(0));
    expect(screen.getByText('Retry All')).toBeTruthy();
  });

  it('Retry All re-checks, and the second answer reaches ready', async () => {
    const onReady = vi.fn();
    render(<SetupDeps onReady={onReady} />);
    const retryAll = await screen.findByText('Retry All');
    fireEvent.click(retryAll);
    await waitFor(() => expect(onReady).toHaveBeenCalledWith(true));
  });
});
