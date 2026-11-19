// A failed read of the saved voice settings must not be remembered as the owner's settings.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/api', () => ({ getSetting: vi.fn() }));

import * as api from '../lib/api';
import { invalidateSavedVoiceSettings, loadSavedVoiceSettings } from '../hooks/useVoiceMode';

const getSetting = vi.mocked(api.getSetting);

beforeEach(() => { getSetting.mockReset(); invalidateSavedVoiceSettings(); });

describe('saved voice settings', () => {
  it('a round where a read failed is not cached: the next call reads again', async () => {
    getSetting.mockImplementation((async () => ({ ok: false, error: 'server restarting' })) as never);
    const first = await loadSavedVoiceSettings();
    expect(first.wakePhrase, 'voice can still start on defaults').toBe('hey agent');

    getSetting.mockImplementation((async (key: string) => (
      { ok: true, data: { key, value: key === 'voice.wake_phrase' ? 'hello there' : null } }
    )) as never);
    const second = await loadSavedVoiceSettings();
    expect(second.wakePhrase, 'the failed round was remembered').toBe('hello there');
  });

  it('a round where every read answered is cached', async () => {
    getSetting.mockImplementation((async (key: string) => (
      { ok: true, data: { key, value: key === 'voice.wake_phrase' ? 'hello there' : null } }
    )) as never);
    await loadSavedVoiceSettings();
    const calls = getSetting.mock.calls.length;
    await loadSavedVoiceSettings();
    expect(getSetting.mock.calls.length).toBe(calls);
  });
});
