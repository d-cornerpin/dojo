// ════════════════════════════════════════════════════════════════════════════
// THE MEMORY PAGE IGNORES LATE ANSWERS — the DAG tab can end up showing the
// previous agent's summaries, and the Entries tab the previous search's rows.
//
// `Memory.tsx` `loadDag` awaits `getMemoryDag(agentId)` and then writes the
// summaries with no check that the agent is still the selected one, and
// `loadVault` re-runs on every keystroke in the search box and writes whichever
// answer lands LAST. So a slow answer for the old agent (or for "ab") can land
// after a newer one and overdraw the page: the select says agent B but every
// node is agent A's, the box says "abc" but the rows are "ab"'s. This file
// drives the honest surface: an older request's answer is ignored, so the
// newest agent's DAG and the newest search's entries stay put.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { resetFrames } from './helpers/frames';

// The permissive factory the smoke floor uses — every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real — so the page
// mounts on its own terms and the doors this file is about are the only overrides.
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
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: unknown }) => children };
});
// The Entries tab renders `VaultStats`, which calls `useToast()`.
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return { useToast: () => stub.value, ToastProvider: ({ children }: { children: unknown }) => children };
});

import * as api from '../lib/api';
import type { Summary } from '@dojo/shared';
import { Memory } from '../pages/Memory';

const mocked = () => vi.mocked(api);

// The page starts on the 'primary' alias (Memory.tsx `useState('primary')`),
// so agent A is the one named 'primary' — its first DAG answer is the slow one.
const AGENT_A = { id: 'primary', name: 'Agent A' };
const AGENT_B = { id: 'beta', name: 'Agent B' };

// Agent A's DAG answer and the "ab" search answer, each held until the test
// lets it resolve.
let heldDagA: ((v: unknown) => void) | null = null;
let heldAb: ((v: unknown) => void) | null = null;

// `Summary` has no title field — DagTree shows `summary.content`.
const makeSummary = (content: string, agentId: string): Summary => ({
  id: `sum-${content}`,
  agentId,
  depth: 0,
  kind: 'leaf',
  content,
  tokenCount: 12,
  earliestAt: '2026-10-30T00:00:00.000Z',
  latestAt: '2026-10-30T00:00:00.000Z',
  descendantCount: 1,
  createdAt: '2026-10-30T00:00:00.000Z',
});

const makeEntry = (content: string): api.VaultEntry => ({
  id: `entry-${content}`,
  agentId: 'primary',
  agentName: 'Agent A',
  type: 'fact',
  content,
  context: null,
  confidence: 0.9,
  isPermanent: false,
  tags: [],
  isPinned: false,
  isObsolete: false,
  supersededBy: null,
  retrievalCount: 0,
  lastRetrievedAt: null,
  sourceConversationId: null,
  source: 'dream',
  citation: null,
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
});

beforeEach(() => {
  resetFrames();
  heldDagA = null;
  heldAb = null;
  mocked().getAgents.mockResolvedValue({ ok: true, data: [AGENT_A, AGENT_B] } as never);
  mocked().getSetting.mockResolvedValue({ ok: false, error: 'x' } as never);
  mocked().getVaultStats.mockResolvedValue({
    ok: true,
    data: {
      totalEntries: 1, byType: {}, permanentCount: 0, pinnedCount: 0,
      avgConfidence: 0.9, retrievedToday: 0, unprocessedArchives: 0, lastDreamAt: null,
    },
  } as never);
  // Agent A's DAG answer stays in flight; every other agent answers at once.
  mocked().getMemoryDag.mockImplementation((agentId: string) =>
    agentId === AGENT_A.id
      ? new Promise((res) => { heldDagA = res; })
      : Promise.resolve({ ok: true, data: { summaries: [makeSummary('B-summary', agentId)], links: [] } }),
  );
  // An "ab" search stays in flight; "abc" answers at once with its own entry.
  mocked().getVaultEntries.mockImplementation((params?: { search?: string }) =>
    params?.search === 'ab'
      ? new Promise((res) => { heldAb = res; })
      : Promise.resolve({ ok: true, data: params?.search === 'abc' ? [makeEntry('abc-entry')] : [] }),
  );
});
afterEach(() => { vi.clearAllMocks(); });

describe('the memory page ignores late answers', () => {
  it('a late DAG answer for the previous agent does not replace the new agent\'s DAG', async () => {
    render(<Memory />);
    await screen.findByRole('tab', { name: 'DAG' });
    // The page's first DAG load (agent A) is still in flight.
    await waitFor(() => expect(heldDagA).not.toBeNull());

    fireEvent.click(screen.getByRole('tab', { name: 'DAG' }));
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: AGENT_B.id } });
    await screen.findByText('B-summary');

    await act(async () => {
      heldDagA!({ ok: true, data: { summaries: [makeSummary('A-summary', AGENT_A.id)], links: [] } });
    });

    expect(screen.queryByText('A-summary'), 'agent A\'s late answer redrew agent B\'s DAG').toBeNull();
    expect(screen.getByText('B-summary')).toBeTruthy();
  });

  it('a late answer for the previous search does not replace the newer search\'s entries', async () => {
    render(<Memory />);
    const input = screen.getByLabelText('Search vault');

    fireEvent.change(input, { target: { value: 'ab' } });
    await waitFor(() => expect(heldAb).not.toBeNull());

    fireEvent.change(input, { target: { value: 'abc' } });
    await screen.findByText('abc-entry');

    await act(async () => {
      heldAb!({ ok: true, data: [makeEntry('ab-entry')] });
    });

    expect(screen.queryByText('ab-entry'), 'the "ab" answer redrew the "abc" search').toBeNull();
    expect(screen.getByText('abc-entry')).toBeTruthy();
  });
});
