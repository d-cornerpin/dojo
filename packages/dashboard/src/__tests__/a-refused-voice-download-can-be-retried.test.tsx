// A refused voice download must leave the modal usable — the refusal surfaces the
// error but used to leave "Downloading…" stuck, hiding the retry button with no exit.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

// Mock only the two doors this modal opens; everything else in lib/api stays real.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    getVoiceModels: vi.fn(async () => ({
      ok: true,
      data: {
        whisper: [{ id: 'base.en', installed: false, bytes: 0, approxBytes: 1000 }],
        kokoro: { id: 'k', installed: false, bytes: 0 },
        defaultWhisper: 'base.en',
        missing: [{ kind: 'kokoro', id: 'k', label: 'Kokoro voice synthesis', approxBytes: 1000 }],
        kokoroLoaded: false,
        totalDiskBytes: 0,
        freeDiskMb: 50000,
      },
    })),
    installMissingVoiceModels: vi.fn(async () => ({ ok: false, error: 'download refused' })),
  };
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { VoiceFirstRunModal } from '../components/VoiceFirstRunModal';

beforeEach(() => {
  resetFrames();
  vi.mocked(api.installMissingVoiceModels).mockClear();
});

describe('a refused voice download leaves the modal usable', () => {
  it('surfaces the refusal, restores the retry button, and can be clicked again', async () => {
    render(<VoiceFirstRunModal onComplete={() => {}} onCancel={() => {}} />);

    // Case 1: clicking "Download & enable" runs the install, which the door refuses.
    const button = await screen.findByRole('button', { name: /download & enable/i });
    fireEvent.click(button);
    await screen.findByText('download refused');

    // Case 2: the card must be usable again — the retry button is back and the
    // in-progress "Downloading…" label is gone.
    expect(screen.queryByText(/downloading/i)).toBeNull();
    expect(screen.getByRole('button', { name: /download & enable/i })).toBeTruthy();

    // Case 3: clicking it again asks the door a second time.
    vi.mocked(api.installMissingVoiceModels).mockClear();
    fireEvent.click(screen.getByRole('button', { name: /download & enable/i }));
    await waitFor(() => expect(api.installMissingVoiceModels).toHaveBeenCalled());
  });
});
