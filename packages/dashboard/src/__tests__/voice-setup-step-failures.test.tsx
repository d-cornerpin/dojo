import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  const stable = fakeUseWebSocket();
  return { useWebSocket: () => stable, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { VoiceSetupStep } from '../components/VoiceSetupStep';

const mocked = () => vi.mocked(api);
const voices = [
  { id: 'v1', name: 'Alpha', language: 'en-us', gender: 'Female' },
  { id: 'v2', name: 'Beta', language: 'en-us', gender: 'Male' },
];
const models = {
  whisper: [{ id: 'w1', installed: false, bytes: 0 }],
  kokoro: { id: 'k1', installed: false, bytes: 0 },
  missing: [{ kind: 'kokoro', id: 'k1', label: 'Kokoro voice synthesis', approxBytes: 1 }],
};

beforeEach(() => {
  resetFrames();
  mocked().getVoicePresets.mockResolvedValue({ ok: true, data: { voices, defaultVoice: 'v1' } } as never);
  mocked().getVoiceModels.mockResolvedValue({ ok: true, data: models } as never);
  mocked().getSetting.mockResolvedValue({ ok: true, data: { key: 'voice.preferred_voice', value: '' } } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('voice setup step failures', () => {
  it('brings the download button back when the install is refused', async () => {
    mocked().installMissingVoiceModels.mockResolvedValue({ ok: false, error: 'disk full' } as never);
    render(<VoiceSetupStep />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download voice models' }));
    expect(await screen.findByText('disk full')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download voice models' })).toBeTruthy();
  });

  it('brings the download button back when the request throws', async () => {
    mocked().installMissingVoiceModels.mockRejectedValue(new Error('network gone'));
    render(<VoiceSetupStep />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download voice models' }));
    expect(await screen.findByText('network gone')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download voice models' })).toBeTruthy();
  });

  it('puts the previous voice back and says so when saving fails', async () => {
    mocked().setSetting.mockResolvedValue({ ok: false, error: 'locked' } as never);
    render(<VoiceSetupStep />);
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('v1'));
    fireEvent.change(select, { target: { value: 'v2' } });
    expect(await screen.findByText(/Could not save the voice: locked/)).toBeTruthy();
    await waitFor(() => expect(select.value).toBe('v1'));
  });

  it('says so when the voice list cannot be loaded', async () => {
    mocked().getVoicePresets.mockResolvedValue({ ok: false, error: 'x' } as never);
    render(<VoiceSetupStep />);
    expect(await screen.findByText('Could not load the voice list.')).toBeTruthy();
  });

  it('lets go of the preview sound file when playback fails', async () => {
    mocked().getVoiceModels.mockResolvedValue({ ok: true, data: { ...models, kokoro: { id: 'k1', installed: true, bytes: 1 } } } as never);
    mocked().fetchVoicePreview.mockResolvedValue(new Blob(['x']) as never);
    const create = vi.fn(() => 'blob:one');
    const revoke = vi.fn();
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    vi.stubGlobal('Audio', class { onended: (() => void) | null = null; play() { return Promise.reject(new Error('blocked')); } });
    render(<VoiceSetupStep />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:one'));
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
    vi.unstubAllGlobals();
  });
});
