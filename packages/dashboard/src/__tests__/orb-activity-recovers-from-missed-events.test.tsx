// The orb's task glyph recovers from frames missed while the socket was down, ignores job lists
// that arrive out of order, and is told again when the orb engine is replaced.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

const mk = vi.hoisted(() => () => ({ startTask: vi.fn(), endTask: vi.fn(), setEmotion: vi.fn() }));
const state = vi.hoisted(() => ({ orb: null as unknown as { startTask: ReturnType<typeof vi.fn>; endTask: ReturnType<typeof vi.fn>; setEmotion: ReturnType<typeof vi.fn> } }));
vi.mock('../components/orb/OrbProvider', () => ({ useDojoOrb: () => state.orb }));
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket };
});
vi.mock('../lib/api', () => ({
  listActiveGenerationJobs: vi.fn(),
  getAgents: vi.fn(),
}));

import * as api from '../lib/api';
import { useOrbActivity } from '../components/orb/useOrbActivity';
import { emitFrame, resetFrames, setReconnectCount } from './helpers/frames';

const jobs = api.listActiveGenerationJobs as unknown as ReturnType<typeof vi.fn>;
const agents = api.getAgents as unknown as ReturnType<typeof vi.fn>;
const Probe = () => { useOrbActivity(); return null; };
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  state.orb = mk();
  resetFrames();
  vi.clearAllMocks();
  jobs.mockResolvedValue({ ok: true, data: [] });
  agents.mockResolvedValue({ ok: true, data: [] });
});

describe('the orb activity hook', () => {
  it('ends a dreamer glyph whose end frame was missed during a reconnect', async () => {
    const { rerender } = render(<Probe />);
    await settle();
    act(() => emitFrame('engine:activity', { data: { phase: 'start', id: 'e1', kind: 'dreamer' } }));
    expect(state.orb.startTask).toHaveBeenCalledWith('dreamer', expect.anything());
    setReconnectCount(1);
    rerender(<Probe />);
    await settle();
    expect(state.orb.endTask).toHaveBeenCalled();
  });

  it('lets the later-issued job list win when answers arrive out of order', async () => {
    let first: (v: unknown) => void = () => {};
    let second: (v: unknown) => void = () => {};
    jobs.mockReset();
    jobs.mockImplementationOnce(() => new Promise((r) => { first = r; }));
    jobs.mockImplementationOnce(() => new Promise((r) => { second = r; }));
    render(<Probe />);
    act(() => emitFrame('generation_job:update', {}));
    await act(async () => { second({ ok: true, data: [] }); });
    await act(async () => { first({ ok: true, data: [{ id: 'j1', kind: 'image' }] }); });
    expect(state.orb.startTask).not.toHaveBeenCalled();
  });

  it('tells a replaced orb engine about the running job again', async () => {
    jobs.mockResolvedValue({ ok: true, data: [{ id: 'j1', kind: 'image' }] });
    const { rerender } = render(<Probe />);
    await settle();
    expect(state.orb.startTask).toHaveBeenCalledTimes(1);
    const fresh = mk();
    state.orb = fresh;
    rerender(<Probe />);
    await settle();
    expect(fresh.startTask).toHaveBeenCalledTimes(1);
  });
});
