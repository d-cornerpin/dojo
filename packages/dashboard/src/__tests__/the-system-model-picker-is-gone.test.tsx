// v3.5 A5: OWNER RULING 2026-10-19: "there is a system model pulldown in the settings. Remove it.
// Those models are hard coded as the small decision and small writer." And v3.5 field fix 3, OWNER RULING verbatim:
// "I was very clear that there was not to be a summarization/compaction model setting and that each agents own model
// would do the compaction summarization." So the Summarization Model card is gone too (deleted, not hidden), with its
// failing-check banner and the route it read.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const asked = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  stub.getSetting = vi.fn(async () => ({ ok: true, data: { value: '' } }));
  stub.request = vi.fn(async (path: string) => { asked.paths.push(path); return { ok: true, data: [] }; });
  return stub;
});

vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return { useToast: () => stub.value, ToastProvider: ({ children }: { children: unknown }) => children };
});

import { ModelsTab } from '../components/settings/ModelsTab';
import * as CapabilityCards from '../components/settings/CapabilityModelCards';
import * as RouterConfigModule from '../components/RouterConfig';

afterEach(() => { vi.clearAllMocks(); asked.paths.length = 0; });

describe('Settings → Models', () => {
  it('has no System Model card and no Summarization Model card', async () => {
    render(<ModelsTab />);
    await waitFor(() => expect(screen.getByText('Fallback Vision Model')).toBeTruthy());
    expect(screen.queryByText('System Model')).toBeNull();
    expect(screen.queryByText('Summarization Model')).toBeNull();
    expect(screen.queryByText(/Summarization model/i)).toBeNull();
    expect(screen.queryByText(/keep failing the accuracy check/)).toBeNull();
    expect(asked.paths).not.toContain('/config/summary-check');
  });

  it('the System Model and Summarization Model card components no longer exist', () => {
    expect((RouterConfigModule as Record<string, unknown>).SystemModelConfig).toBeUndefined();
    expect((CapabilityCards as Record<string, unknown>).CompactionModelCard).toBeUndefined();
  });
});
