// 8107 — a speech-model download the server refuses leaves the row usable: the reason shows and the
// Download button is back (no endless empty bar).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    getVoicePresets: vi.fn(async () => ({ ok: true, data: { voices: [], defaultVoice: 'af_x' } })),
    getVoiceModels: vi.fn(async () => ({
      ok: true,
      data: {
        whisper: [{ id: 'base.en', installed: false, bytes: 0, approxBytes: 1000 }],
        moonshine: { installed: true, bytes: 1 },
        kokoro: { id: 'k', installed: true, bytes: 1 },
        defaultWhisper: 'base.en',
        kokoroLoaded: false,
        totalDiskBytes: 0,
        freeDiskMb: 50000,
      },
    })),
    getSetting: vi.fn(async () => ({ ok: true, data: { value: null } })),
    getHumeStatus: vi.fn(async () => ({ ok: true, data: { keySet: false } })),
    installVoiceModel: vi.fn(async () => ({ ok: false, error: 'refused' })),
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

describe('a refused speech-model download', () => {
  it('shows the reason and puts the Download button back', async () => {
    render(<VoiceTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await screen.findByText('refused');
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
  });
});
