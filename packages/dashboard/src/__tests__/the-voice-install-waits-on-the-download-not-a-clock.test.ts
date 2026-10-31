// R25 (P13): a voice-model install has NO fixed give-up. It ends when the model is on disk, or when the
// server says the install failed (the `voice:model_install_error` frame, handed over by the screens
// that already listen for it) — never because 15 minutes went by while the download was still moving.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/door', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/door');
  return { ...actual, request: vi.fn() };
});

import * as api from '../lib/api';
import { request } from '../lib/door';

let kokoroInstalled = false;
beforeEach(() => {
  kokoroInstalled = false;
  vi.mocked(request).mockImplementation(async (_p: string, options?: RequestInit) => {
    if (options?.method === 'POST') return { ok: true, data: { kind: 'kokoro', id: 'k' } };
    return { ok: true, data: { whisper: [], kokoro: { installed: kokoroInstalled }, moonshine: { installed: false } } };
  });
});
afterEach(() => { vi.mocked(request).mockReset(); vi.useRealTimers(); });

describe('installVoiceModel has no clock', () => {
  it('is still waiting after an hour, and finishes when the model lands', async () => {
    vi.useFakeTimers();
    const p = api.installVoiceModel('kokoro', 'k');
    let settled = false;
    void p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(settled).toBe(false);
    kokoroInstalled = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toEqual({ ok: true, data: { kind: 'kokoro', id: 'k' } });
  });

  it('ends with the server\'s own reason when the install-failed frame arrives', async () => {
    vi.useFakeTimers();
    const p = api.installVoiceModel('kokoro', 'k');
    await vi.advanceTimersByTimeAsync(3000);
    api.noteVoiceInstallFailure('kokoro', 'k', 'disk full');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toEqual({ ok: false, error: 'disk full' });
  });
});
