// Settings > Voice: the local voice that a cloud voice falls back to has no Delete button.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    getVoicePresets: vi.fn(async () => ({ ok: true, data: { voices: [], defaultVoice: 'v1' } })),
    getVoiceModels: vi.fn(async () => ({
      ok: true,
      data: { whisper: [], kokoro: { id: 'k', installed: true, bytes: 1 }, defaultWhisper: 'base.en', defaultSttModel: 'base.en', kokoroLoaded: false, totalDiskBytes: 0, freeDiskMb: 50000 },
    })),
    getSetting: vi.fn(async () => ({ ok: true, data: { value: null } })),
    getHumeStatus: vi.fn(async () => ({ ok: true, data: { hasKey: false } })),
  };
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const t = fakeToast();
  return { useToast: () => t.value };
});

import { VoiceTab } from '../components/settings/VoiceTab';

beforeEach(() => { resetFrames(); });

describe('the installed local voice', () => {
  it('says it is the backup voice and offers no Delete button', async () => {
    render(<VoiceTab />);
    await screen.findByText(/The backup voice: it speaks when a cloud voice fails, so it stays installed\./);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});
