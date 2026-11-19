// Two quick mic clicks make exactly one voice client, and leaving the page while voice is still
// starting never leaves a started client (and its open microphone) behind.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const made = vi.hoisted(() => ({ clients: [] as Array<{ starts: number; stops: number }> }));
vi.mock('../lib/voice/voice-client', () => ({
  VoiceClient: class {
    agentId: string;
    starts = 0;
    stops = 0;
    constructor(opts: { agentId: string }) { this.agentId = opts.agentId; made.clients.push(this); }
    on() { return this; }
    async start() { this.starts += 1; }
    async stop() { this.stops += 1; }
    isMuted() { return false; }
    async setMuted() {}
  },
}));

let release: () => void = () => {};
vi.mock('../lib/api', () => ({
  getSetting: vi.fn(async () => {
    await new Promise<void>((r) => { const prev = release; release = () => { prev(); r(); }; });
    return { ok: true, data: { value: '' } };
  }),
  getVoiceModels: vi.fn(async () => ({ ok: true, data: { missing: [] } })),
}));

import { useVoiceMode, invalidateSavedVoiceSettings } from '../hooks/useVoiceMode';

beforeEach(() => { made.clients.length = 0; release = () => {}; invalidateSavedVoiceSettings(); });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('starting voice', () => {
  it('builds and starts one client for two quick toggles', async () => {
    const { result } = renderHook(() => useVoiceMode({ agentId: 'a1' }));
    let a: Promise<void>, b: Promise<void>;
    act(() => { a = result.current.toggle(); b = result.current.toggle(); });
    await flush();
    await act(async () => { release(); await a; await b; });
    expect(made.clients.length).toBe(1);
    expect(made.clients[0].starts).toBe(1);
  });

  it('starts nothing that stays running when the page is left mid-start', async () => {
    const { result, unmount } = renderHook(() => useVoiceMode({ agentId: 'a1' }));
    let a: Promise<void>;
    act(() => { a = result.current.toggle(); });
    await flush();
    unmount();
    await act(async () => { release(); await a; });
    for (const c of made.clients) expect(c.starts === 0 || c.stops >= c.starts).toBe(true);
  });
});
