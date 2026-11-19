// The setup installer fetches one voice model at a time, in the order given, and stops at the first refusal.
// The server is a scripted `request`; the install's wait for each model runs on fake timers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/door', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/door');
  return { ...actual, request: vi.fn() };
});

import * as api from '../lib/api';
import { request } from '../lib/door';

const posts: string[] = [];
const onDisk = new Set<string>();
const missing: api.VoiceMissingModel[] = [
  { kind: 'kokoro', id: 'k1', label: 'Kokoro voice synthesis', approxBytes: 1 },
  { kind: 'moonshine', id: 'moonshine-base', label: 'Moonshine speech recognition', approxBytes: 1 },
];

beforeEach(() => {
  posts.length = 0;
  onDisk.clear();
  vi.mocked(request).mockImplementation(async (path: string, options?: RequestInit) => {
    if (options?.method === 'POST') { posts.push(path); return { ok: true, data: {} }; }
    return { ok: true, data: { whisper: [], kokoro: { installed: onDisk.has('kokoro') }, moonshine: { installed: onDisk.has('moonshine') } } };
  });
});
afterEach(() => { vi.mocked(request).mockReset(); vi.useRealTimers(); });

describe('installing the missing voice models', () => {
  it('starts the speech model only once the voice model is on disk', async () => {
    vi.useFakeTimers();
    const done = api.installMissingVoiceModels(missing);
    await vi.advanceTimersByTimeAsync(1600);
    expect(posts).toEqual(['/voice/models/kokoro/k1']);
    onDisk.add('kokoro');
    await vi.advanceTimersByTimeAsync(1600);
    expect(posts).toEqual(['/voice/models/kokoro/k1', '/voice/models/moonshine/moonshine-base']);
    onDisk.add('moonshine');
    await vi.advanceTimersByTimeAsync(1600);
    expect(await done).toEqual({ ok: true, data: null });
  });

  it('stops at the first refusal', async () => {
    vi.mocked(request).mockImplementation(async (path: string) => { posts.push(path); return { ok: false, error: 'disk full' }; });
    expect(await api.installMissingVoiceModels(missing)).toEqual({ ok: false, error: 'disk full' });
    expect(posts).toEqual(['/voice/models/kokoro/k1']);
  });
});
