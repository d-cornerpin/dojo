// The voice button opens the setup panel only when the server says the saved engines still need a model,
// and the panel lists exactly what the server named.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';

const made = vi.hoisted(() => ({ starts: 0, missing: [] as Array<Record<string, unknown>> }));
vi.mock('../lib/voice/voice-client', () => ({
  VoiceClient: class {
    agentId: string;
    constructor(opts: { agentId: string }) { this.agentId = opts.agentId; }
    on() { return this; }
    async start() { made.starts += 1; }
    async stop() {}
    isMuted() { return false; }
    async setMuted() {}
  },
}));
vi.mock('../lib/api', () => ({
  getSetting: vi.fn(async () => ({ ok: true, data: { value: '' } })),
  getVoiceModels: vi.fn(async () => ({
    ok: true,
    data: { whisper: [], kokoro: { id: 'k', installed: true, bytes: 1 }, moonshine: { installed: true }, missing: made.missing, freeDiskMb: 50000 },
  })),
}));
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});

import { useVoiceMode, invalidateSavedVoiceSettings } from '../hooks/useVoiceMode';
import { VoiceFirstRunModal } from '../components/VoiceFirstRunModal';

beforeEach(() => { made.starts = 0; made.missing = []; invalidateSavedVoiceSettings(); });

describe('the voice button and first-run setup', () => {
  it('starts voice when the server says nothing is missing', async () => {
    const { result } = renderHook(() => useVoiceMode({ agentId: 'a1' }));
    await act(async () => { await result.current.toggle(); });
    expect(result.current.setupNeeded).toBe(false);
    expect(made.starts).toBe(1);
  });

  it('opens setup, and starts nothing, when a model is missing', async () => {
    made.missing = [{ kind: 'moonshine', id: 'moonshine-base', label: 'Moonshine speech recognition', approxBytes: 1 }];
    const { result } = renderHook(() => useVoiceMode({ agentId: 'a1' }));
    await act(async () => { await result.current.toggle(); });
    expect(result.current.setupNeeded).toBe(true);
    expect(made.starts).toBe(0);
  });

  it('the setup panel lists what the server named', async () => {
    made.missing = [{ kind: 'moonshine', id: 'moonshine-base', label: 'Moonshine speech recognition', approxBytes: 1 }];
    render(<VoiceFirstRunModal onComplete={() => {}} onCancel={() => {}} />);
    expect(await screen.findByText('Moonshine speech recognition')).toBeTruthy();
  });
});
