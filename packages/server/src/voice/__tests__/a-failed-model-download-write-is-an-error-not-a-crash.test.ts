// ════════════════════════════════════════
// A FAILED MODEL DOWNLOAD IS AN ERROR THE DASHBOARD CAN SHOW, NOT A DEAD SERVER.
//
// All three model downloaders stream into a `.partial` file. A write stream
// with no 'error' listener turns a full disk into an uncaught exception, and
// the server answers uncaught exceptions by exiting (src/index.ts). These
// cases plant an ENOSPC writer and demand the real cause back from each
// downloader — not ERR_STREAM_DESTROYED, and not a process that stops.
// ════════════════════════════════════════

import fs from 'node:fs';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ensureKokoroFiles,
  ensureMoonshineFiles,
  ensureWhisperModel,
  whisperPath,
} from '../model-manager.js';

/** The failure an out-of-space disk produces mid-download. */
function enospc(): Error & { code: string } {
  return Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
}

/**
 * A Response-like fetch result streaming `chunks` 1 KiB chunks then done.
 * The 20 ms pause before the first chunk lets the writer's stream error fire
 * while the download loop is still writing — as it does on a real slow disk —
 * so the `end` in the finally is reached only after the failure.
 */
function stubFetch(chunks: number): void {
  let sent = 0;
  const reader = {
    read: async () => {
      if (sent === 0) await new Promise((r) => setTimeout(r, 20));
      if (sent++ < chunks) return { done: false, value: new Uint8Array(1024) };
      return { done: true };
    },
  };
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    body: { getReader: () => reader },
  }));
}

/** Every write fails the way a full disk fails it — callback AND 'error' event. */
function everyWriteFails(): void {
  vi.spyOn(fs, 'createWriteStream').mockReturnValue(
    new Writable({
      write(_chunk, _enc, cb) {
        cb(enospc());
      },
    }) as unknown as fs.WriteStream,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(whisperPath('base.en'), { force: true });
});

describe('a failed model download write is an error, not a crash', () => {
  it('whisper: the caller sees ENOSPC, not ERR_STREAM_DESTROYED', async () => {
    stubFetch(1);
    everyWriteFails();
    await expect(ensureWhisperModel('base.en')).rejects.toMatchObject({ code: 'ENOSPC' });
  });

  it('moonshine: the caller sees ENOSPC', async () => {
    stubFetch(1);
    everyWriteFails();
    await expect(ensureMoonshineFiles()).rejects.toMatchObject({ code: 'ENOSPC' });
  });

  it('kokoro: the caller sees ENOSPC', async () => {
    stubFetch(1);
    everyWriteFails();
    await expect(ensureKokoroFiles()).rejects.toMatchObject({ code: 'ENOSPC' });
  });

  it('the success path still writes the model and leaves no .partial', async () => {
    // No spy here: afterEach restores mocks, so this case runs against the
    // real fs.createWriteStream.
    stubFetch(2);
    const dest = await ensureWhisperModel('base.en');
    expect(dest).toBe(whisperPath('base.en'));
    expect(fs.statSync(dest).size).toBe(2048);
    expect(fs.existsSync(`${dest}.partial`)).toBe(false);
  });
});
