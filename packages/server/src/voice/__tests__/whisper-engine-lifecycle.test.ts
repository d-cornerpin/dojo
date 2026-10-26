// ─────────────────────────────────────────────────────────────────────────────
// WHISPER ENGINE LIFECYCLE — dispose must not orphan a child that ignores
// SIGTERM, and a server that never becomes ready (or lands on a disposed
// engine) must not be left running with nobody holding its handle.
//
// ROOT CAUSE (dispose): `ChildProcess.killed` flips as soon as the signal is
// *sent*, not when the child dies. So `if (!h.process.killed) kill('SIGKILL')`
// was always false after SIGTERM and the fallback could never fire — a child
// busy loading a large model (the case the 60 s boot-wait exists for) was left
// as an orphan holding its port and memory after `stopWhisperServer()` returned.
// The 2000 ms timer was also never cleared when the process exited at once.
//
// TIMERS: the ready-wait runs on REAL timers (it returns on the first probe,
// so it is fast and leaves nothing pending), and fake timers are switched on
// only for the dispose/restart phase — otherwise the ready-wait's own abort
// timer shows up in `vi.getTimerCount()` and the "no timer left" assertion is
// meaningless.
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

  // The readiness probe only needs `fetch` to return a 2xx status. `slowBoot`
  // makes a boot take 1000 ms of fake clock so a dispose can land mid-boot.
  const fetch = vi.fn(async () => {
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

const { ensureSttReady, stopWhisperServer } = await import('../stt-service.js');

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

describe('whisper engine lifecycle', () => {
  it('dispose sends SIGKILL when the child ignores SIGTERM (v35 orphans it)', async () => {
    await ensureSttReady('base.en');
    const child = h.children[0];

    vi.useFakeTimers();
    const done = stopWhisperServer();
    // The fake child never emits `exit`; it is still alive after SIGTERM.
    await vi.advanceTimersByTimeAsync(2001);
    await done;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('dispose clears the 2000 ms timer when the child exits right after SIGTERM', async () => {
    await ensureSttReady('base.en');
    const child = h.children[0];

    vi.useFakeTimers();
    const done = stopWhisperServer();
    child.emit('exit', 0, null);
    await done;

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('spawnServer kills the child when the readiness wait throws', async () => {
    h.setFetchStatus(500);
    vi.useFakeTimers();
    const p = ensureSttReady('base.en');
    // Attach the rejection handler now so the rejection (which happens during
    // the advance below) is not reported as an unhandled rejection.
    const outcome = p.then(
      () => { throw new Error('readiness wait should have rejected'); },
      (err: unknown) => err,
    );
    // Fake the clock past the 60 s quiet bound so the readiness wait gives up.
    await vi.advanceTimersByTimeAsync(61_000);
    const err = await outcome;
    expect(err).toBeInstanceOf(Error);

    const child = h.children[0];
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('a dispose landing during a restart boot leaves no live child', async () => {
    await ensureSttReady('base.en');
    const child0 = h.children[0];

    h.setSlowBoot(true);
    vi.useFakeTimers();
    // Simulate a crash: child0 exits, which schedules the restart back-off.
    child0.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(2000); // fire the restart delay
    // Now child1 is booting (slow boot), and dispose lands.
    await stopWhisperServer();
    await vi.advanceTimersByTimeAsync(1000); // let the boot finish

    const child1 = h.children[1];
    expect(child1.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
