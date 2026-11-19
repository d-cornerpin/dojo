// Settings > Voice: the playback speed saves when the slider is let go by mouse, finger or keyboard.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    getVoicePresets: vi.fn(async () => ({ ok: true, data: { voices: [], defaultVoice: 'v1' } })),
    getVoiceModels: vi.fn(async () => ({
      ok: true,
      data: { whisper: [], kokoro: { id: 'k', installed: false, bytes: 0 }, defaultWhisper: 'base.en', defaultSttModel: 'base.en', kokoroLoaded: false, totalDiskBytes: 0, freeDiskMb: 50000 },
    })),
    getSetting: vi.fn(async () => ({ ok: true, data: { value: null } })),
    getHumeStatus: vi.fn(async () => ({ ok: true, data: { hasKey: false } })),
    setSetting: vi.fn(async () => ({ ok: true, data: {} })),
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

import * as api from '../lib/api';
import { VoiceTab } from '../components/settings/VoiceTab';

beforeEach(() => {
  resetFrames();
  vi.mocked(api.setSetting).mockClear();
});

const speedSlider = async () => (await screen.findAllByRole('slider'))[0] as HTMLInputElement;

describe('the playback speed slider', () => {
  it('saves when an arrow key is released', async () => {
    render(<VoiceTab />);
    const slider = await speedSlider();
    fireEvent.change(slider, { target: { value: '1.2' } });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith('voice.playback_speed', '1.2'));
  });

  it('saves nothing when the Tab key is released on it', async () => {
    render(<VoiceTab />);
    const slider = await speedSlider();
    fireEvent.keyUp(slider, { key: 'Tab' });
    expect(api.setSetting).not.toHaveBeenCalled();
  });

  it('still saves when the pointer is let go', async () => {
    render(<VoiceTab />);
    const slider = await speedSlider();
    fireEvent.change(slider, { target: { value: '0.9' } });
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith('voice.playback_speed', '0.9'));
  });
});
