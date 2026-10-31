// A failed read of any saved voice setting must not leave the hard-coded defaults on screen where the next
// toggle or blur would save them: the tab says so with a Retry and offers no controls.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: { voices: [], defaultVoice: 'v', keySet: false } })) : actual[key];
  }
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return { useToast: () => stub.value };
});

import * as api from '../lib/api';
import { VoiceTab } from '../components/settings/VoiceTab';

beforeEach(() => {
  vi.mocked(api).getSetting.mockImplementation((async (k: string) =>
    k === 'voice.wake_phrase' ? { ok: false, error: 'down' } : { ok: true, data: { key: k, value: null } }) as never);
});

describe('the voice tab', () => {
  it('a failed read of one setting shows Retry and no controls, and writes nothing', async () => {
    const { container } = render(<VoiceTab />);
    await screen.findByText('Retry');
    expect(container.querySelector('input')).toBeNull();
    expect(vi.mocked(api).setSetting).not.toHaveBeenCalled();
  });
});
