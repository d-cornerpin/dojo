// Settings > Voice: when the server refuses to store a control's value the tab
// must say so and the toggle must go back to what the server holds.

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
    setSetting: vi.fn(),
  };
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});

vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const t = fakeToast();
  return { useToast: () => t.value, __calls: t.calls };
});

import * as api from '../lib/api';
import * as toastMod from '../hooks/useToast';
import { VoiceTab } from '../components/settings/VoiceTab';

const sfxSwitch = async () => (await screen.findByLabelText(/play voice mode sound effects/i)) as HTMLInputElement;

beforeEach(() => {
  resetFrames();
  vi.mocked(api.setSetting).mockReset();
  (toastMod as unknown as { __calls: unknown[] }).__calls.length = 0;
});

describe('Voice settings and refused saves', () => {
  it('a refused toggle shows the reason and goes back to its old state', async () => {
    vi.mocked(api.setSetting).mockResolvedValue({ ok: false, error: 'disk full' } as never);
    render(<VoiceTab />);
    const box = await sfxSwitch();
    const before = box.checked;
    fireEvent.click(box);
    const calls = (toastMod as unknown as { __calls: Array<{ level: string; message: string }> }).__calls;
    await waitFor(() => expect(calls.some((c) => c.level === 'error' && /was not saved: disk full/.test(c.message))).toBe(true));
    expect(document.querySelector('.alert-banner')).toBeNull();
    await waitFor(() => expect(box.checked).toBe(before));
  });

  it('a saved toggle shows no error and keeps its new state', async () => {
    vi.mocked(api.setSetting).mockResolvedValue({ ok: true, data: {} } as never);
    render(<VoiceTab />);
    const box = await sfxSwitch();
    const before = box.checked;
    fireEvent.click(box);
    await waitFor(() => expect(api.setSetting).toHaveBeenCalled());
    await screen.findAllByText('Saved!');
    expect(screen.queryByText(/was not saved/)).toBeNull();
    expect(box.checked).toBe(!before);
  });
});
