// ════════════════════════════════════════════════════════════════════════════
// THE CLOUD MULTIPART BODY IS BUILT FROM THE BUFFER IN MEMORY
// (PHASE-5 T8 Step 3, RULING P5-R15 ADDENDUM 4(2)).
//
// The cloud transcription branch wrote the WHOLE audio buffer to a file in the
// platform temp directory and unlinked it in its `finally` — and nothing ever
// read it. Its own comment gave a reason ("the multipart form helper in undici's
// fetch likes a File-shaped Blob with a stable filename") that the code no longer
// has: the form is appended a `Blob` built from `req.audio`, with the filename
// passed as the third argument.
//
// Deleting a live-looking write may not rest on an absence (roadmap #15), so this
// file is the POSITIVE evidence, driven rather than read:
//   1. the request body the module hands `fetch` carries the FULL buffer under
//      the field name and filename the provider expects — asserted by reading
//      the multipart body back. That clause passes BEFORE the deletion and
//      identically after it, which is what proves no capability is removed;
//   2. the cloud path touches the FILESYSTEM ZERO TIMES. That clause is the RED
//      one: before the deletion the module writes one temp copy of the user's
//      audio per call, and it fails.
//
// One fewer copy of user audio touching disk is the direction; the reason it is
// its own commit and never rode inside the relocation is that it is a behaviour
// change, and a relocation may not carry one.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

// The module under test pulls the local STT engines in at import time; they are
// not on this path at all and loading them would drag model management and a
// subprocess spawn into a unit test.
vi.mock('../../voice/stt-service.js', () => ({
  transcribeBuffer: vi.fn(),
  isWhisperBinaryAvailable: (): boolean => false,
}));
vi.mock('../../voice/model-manager.js', () => ({ DEFAULT_WHISPER: 'base.en' }));

vi.mock('../transcription-model.js', () => ({
  getEffectiveTranscriptionModel: (): unknown => ({
    kind: 'cloud', modelId: 'openai/whisper-1', providerId: 'openai', apiModelId: 'whisper-1',
  }),
}));
vi.mock('../../config/loader.js', () => ({ getProviderCredential: (): string => 'test-key' }));
vi.mock('../../db/connection.js', () => ({
  getDb: (): unknown => ({
    prepare: () => ({ get: () => ({ base_url: 'https://api.openai.com' }) }),
  }),
}));

const { transcribeAudio } = await import('../transcription.js');

/** The exact bytes a caller hands the cloud path — recognisable, and not a WAV. */
const AUDIO = Buffer.from('MPEG-audio-bytes-that-must-reach-the-provider-intact', 'utf-8');

let sent: Request | null = null;
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = null;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    sent = new Request('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', body: init?.body as BodyInit,
    });
    return new Response(JSON.stringify({ text: 'hello there', duration: 1.5 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('the cloud transcription request assembles from the in-memory buffer', () => {
  it('carries the FULL audio under the file field, with the filename the provider sees', async () => {
    const result = await transcribeAudio({
      audio: AUDIO, mimeType: 'audio/mpeg', filename: 'memo.mp3', language: 'en',
    });
    expect(result.ok, 'the cloud path answered').toBe(true);
    expect(sent, 'the module called fetch').not.toBeNull();

    const form = await sent!.formData();
    const file = form.get('file');
    expect(file, 'the form carries a file part').toBeInstanceOf(Blob);
    const blob = file as File;
    expect(blob.size, 'every byte of the buffer is in the body').toBe(AUDIO.length);
    expect(Buffer.from(await blob.arrayBuffer()).equals(AUDIO), 'byte-for-byte').toBe(true);
    expect(blob.name, 'the stable filename rides the part, not a file on disk').toBe('memo.mp3');
    expect(blob.type).toBe('audio/mpeg');
    // The rest of the body is unchanged by the deletion and is asserted so a
    // future edit to this branch cannot quietly drop one.
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('language')).toBe('en');
    expect(form.get('response_format')).toBe('verbose_json');
  });

  it('and writes NOTHING to disk — no second copy of the user audio exists at any moment', async () => {
    // The clause the deletion earns. It watches the write itself rather than the
    // aftermath, because the old code unlinked its copy in a `finally` — so
    // "no temp file remains afterwards" was true both before and after and would
    // have proven nothing.
    const writeSync = vi.spyOn(fs, 'writeFileSync');
    const writeAsync = vi.spyOn(fs.promises, 'writeFile');
    const result = await transcribeAudio({
      audio: AUDIO, mimeType: 'audio/mpeg', filename: 'memo.mp3',
    });
    expect(result.ok).toBe(true);
    expect(writeSync.mock.calls.map((c) => String(c[0])), 'no synchronous write').toEqual([]);
    expect(writeAsync.mock.calls.map((c) => String(c[0])), 'no asynchronous write').toEqual([]);
  });
});
