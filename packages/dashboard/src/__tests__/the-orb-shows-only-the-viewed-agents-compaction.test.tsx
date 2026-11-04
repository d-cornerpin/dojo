// v3.5 field fix 3 (#10): the orb's compaction glyph belongs to the agent on screen. Field report 3,
// Problem 5: the orb was box-wide, so a service agent's housekeeping (the PM ran 11 turns in 3.5
// minutes, each iteration running the routine check) read as the owner's own agent compacting.
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
  listActiveGenerationJobs: vi.fn(async () => ({ ok: true, data: [] })),
  getAgents: vi.fn(async () => ({ ok: true, data: [] })),
  getSetting: vi.fn(async (key: string) => ({ ok: true, data: { key, value: null } })),
}));

import { useOrbActivity } from '../components/orb/useOrbActivity';
import { resetEngineRoleIds } from '../lib/engine-role-ids';
import { emitFrame, resetFrames } from './helpers/frames';

const Probe = ({ viewing }: { viewing: string }) => { useOrbActivity(viewing); return null; };
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const compaction = (id: string, agentId: string | null, phase: 'start' | 'end') =>
  act(() => emitFrame('engine:activity', { data: { phase, id, kind: 'compaction', agentId, label: 'Compacting memory', startedAt: '' } }));

beforeEach(() => {
  state.orb = mk();
  resetFrames();
  resetEngineRoleIds();
});

describe('the orb compaction glyph is scoped to the viewed agent', () => {
  it('a service agent compacting does not light the orb while the owner views his own agent', async () => {
    render(<Probe viewing="agent-main" />);
    await settle();
    compaction('c-pm', 'agent-pm', 'start');
    expect(state.orb.startTask).not.toHaveBeenCalled();
  });

  it("the viewed agent's own compaction shows, and ends when its work ends", async () => {
    render(<Probe viewing="agent-main" />);
    await settle();
    compaction('c-main', 'agent-main', 'start');
    expect(state.orb.startTask).toHaveBeenCalledWith('compaction', expect.anything());
    compaction('c-main', 'agent-main', 'end');
    expect(state.orb.endTask).toHaveBeenCalled();
  });

  it('switching to the agent whose work is running shows it; the box-wide maintenance shows everywhere', async () => {
    const { rerender } = render(<Probe viewing="agent-main" />);
    await settle();
    compaction('c-pm', 'agent-pm', 'start');
    expect(state.orb.startTask).not.toHaveBeenCalled();
    rerender(<Probe viewing="agent-pm" />);
    expect(state.orb.startTask).toHaveBeenCalledWith('compaction', expect.anything());
    compaction('c-pm', 'agent-pm', 'end');
    state.orb.startTask.mockClear();
    rerender(<Probe viewing="agent-main" />);
    compaction('vacuum', null, 'start');
    expect(state.orb.startTask).toHaveBeenCalledWith('compaction', expect.anything());
  });
});
