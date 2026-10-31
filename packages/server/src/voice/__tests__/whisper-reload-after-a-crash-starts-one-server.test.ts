// ─────────────────────────────────────────────────────────────────────────────
// WHISPER RELOAD AFTER A CRASH STARTS ONE SERVER — after the child dies,
// `ensureSttReady` returns at once (the engine object still has the right key)
// and every caller walks into `WhisperEngine.load()`. `load()` had no record
// of a reload already in flight, so two utterances landing during the crash
// back-off each ran `spawnServer()` and each assigned `this.server`; the later
// assignment orphaned the first child (no handle, its `exit` handler no longer
// matches, `dispose()` only stops the handle it holds). Then the restart timer
// fired and spawned yet another one over the top.
//
// TIMERS: the crash and the two reload transcriptions run on REAL timers (the
// ready-wait returns on the first probe, so it is fast). Fake timers are
// switched on only for the back-off phase.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Hoisted child-process fakes ──
// The fake behaves like Node: `kill` flips `killed` on send, and the `exit`
// event is a SEPARATE thing the test emits. `exitCode`/`signalCode` stay null
// until the test sets them, mirroring a child that is still alive.
const h = vi.hoisted(() => {
  class FakeStream {
    private data: Array<(c: Buffer) => void> = [];
    on(ev: string, cb: (c: Buffer) => void): this {
      if (ev === 'data') this.data.push(cb);
      return this;
    }
    emit(ev: string, c: Buffer): boolean {
      if (ev === 'data') this.data.forEach((cb) => cb(c));
      return true;
    }
  }

  class FakeChild {
    stdout = new FakeStream();
    stderr = new FakeStream();
    pid = 4242;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    killed = false;
    kill: (sig: string) => boolean;
    private exitHandlers: Array<(...a: unknown[]) => void> = [];

    constructor() {
      this.kill = vi.fn((sig: string) => {
        this.killed = true;
        return true;
      });
    }

    once(ev: string, cb: (...a: unknown[]) => void): this {
      if (ev === 'exit') this.exitHandlers.push(cb);
      return this;
    }
    on(ev: string, cb: (...a: unknown[]) => void): this {
      if (ev === 'exit') this.exitHandlers.push(cb);
      return this;
    }
    emit(ev: string, ...args: unknown[]): boolean {
      if (ev === 'exit') {
        const hs = this.exitHandlers;
        this.exitHandlers = [];
        hs.forEach((cb) => cb(...args));
      }
      return true;
    }
  }

  const children: FakeChild[] = [];
  let fetchStatus = 200;
  let slowBoot = false;

  const spawn = vi.fn(() => {
    const c = new FakeChild();
    children.push(c);
    return c;
  });

  // The readiness probe only needs `fetch` to return a 2xx status; an
  // `/inference` POST answers with the transcript so a reload is observable
  // through `transcribeBuffer`. `slowBoot` makes a boot take 1000 ms of fake
  // clock so a dispose can land mid-boot.
  const fetch = vi.fn(async (url?: unknown) => {
    if (typeof url === 'string' && url.endsWith('/inference')) {
      return { ok: true, status: 200, json: async () => ({ text: 'hello' }) } as Response;
    }
    if (slowBoot) await new Promise((r) => setTimeout(r, 1000));
    return { status: fetchStatus } as Response;
  });

  return {
    children,
    spawn,
    fetch,
    setFetchStatus: (s: number) => { fetchStatus = s; },
    setSlowBoot: (b: boolean) => { slowBoot = b; },
    reset: () => {
      children.length = 0;
      fetchStatus = 200;
      slowBoot = false;
    },
  };
});

// ── Mocks ──
// `existsSync` returns true so the binary-availability check passes; spread
// the real module for the rest of the fs surface.
vi.mock('node:fs', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...fs,
    default: { ...(fs.default as Record<string, unknown>), existsSync: () => true },
  };
});

// `pickFreePort` and `probeTcp` both go through `node:net`. Fake `createServer`
// to report a fixed port (so `pickFreePort` resolves) and `Socket` to connect
// immediately (so the TCP probe succeeds).
vi.mock('node:net', () => {
  const PORT = 54321;
  class FakeSocket {
    private listeners: Record<string, Array<{ cb: (...a: unknown[]) => void; once: boolean }>> = {
      connect: [],
      timeout: [],
      error: [],
    };
    setTimeout(): this { return this; }
    once(ev: string, cb: (...a: unknown[]) => void): this {
      this.listeners[ev]?.push({ cb, once: true });
      return this;
    }
    on(ev: string, cb: (...a: unknown[]) => void): this {
      this.listeners[ev]?.push({ cb, once: false });
      return this;
    }
    connect(): this {
      this.emit('connect');
      return this;
    }
    destroy(): void { /* no-op */ }
    emit(ev: string, ...a: unknown[]): boolean {
      const arr = this.listeners[ev] ?? [];
      this.listeners[ev] = arr.filter((l) => !l.once);
      arr.forEach((l) => l.cb(...a));
      return true;
    }
  }
  const mod = {
    createServer: () => {
      const srv = {
        listen: (_p: number, _h: string, cb?: () => void) => { cb?.(); return srv; },
        address: () => ({ port: PORT }),
        close: (cb?: () => void) => { cb?.(); },
        on: () => srv,
      };
      return srv;
    },
    Socket: FakeSocket,
  };
  // `import net from 'node:net'` reads the default export — the CJS namespace.
  return { ...mod, default: mod };
});

