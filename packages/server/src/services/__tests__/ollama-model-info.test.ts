// getOllamaModelInfo / listOllamaModels / listOllamaModelNames read an Ollama
// reply and decide a local model's context window, its output cap and its
// capability tags; those numbers feed the memory-fit and budget logic, yet none
// of the three had a test. These pin the parsing rules as the code writes them:
//   window  – a model_info key whose name holds `context_length` (or is `num_ctx`),
//             a `num_ctx N` line in the parameters text overriding it;
//   cap     – an explicit `num_predict N`, else min(floor(window/4), 32768) when
//             the window is strictly above 32000, else null;
//   tags    – `chat` on every model, `code` for a name holding `code`/`deepseek`,
//             `vision` for `vision`/`llava`; a non-OK reply or a thrown fetch is [].
// Ollama's side-effecting modules are stubbed so a parsed reply never touches the
// database, the model retry or a memory reader.
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../local-standard.js', () => ({ retryStandardModelsIfMissing: vi.fn() }));
vi.mock('../../db/connection.js', () => ({ getDb: () => { throw new Error('unused'); } }));
vi.mock('../../memory/writer.js', () => ({ clearOn: vi.fn() }));

import { getOllamaModelInfo, listOllamaModels, listOllamaModelNames } from '../ollama.js';

// A 200 reply whose JSON body is `body`; returns the fetch mock so a clause can
// assert on the request it saw.
const stubFetch = (body: unknown) => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('getOllamaModelInfo', () => {
  it('a context_length above 32000 caps output at min(window/4, 32768)', async () => {
    stubFetch({ model_info: { 'llama.context_length': 131072 } });
    expect(await getOllamaModelInfo('m:7b')).toEqual({ contextWindow: 131072, maxOutputTokens: 32768 });
  });

  it('a context window at or below 32000 leaves the cap null', async () => {
    stubFetch({ model_info: { 'general.architecture': 'llama', 'llama.context_length': 8192 } });
    expect(await getOllamaModelInfo('m:7b')).toEqual({ contextWindow: 8192, maxOutputTokens: null });
  });

  it('the parameters text sets the window and an explicit cap', async () => {
    stubFetch({ parameters: 'num_ctx                        16384\nnum_predict                    2048' });
    expect(await getOllamaModelInfo('m:7b')).toEqual({ contextWindow: 16384, maxOutputTokens: 2048 });
  });

  it('a num_ctx in the parameters text overrides the model_info window', async () => {
    stubFetch({ model_info: { 'llama.context_length': 131072 }, parameters: 'num_ctx 40000' });
    expect(await getOllamaModelInfo('m:7b')).toEqual({ contextWindow: 40000, maxOutputTokens: 10000 });
  });

  it('32768 caps at 8192, but 32000 does not cross the threshold so it is null', async () => {
    stubFetch({ model_info: { 'llama.context_length': 32768 } });
    expect(await getOllamaModelInfo('m:7b')).toEqual({ contextWindow: 32768, maxOutputTokens: 8192 });
    stubFetch({ model_info: { 'llama.context_length': 32000 } });
    expect(await getOllamaModelInfo('m:7b')).toEqual({ contextWindow: 32000, maxOutputTokens: null });
  });

  it('an explicit num_predict in the parameters wins over the window/4 cap', async () => {
    stubFetch({ model_info: { 'llama.context_length': 131072 }, parameters: 'num_predict 512' });
    expect(await getOllamaModelInfo('m:7b')).toEqual({ contextWindow: 131072, maxOutputTokens: 512 });
  });

  it('a non-numeric window, a num_ctx key, and an empty body each pin what they give', async () => {
    stubFetch({ model_info: { 'llama.context_length': '4096' } });   // a string is not a window
    expect(await getOllamaModelInfo('m:7b')).toEqual({ contextWindow: null, maxOutputTokens: null });
    stubFetch({ model_info: { num_ctx: 4096 } });
    expect(await getOllamaModelInfo('m:7b')).toEqual({ contextWindow: 4096, maxOutputTokens: null });
    stubFetch({});
    expect(await getOllamaModelInfo('m:7b')).toEqual({ contextWindow: null, maxOutputTokens: null });
  });

  it('a non-OK reply is null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })));
    expect(await getOllamaModelInfo('m:7b')).toBeNull();
  });

  it('a fetch that rejects is null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await getOllamaModelInfo('m:7b')).toBeNull();
  });

  it('POSTs { name } to /api/show on the base url', async () => {
    const fetchMock = stubFetch({ model_info: { 'llama.context_length': 131072 } });
    await getOllamaModelInfo('m:7b');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/show',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'm:7b' }) }),
    );
  });

  it('a custom base url is honoured', async () => {
    const fetchMock = stubFetch({ model_info: { 'llama.context_length': 131072 } });
    await getOllamaModelInfo('m:7b', 'http://10.0.0.5:11434');
    expect(fetchMock).toHaveBeenCalledWith('http://10.0.0.5:11434/api/show', expect.anything());
  });
});

describe('listOllamaModels', () => {
  it('tags chat on every model, plus code and vision read from the (lower-cased) name', async () => {
    stubFetch({ models: [
      { name: 'qwen2.5-coder:7b', size: 1 },
      { name: 'deepseek-r1:8b', size: 1 },
      { name: 'llava:13b', size: 1 },
      { name: 'Llama3.2-Vision', size: 1 },
      { name: 'mistral:7b', size: 1 },
      { name: 'deepseek-vision', size: 1 },
    ] });
    const byName = new Map((await listOllamaModels()).map(m => [m.name, m.capabilities] as const));
    expect(byName.get('qwen2.5-coder:7b')).toEqual(['chat', 'code']);
    expect(byName.get('deepseek-r1:8b')).toEqual(['chat', 'code']);
    expect(byName.get('llava:13b')).toEqual(['chat', 'vision']);
    expect(byName.get('Llama3.2-Vision')).toEqual(['chat', 'vision']);
    expect(byName.get('mistral:7b')).toEqual(['chat']);
    expect(byName.get('deepseek-vision')).toEqual(['chat', 'code', 'vision']);
  });

  it('keeps the name and size on each model', async () => {
    stubFetch({ models: [{ name: 'mistral:7b', size: 1 }] });
    expect(await listOllamaModels()).toEqual([{ name: 'mistral:7b', size: 1, capabilities: ['chat'] }]);
  });

  it('a missing models key is []', async () => {
    stubFetch({});
    expect(await listOllamaModels()).toEqual([]);
  });

  it('a non-OK reply is []', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })));
    expect(await listOllamaModels()).toEqual([]);
  });

  it('a fetch that rejects is []', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await listOllamaModels()).toEqual([]);
  });

  it('listOllamaModelNames returns just the names', async () => {
    stubFetch({ models: [{ name: 'mistral:7b', size: 1 }, { name: 'llava:13b', size: 1 }] });
    expect(await listOllamaModelNames()).toEqual(['mistral:7b', 'llava:13b']);
  });
});
