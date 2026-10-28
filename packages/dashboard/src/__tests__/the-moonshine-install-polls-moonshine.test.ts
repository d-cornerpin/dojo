// A MOONSHINE INSTALL WAITS FOR MOONSHINE, NOT FOR KOKORO. installVoiceModel polled
// `/voice/models` but only ever read the whisper entry or the kokoro entry, so a
// moonshine install resolved the moment Kokoro was on disk — or never resolved until
// the 15-minute timeout when Kokoro was not installed. The server is a scripted
// `request`; the poll cadence runs on fake timers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let pollBody: Record<string, unknown> = {};

vi.mock('../lib/door', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/door');
  return { ...actual, request: vi.fn() };
});

import * as api from '../lib/api';
import { request } from '../lib/door';

beforeEach(() => {
  pollBody = { whisper: [], kokoro: { installed: true }, moonshine: { installed: false } };
  vi.mocked(request).mockImplementation(async (path: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      return {
        ok: true,
        data: { kind: path.split('/')[3], id: decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) },
      };
    }
    return { ok: true, data: pollBody };
  });
});

afterEach(() => {
  vi.mocked(request).mockReset();
  vi.useRealTimers();
});

describe('installVoiceModel', () => {
  it('a moonshine install waits for the moonshine entry, not for kokoro', async () => {
    vi.useFakeTimers();
    const p = api.installVoiceModel('moonshine', 'moonshine-base');
    let settled = false;
    void p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1600);   // one poll: kokoro on disk, moonshine still downloading
    expect(settled).toBe(false);
    pollBody = { ...pollBody, moonshine: { installed: true } };
    await vi.advanceTimersByTimeAsync(1600);   // the next poll sees moonshine on disk
    expect(await p).toEqual({ ok: true, data: { kind: 'moonshine', id: 'moonshine-base' } });
  });

  it('a kokoro install still resolves after one poll', async () => {
    vi.useFakeTimers();
    pollBody = { whisper: [], kokoro: { installed: true } };
    const p = api.installVoiceModel('kokoro', 'kokoro-v1.0');
    await vi.advanceTimersByTimeAsync(1600);
    expect(await p).toEqual({ ok: true, data: { kind: 'kokoro', id: 'kokoro-v1.0' } });
  });
});
