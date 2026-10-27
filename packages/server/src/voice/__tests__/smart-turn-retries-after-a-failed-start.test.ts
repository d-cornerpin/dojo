// One failed smart-turn start must not disable the model until restart.
// The three lazy loaders cache module-level promises; a rejected cached
// promise was replayed forever, so a first-start network failure meant the
// download was never retried and every prediction fell back to the silence
// heuristic for the life of the server. A failed write during the download
// had no 'error' listener and took the whole server down.
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VOICE_ROOT } from '../model-manager.js';

vi.mock('onnxruntime-node', () => ({
  default: {
    InferenceSession: { create: async () => ({ run: async () => ({ logits: { data: [0.9] } }) }) },
    Tensor: class {},
  },
}));
vi.mock('@huggingface/transformers', () => ({
  WhisperFeatureExtractor: class {
    constructor() {
      return async () => ({ input_features: { data: [0, 0], dims: [1, 2] } });
    }
  },
}));

const MODEL_PATH = path.join(VOICE_ROOT, 'smart-turn', 'smart-turn-v3.2-cpu.onnx');

// A 200 response whose body yields one 64-byte chunk and then reports done.
function onlineResponse() {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => {
        let yielded = false;
        return {
          read: async () => {
            if (!yielded) {
              yielded = true;
              return { done: false, value: new Uint8Array(64) };
            }
            return { done: true, value: undefined };
          },
        };
      },
    },
  };
}

async function freshSmartTurn() {
  vi.resetModules();
  return await import('../smart-turn.js');
}

// The module-level promises are module state, so each case re-imports the
// module fresh: first call rejects (offline), later calls stream the model.
function stubOfflineThenOnline() {
  let calls = 0;
  const fetchMock = vi.fn(async () => {
    if (calls++ === 0) throw new Error('network down');
    return onlineResponse();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try { fs.unlinkSync(MODEL_PATH); } catch { /* not downloaded in this case */ }
  try { fs.unlinkSync(`${MODEL_PATH}.partial`); } catch { /* no partial to clean */ }
});

describe('smart-turn retries after a failed start', () => {
  it('an offline first warm-up retries the download on the second warm-up', async () => {
    const st = await freshSmartTurn();
    const fetchMock = stubOfflineThenOnline();
    await st.warmUpSmartTurn();
    await st.warmUpSmartTurn();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(st.isSmartTurnDownloaded()).toBe(true);
  });

  it('after a failed then successful start, predictTurnComplete uses the model', async () => {
    const st = await freshSmartTurn();
    stubOfflineThenOnline();
    await st.warmUpSmartTurn();
    await st.warmUpSmartTurn();
    const p = await st.predictTurnComplete(new Float32Array(16000), 16000);
    expect(p).toBe(0.9);
  });

  it('a failed download write is an error, not a crash', async () => {
    const st = await freshSmartTurn();
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: {
        getReader: () => ({
          read: async () => {
            if (reads++ === 0) {
              await new Promise((resolve) => setTimeout(resolve, 20));
              return { done: false, value: new Uint8Array(64) };
            }
            return { done: true, value: undefined };
          },
        }),
      },
    })));
    vi.spyOn(fs, 'createWriteStream').mockReturnValue(
      new Writable({
        write(_c, _e, cb) {
          cb(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
        },
      }) as unknown as fs.WriteStream,
    );
    await expect(st.ensureSmartTurnModel()).rejects.toMatchObject({ code: 'ENOSPC' });
  });

  it('an already-present model still needs no fetch', async () => {
    const st = await freshSmartTurn();
    fs.mkdirSync(path.dirname(MODEL_PATH), { recursive: true });
    fs.writeFileSync(MODEL_PATH, Buffer.alloc(10));
    const fetchMock = vi.fn(async () => onlineResponse());
    vi.stubGlobal('fetch', fetchMock);
    await expect(st.ensureSmartTurnModel()).resolves.toBe(MODEL_PATH);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
