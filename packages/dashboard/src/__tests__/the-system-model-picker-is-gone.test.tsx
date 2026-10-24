// v3.5 A5 — OWNER RULING 2026-10-19: "there is a system model pulldown in the settings. Remove it.
// Those models are hard coded as the small decision and small writer." And 2026-10-20: the
// Summarization Model card STAYS, defaulting to the Dojo's small writer, every summary checked.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  stub.getSetting = vi.fn(async () => ({ ok: true, data: { value: '' } }));
  return stub;
});

import { ModelsTab } from '../components/settings/ModelsTab';
import * as RouterConfigModule from '../components/RouterConfig';

afterEach(() => { vi.clearAllMocks(); });

describe('Settings → Models', () => {
  it('has no System Model card, and the Summarization Model card says the writer is the default and is checked', async () => {
    render(<ModelsTab />);
    await waitFor(() => expect(screen.getByText('Summarization Model')).toBeTruthy());
    expect(screen.queryByText('System Model')).toBeNull();
    expect(screen.getByText(
      "Writes memory summaries when an agent compacts its history. The Dojo's small writer is the default and every summary is checked against the source before it is kept. If this box's summaries keep failing that check, pick a larger model here.",
    )).toBeTruthy();
    expect(screen.queryByText(/cheapest/)).toBeNull();
  });

  it('the System Model card component no longer exists', () => {
    expect((RouterConfigModule as Record<string, unknown>).SystemModelConfig).toBeUndefined();
  });
});
