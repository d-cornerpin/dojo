// A model's own window is the exact `<arch>.context_length` key — the same key
// num-ctx-calculator reads — not the last model_info key whose name merely holds
// `context_length`: a rope-scaling figure (`*.rope.scaling.original_context_length`)
// sorts after it and used to win. The loose walk stays as the fallback when the
// exact key is missing, and it now ignores any rope key. A `num_ctx N` line in
// the parameters text still overrides whatever model_info said.
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../local-standard.js', () => ({ retryStandardModelsIfMissing: vi.fn() }));
vi.mock('../../db/connection.js', () => ({ getDb: () => { throw new Error('unused'); } }));
vi.mock('../../memory/writer-wait.js', () => ({ writersMayBeBack: vi.fn() }));
vi.mock('../../memory/writer-no-room.js', () => ({ freeMemoryMayBeReadable: vi.fn() }));

import { getOllamaModelInfo } from '../ollama.js';

// A 200 reply whose JSON body is `body`; returns the fetch mock so a clause can
// assert on the request it saw.
const stubFetch = (body: unknown) => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('getOllamaModelInfo reads the model context length from its own arch key', () => {
  it('the exact <arch>.context_length key wins over a rope-scaling key that sorts later', async () => {
    stubFetch({ model_info: {
      'general.architecture': 'gptoss',
      'gptoss.context_length': 131072,
      'gptoss.rope.scaling.original_context_length': 4096,
    } });
    expect(await getOllamaModelInfo('m:7b')).toEqual({ contextWindow: 131072, maxOutputTokens: 32768 });
  });

  it('the fallback walk ignores the rope key when no general.architecture names the model', async () => {
    stubFetch({ model_info: {
      'gptoss.context_length': 131072,
      'gptoss.rope.scaling.original_context_length': 4096,
    } });
    expect(await getOllamaModelInfo('m:7b')).toEqual({ contextWindow: 131072, maxOutputTokens: 32768 });
  });

  it('a lone <arch>.context_length without general.architecture still gives the window (unchanged)', async () => {
    stubFetch({ model_info: { 'llama.context_length': 8192 } });
    expect(await getOllamaModelInfo('m:7b')).toEqual({ contextWindow: 8192, maxOutputTokens: null });
  });

  it('a num_ctx line in the parameters text still overrides the exact key', async () => {
    stubFetch({
      model_info: {
        'general.architecture': 'gptoss',
        'gptoss.context_length': 131072,
        'gptoss.rope.scaling.original_context_length': 4096,
      },
      parameters: 'num_ctx                        16384',
    });
    expect(await getOllamaModelInfo('m:7b')).toEqual({ contextWindow: 16384, maxOutputTokens: null });
  });
});
