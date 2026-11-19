// First-run setup downloads what the server says the saved voice engines still need, through the one
// installer the voice button's setup panel uses too.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: null })) : actual[key];
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  const stable = fakeUseWebSocket();
  return { useWebSocket: () => stable, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { VoiceSetupStep } from '../components/VoiceSetupStep';

const missing = [
  { kind: 'kokoro', id: 'k1', label: 'Kokoro voice synthesis', approxBytes: 1 },
  { kind: 'moonshine', id: 'moonshine-base', label: 'Moonshine speech recognition', approxBytes: 1 },
];

beforeEach(() => {
  vi.mocked(api.getVoicePresets).mockResolvedValue({ ok: true, data: { voices: [], defaultVoice: 'v1' } } as never);
  vi.mocked(api.getSetting).mockResolvedValue({ ok: true, data: { key: 'voice.preferred_voice', value: '' } } as never);
  vi.mocked(api.getVoiceModels).mockResolvedValue({
    ok: true, data: { whisper: [{ id: 'large-v3-turbo', installed: false, bytes: 0 }], kokoro: { id: 'k1', installed: false, bytes: 0 }, defaultWhisper: 'large-v3-turbo', missing },
  } as never);
});

describe('first-run voice setup', () => {
  it('shows each model the saved engines still need', async () => {
    render(<VoiceSetupStep />);
    expect(await screen.findByText('Kokoro voice synthesis')).toBeTruthy();
    expect(screen.getByText('Moonshine speech recognition')).toBeTruthy();
  });

  it('downloads exactly that list through the one installer', async () => {
    render(<VoiceSetupStep />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download voice models' }));
    await waitFor(() => expect(api.installMissingVoiceModels).toHaveBeenCalledWith(missing));
    expect(api.installVoiceModel).not.toHaveBeenCalled();
  });

  it('renders against a server answer that has no missing list', async () => {
    const actual = await vi.importActual<typeof api>('../lib/api');
    const older = { whisper: [], kokoro: null, defaultWhisper: 'large-v3-turbo', kokoroLoaded: false, totalDiskBytes: 0, freeDiskMb: 1 };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: older }), { status: 200 })));
    vi.mocked(api.getVoiceModels).mockImplementation(actual.getVoiceModels);
    render(<VoiceSetupStep />);
    expect(await screen.findByText('✓ Installed')).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
