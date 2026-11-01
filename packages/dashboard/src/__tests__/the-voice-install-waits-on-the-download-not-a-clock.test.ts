// R25 (P13): a voice-model install has NO fixed give-up. It ends when the model is on disk, or when the
// server says the install failed (the `voice:model_install_error` frame, handed over by the screens
// that already listen for it) — never because 15 minutes went by while the download was still moving.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/door', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/door');
  return { ...actual, request: vi.fn() };
});

import * as api from '../lib/api';
import { noteVoiceInstallFailure } from '../lib/voice-install-failures';
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
    noteVoiceInstallFailure('kokoro', 'k', 'disk full');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toEqual({ ok: false, error: 'disk full' });
  });

  it('ends in plain words when the server lost its connection and, once back, finds no model', async () => {
    vi.useFakeTimers();
    let up = true;
    vi.mocked(request).mockImplementation(async (_p: string, options?: RequestInit) => {
      if (options?.method === 'POST') return { ok: true, data: { kind: 'kokoro', id: 'k' } };
      if (!up) return { ok: false, error: 'down' };
      return { ok: true, data: { whisper: [], kokoro: { installed: false }, moonshine: { installed: false } } };
    });
    const p = api.installVoiceModel('kokoro', 'k');
    await vi.advanceTimersByTimeAsync(3000);   // up, still downloading: keeps waiting
    up = false;
    await vi.advanceTimersByTimeAsync(3000);   // down: keeps waiting
    up = true;
    await vi.advanceTimersByTimeAsync(2000);   // back, no model: the download died with the restart
    const r = await p;
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/connection to Dojo was lost.*not installed/);
    expect((r as { error: string }).error).not.toMatch(/restart/i);  // a blip is not proof of a restart
  });
});
