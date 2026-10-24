// v3.5 A5 — OWNER RULING 2026-10-19: "there is a system model pulldown in the settings. Remove it.
// Those models are hard coded as the small decision and small writer." And 2026-10-20: the
// Summarization Model card STAYS, defaulting to the Dojo's small writer, every summary checked.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const summaryCheck = vi.hoisted(() => ({ current: { writer: 'writer-small', failed: 0, total: 0, failing: false } as Record<string, unknown> }));
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  stub.getSetting = vi.fn(async () => ({ ok: true, data: { value: '' } }));
  stub.request = vi.fn(async (path: string) => (path === '/config/summary-check'
    ? { ok: true, data: summaryCheck.current }
    : { ok: true, data: [] }));
  return stub;
});

vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return { useToast: () => stub.value, ToastProvider: ({ children }: { children: unknown }) => children, ToastContainer: () => null };
});

import { ModelsTab } from '../components/settings/ModelsTab';
import { CompactionModelCard } from '../components/settings/CapabilityModelCards';
import * as RouterConfigModule from '../components/RouterConfig';

afterEach(() => { vi.clearAllMocks(); });

describe('Settings → Models', () => {
  it('has no System Model card, and the Summarization Model card says each agent\'s own model writes unless one is chosen (owner 2026-10-24)', async () => {
    render(<ModelsTab />);
    await waitFor(() => expect(screen.getByText('Summarization Model')).toBeTruthy());
    expect(screen.queryByText('System Model')).toBeNull();
    expect(screen.getByText(
      "Writes memory summaries when an agent compacts its history. Unless one model is chosen here, each agent's own model writes its summaries, and the Dojo's small local writer steps in only when that model cannot be reached.",
    )).toBeTruthy();
    expect(screen.queryByText(/cheapest/)).toBeNull();
  });

  // t268 fix round 2 (owner 2026-10-24, "The agents model."): with nothing chosen, the card says who writes.
  it('with no Summarization model chosen, the card says each agent\'s own model writes its summaries', async () => {
    const models = [{ id: 'm-chat', name: 'A chat model', capabilities: ['chat'], isEnabled: true, providerId: 'p' }] as unknown as Parameters<typeof CompactionModelCard>[0]['models'];
    render(<CompactionModelCard models={models} />);
    await waitFor(() => expect(screen.getByText("No model chosen here: each agent's own model writes its own summaries.")).toBeTruthy());
    expect(screen.queryByText(/Using the default: the Dojo's small writer/)).toBeNull();
  });

  it('the System Model card component no longer exists', () => {
    expect((RouterConfigModule as Record<string, unknown>).SystemModelConfig).toBeUndefined();
  });
});

describe('fix round 2 (iv): the Summarization card encourages a larger model when the writer is failing', () => {
  it('says so while the current writer fails its checks, and says nothing when it does not', async () => {
    summaryCheck.current = { writer: 'writer-small', failed: 3, total: 10, failing: true };
    const { unmount } = render(<ModelsTab />);
    await waitFor(() => expect(screen.getByText(
      "This box's memory summaries keep failing the accuracy check (3 of the last 10); those parts of the conversation are left as they are. A larger model may do better: pick one here.",
    )).toBeTruthy());
    unmount();
    summaryCheck.current = { writer: 'writer-small', failed: 0, total: 10, failing: false };
    render(<ModelsTab />);
    await waitFor(() => expect(screen.getByText('Summarization Model')).toBeTruthy());
    expect(screen.queryByText(/keep failing the accuracy check/)).toBeNull();
  });
});
