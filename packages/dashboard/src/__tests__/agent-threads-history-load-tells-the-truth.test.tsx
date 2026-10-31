import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const handlers: Record<string, (e: unknown) => void> = {};
const getMsgs = vi.fn();
vi.mock('../lib/api', () => ({ getInterAgentMessages: (...a: unknown[]) => getMsgs(...a) }));
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    subscribe: (type: string, h: (e: unknown) => void) => { handlers[type] = h; return () => { delete handlers[type]; }; },
    reconnectCount: 0,
  }),
}));
vi.mock('../components/ActiveAgentProvider', () => ({
  useActiveAgent: () => ({ agentId: 'a1', agentName: 'Alpha' }),
}));

import { InterAgentLane } from '../pages/InterAgentLane';

const msg = (id: string, content: string) => ({
  id, threadId: 't-' + id, content, createdAt: '2026-01-01T00:00:00Z', senderName: 'Beta', sourceAgentId: 'b1',
});

beforeEach(() => { getMsgs.mockReset(); });

describe('Agent Threads history load', () => {
  it('a failed load says so, with Retry, and not "No inter-agent messages yet"', async () => {
    getMsgs.mockResolvedValueOnce({ ok: false, error: 'boom' });
    render(<InterAgentLane />);
    expect(await screen.findByText(/Could not load inter-agent messages: boom/)).toBeTruthy();
    expect(screen.queryByText(/No inter-agent messages yet/)).toBeNull();
    getMsgs.mockResolvedValueOnce({ ok: true, data: [msg('m1', 'hello there')] });
    fireEvent.click(screen.getByText('Retry'));
    expect(await screen.findByText(/hello there/)).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  it('a live message that arrives while history loads is kept', async () => {
    let resolve!: (v: unknown) => void;
    getMsgs.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    render(<InterAgentLane />);
    await waitFor(() => expect(handlers['interagent:message']).toBeTruthy());
    act(() => {
      handlers['interagent:message']({ type: 'interagent:message', agentId: 'a1', message: msg('live', 'arrived live') });
    });
    await act(async () => { resolve({ ok: true, data: [msg('old', 'from history')] }); });
    expect(await screen.findByText(/from history/)).toBeTruthy();
    expect(screen.getByText(/arrived live/)).toBeTruthy();
  });
});
