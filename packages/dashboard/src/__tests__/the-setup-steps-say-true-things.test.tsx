import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fns = vi.hoisted(() => ({ getModels: vi.fn(), getDreamingConfig: vi.fn(), updateDreamingConfig: vi.fn(), getSetting: vi.fn(), getAgent: vi.fn() }));
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, ...fns };
});
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));

import { DreamerStep, PMAgentStep, PrimaryAgentStep } from '../pages/Setup';

const ok = (data: unknown) => ({ ok: true, data });
beforeEach(() => {
  for (const f of Object.values(fns)) f.mockReset();
  fns.getModels.mockResolvedValue(ok([]));
  fns.updateDreamingConfig.mockResolvedValue(ok({}));
  fns.getSetting.mockResolvedValue(ok({ key: 'x', value: '' }));
  fns.getDreamingConfig.mockResolvedValue(ok({ modelId: 'm1', dreamTime: '03:00', dreamMode: 'off' }));
});

const text = () => document.body.textContent ?? '';

describe('the setup steps say true things', () => {
  it('the PM step: no jargon, no promise about free local models', async () => {
    render(<PMAgentStep />);
    await waitFor(() => expect(text()).toContain('project manager'));
    expect(text()).toContain('reminds agents about work that has stopped moving');
    expect(text()).not.toContain('pokes');
    expect(text()).not.toContain('free local model');
  });
  it('the Dreamer step: the Dreamer is not temporary', async () => {
    render(<DreamerStep />);
    await waitFor(() => expect(text()).toContain('Dreamer'));
    expect(text()).not.toContain('temporary');
  });
  it('the main agent step names a control that exists', async () => {
    render(<PrimaryAgentStep />);
    await waitFor(() => expect(text()).toContain('the gear on the agent\'s card'));
    expect(text()).not.toContain('Config tab');
  });
});
