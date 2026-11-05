// ════════════════════════════════════════════════════════════════════════════
// A FAILED HEALER ANSWER SAYS SO — the Healer card acted only on `result.ok`.
//
// `handleApprove` and `handleDeny` (HealerVitals.tsx) both awaited
// `resolveHealerProposal` and then either mutated local state or did nothing:
// a refusal put the Approve button back with no word to the owner, and a
// failed deny threw the typed decline note away AND closed the open input, so
// the owner lost what he wrote without ever being told the request failed.
// The suggestion stays pending either way — the owner must know WHY nothing
// happened. This card has no toast hook, so the door's reason is rendered in
// place. The success path must keep moving the suggestion to the resolved
// list exactly as before.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

// The t143 door mock — real module kept, the three doors this card uses are
// replaced; the resolve door answers failure, which is the whole point.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    getHealerProposals: vi.fn(async () => ({
      ok: true,
      data: [{
        id: 'p1', title: 'Restart the thing', description: 'd', proposed_fix: 'fix',
        severity: 'warning', category: 'other', status: 'pending', confidence: 80,
        created_at: '2026-01-01 00:00:00', resolved_at: null, applied_at: null,
        evidence_json: null, user_note: null,
      }],
    })),
    getHealerActions: vi.fn(async () => ({ ok: true, data: [] })),
    resolveHealerProposal: vi.fn(async () => ({ ok: false, error: 'the healer is busy' })),
  };
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { HealerVitals } from '../components/HealerVitals';

const noteBox = (): HTMLInputElement =>
  screen.getByPlaceholderText(/what you'd rather do/i) as HTMLInputElement;

// The card hides itself completely once nothing is pending and the Healer has
// never acted, so one logged action is what keeps the resolved list on screen.
const oneAction = [{
  id: 'a1', diagnostic_id: null, category: 'other', description: 'Reopened the stalled run',
  agent_id: null, action_taken: 'restart_agent', result: 'success', created_at: '2026-01-01 00:00:00',
}];

beforeEach(() => {
  resetFrames();
  // Back to the documented state after any clause that overrode a door.
  vi.mocked(api.resolveHealerProposal).mockResolvedValue({ ok: false, error: 'the healer is busy' } as never);
  vi.mocked(api.getHealerActions).mockResolvedValue({ ok: true, data: [] } as never);
});

describe('the Healer card when the answer comes back failed', () => {
  it('⚠ a failed Approve tells the owner and keeps the suggestion', async () => {
    render(<HealerVitals />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('the healer is busy')).toBeTruthy();
    expect(screen.getByText('Restart the thing'), 'the suggestion is still pending').toBeTruthy();
  });

  it('⚠ a failed Deny keeps the typed note in the still-open box, and says so', async () => {
    render(<HealerVitals />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    fireEvent.change(noteBox(), { target: { value: 'not now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Deny' }));

    expect(await screen.findByText('the healer is busy')).toBeTruthy();
    expect(noteBox().value, 'the owner\'s note survives a failed request').toBe('not now');
  });

  it('a successful Approve still moves the suggestion to the resolved list', async () => {
    vi.mocked(api.resolveHealerProposal).mockResolvedValue({ ok: true, data: { status: 'approved' } } as never);
    vi.mocked(api.getHealerActions).mockResolvedValue({ ok: true, data: oneAction } as never);
    render(<HealerVitals />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('(approved, waiting on Healer)')).toBeTruthy();
    expect(screen.getByText('Restart the thing')).toBeTruthy();
  });
});