vi.mock('node:child_process', () => ({ spawn: h.spawn }));

// The import chain (stt-service → tts-service → custom-voices) reads these
// constants at module-eval time (VOICE_ROOT in custom-voices, KOKORO_CACHE_DIR
// in tts-service), so the mock must supply the whole surface rather than
// partial-spread the real module — importOriginal re-enters the graph and
// crashes the worker on kokoro-js's phonemizer blob.
vi.mock('../model-manager.js', () => ({
  VOICE_ROOT: '/tmp/dojo-voice',
  MODELS_DIR: '/tmp/dojo-voice/models',
  KOKORO_CACHE_DIR: '/tmp/dojo-voice/kokoro',
  MOONSHINE_CACHE_DIR: '/tmp/dojo-voice/moonshine',
  WHISPER_MODELS: {
    'base.en': { size: 'base.en', filename: 'ggml-base.en.bin', url: 'u', approxBytes: 1, label: 'l' },
    'small.en': { size: 'small.en', filename: 'ggml-small.en.bin', url: 'u', approxBytes: 1, label: 'l' },
    'medium.en': { size: 'medium.en', filename: 'ggml-medium.en.bin', url: 'u', approxBytes: 1, label: 'l' },
    'large-v3-turbo': { size: 'large-v3-turbo', filename: 'ggml-large-v3-turbo-q5_0.bin', url: 'u', approxBytes: 1, label: 'l' },
  },
  DEFAULT_WHISPER: 'large-v3-turbo',
  KOKORO_MODEL_ID: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  MOONSHINE_MODEL_ID: 'onnx-community/moonshine-base-ONNX',
  moonshineLocalDir: () => '/tmp/dojo-voice/moonshine/onnx-community/moonshine-base-ONNX',
  isMoonshineFullyDownloaded: () => true,
  moonshineCacheBytes: () => 0,
  kokoroLocalDir: () => '/tmp/dojo-voice/kokoro',
  isKokoroFullyDownloaded: () => true,
  kokoroCacheBytes: () => 0,
  totalVoiceDiskBytes: () => 0,
  whisperPath: () => '/m.bin',
  isWhisperInstalled: () => true,
  ensureWhisperModel: vi.fn(),
  ensureKokoroFiles: vi.fn(),
  ensureMoonshineFiles: vi.fn(),
  listInstalledModels: () => [],
  isKokoroCached: () => true,
  deleteModel: vi.fn(),
  freeDiskMb: async () => 0,
}));

// stt-service re-exports from tts-service, which imports kokoro-js at module
// eval. kokoro-js pulls the ~200 KB minified espeak phonemizer blob, which
// crashes the vitest worker on load; this test never exercises TTS, so stub
// the classes out.
vi.mock('kokoro-js', () => ({
  KokoroTTS: class {
    static from_pretrained = vi.fn();
  },
  TextSplitterStream: class {},
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

const { ensureSttReady, transcribeBuffer } = await import('../stt-service.js');

beforeEach(() => {
  h.reset();
  // The ready-wait runs on real timers; fake timers are enabled per-test below,
  // only once the server is actually ready.
  vi.useRealTimers();
  vi.stubGlobal('fetch', h.fetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('whisper reload after a crash starts one server', () => {
  it('two transcriptions during the crash back-off reload one server, and the back-off adds none', async () => {
    await ensureSttReady('base.en');
    expect(h.spawn).toHaveBeenCalledTimes(1);

    // ── Case 1: crash, then two utterances land during the back-off ──
    // Real timers: the ready-wait returns on the first probe.
    h.children[0].emit('exit', 1, null);
    const [a, b] = await Promise.all([
      transcribeBuffer(Buffer.from('a'), { modelKey: 'base.en' }),
      transcribeBuffer(Buffer.from('b'), { modelKey: 'base.en' }),
    ]);
    expect(a.text).toBe('hello');
    expect(b.text).toBe('hello');
    // The reload is ONE spawn shared by both callers, not one per caller:
    // one for the original boot + one for the reload. (Fails before: 3.)
    expect(h.spawn).toHaveBeenCalledTimes(2);

    // ── Case 2: the restart back-off lands on the already-reloaded engine ──
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(31_000); // past the max back-off delay
    expect(h.spawn).toHaveBeenCalledTimes(2);
    // The live server is children[1] and was never signalled (nothing to
    // stop yet). Every OTHER child the engine let go of must have been
    // killed. The only child with no kill signal is children[0] — the one
    // that crashed by itself. (Fails before: the orphaned reload was a
    // second live child nobody held a handle to.)
    const live = h.children[1];
    const neverKilled = h.children.filter((c) => c !== live && !c.killed);
    expect(neverKilled).toEqual([h.children[0]]);
  });
});
