import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const fns = vi.hoisted(() => ({
  getHealerConfig: vi.fn(), getHealerDiagnostic: vi.fn(), triggerHealerRun: vi.fn(), getSetting: vi.fn(), getAgents: vi.fn(),
}));
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, ...fns };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('../hooks/useToast', () => ({ useToast: () => toast }));

import { resetEngineRoleIds } from '../lib/engine-role-ids';
import { HealerCard } from '../components/settings/CapabilityModelCards';

const ok = (data: unknown) => ({ ok: true, data });
const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  for (const f of Object.values(fns)) f.mockReset();
  for (const f of Object.values(toast)) f.mockReset();
  resetEngineRoleIds();
  fns.getHealerConfig.mockResolvedValue(ok({ modelId: null, healerTime: '04:00', healerMode: 'active' }));
  fns.getHealerDiagnostic.mockResolvedValue(ok(null));
  fns.triggerHealerRun.mockResolvedValue(ok({ llmTriggered: true }));
  fns.getSetting.mockImplementation(async (key: string) => ok({ key, value: key === 'healer_agent_id' ? 'hl-9' : null }));
});
afterEach(() => { vi.useRealTimers(); });

const start = async () => {
  render(<HealerCard models={[]} />);
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Run Now' }));
  await flush();
};

describe('Healer Run Now', () => {
  it('keeps waiting past five minutes while the configured Healer id is still working, then finishes', async () => {
    let working = true;
    fns.getAgents.mockImplementation(async () => ok([{ id: 'hl-9', status: working ? 'working' : 'idle' }, { id: 'healer', status: 'working' }]));
    await start();
    await flush(5000 * 70);
    expect(toast.success).not.toHaveBeenCalled();
    working = false;
    await flush(5000);
    expect(toast.success).toHaveBeenCalledWith('Healing cycle complete');
  });
  it('never guesses an id: with the setting unreadable it does not wait', async () => {
    fns.getSetting.mockResolvedValue({ ok: false, error: 'down' });
    fns.getAgents.mockResolvedValue(ok([{ id: 'healer', status: 'working' }]));
    await start();
    await flush(10);
    expect(toast.success).toHaveBeenCalledWith('Healing cycle complete');
  });
});
