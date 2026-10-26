// A JSON line that is cut by a network chunk boundary is two halves, and neither half parses,
// so both are skipped. A pull of a large model sends thousands of progress lines, so chunk
// boundaries fall anywhere on a real socket. This suite pins the line buffer that keeps the
// unfinished tail of each chunk until the next chunk completes the line.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { pullOllamaModel, type PullProgress } from '../ollama-pull.js';

vi.mock('../ollama-quiet.js', () => ({
  localWorkBegins: async () => () => undefined,
}));

function streamOfBytes(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
}

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return streamOfBytes(...chunks.map((s) => new TextEncoder().encode(s)));
}

function pullWith(body: ReadableStream<Uint8Array>): { result: Promise<Awaited<ReturnType<typeof pullOllamaModel>>>; progress: PullProgress[] } {
  const progress: PullProgress[] = [];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
  const result = pullOllamaModel('qwen3.5:4b', { baseUrl: 'http://localhost:11434', onProgress: (p) => progress.push(p) });
  return { result, progress };
}

afterEach(() => vi.unstubAllGlobals());

describe('pullOllamaModel: progress lines split across chunks', () => {
  it('an error line cut across two chunks is still reported (was dropped before)', async () => {
    const { result, progress } = pullWith(streamOf(
      '{"status":"pulling manifest"}\n{"error":"pull model mani',
      'fest: file does not exist"}\n',
    ));
    expect(await result).toEqual({ ok: false, error: 'pull model manifest: file does not exist', httpError: true });
    expect(progress[progress.length - 1]).toMatchObject({ status: 'error', error: 'pull model manifest: file does not exist' });
  });

  it('a progress line split mid-number still reports its byte totals', async () => {
    const { result, progress } = pullWith(streamOf(
      '{"status":"pulling abc","digest":"d1","total":1000,"compl',
      'eted":250}\n{"status":"success"}\n',
    ));
    expect(await result).toEqual({ ok: true, status: 'success' });
    expect(progress.some((p) => p.status === 'pulling abc' && p.completed === 250 && p.total === 1000 && p.layers === 1)).toBe(true);
  });

  it('cumulative progress across two digests in separate chunks', async () => {
    const { result, progress } = pullWith(streamOf(
      '{"status":"pulling abc","digest":"d1","total":1000,"completed":400}\n',
      '{"status":"pulling def","digest":"d2","total":3000,"completed":600}\n',
    ));
    expect(await result).toEqual({ ok: true, status: 'pulling def' });
    expect(progress.some((p) => p.completed === 1000 && p.total === 4000 && p.layers === 2)).toBe(true);
  });

  it('whole lines in one chunk (passes before and after)', async () => {
    const { result } = pullWith(streamOf('{"status":"pulling manifest"}\n{"status":"success"}\n'));
    expect(await result).toEqual({ ok: true, status: 'success' });
  });

  it('a last line with no trailing newline still completes', async () => {
    const { result } = pullWith(streamOf('{"status":"pulling manifest"}\n{"status":"success"}'));
    expect(await result).toEqual({ ok: true, status: 'success' });
  });

  it('a chunk ending exactly on a newline loses no call and duplicates none', async () => {
    const { result, progress } = pullWith(streamOf(
      '{"status":"pulling manifest"}\n',
      '{"status":"success"}\n',
    ));
    expect(await result).toEqual({ ok: true, status: 'success' });
    expect(progress.map((p) => p.status)).toEqual(['starting', 'pulling manifest', 'success']);
  });

  it('blank and non-JSON lines between valid lines are skipped', async () => {
    const { result } = pullWith(streamOf('{"status":"pulling manifest"}\n\nhello\n{"status":"success"}\n'));
    expect(await result).toEqual({ ok: true, status: 'success' });
  });

  it('a multi-byte character cut across two chunks stays intact', async () => {
    const bytes = new TextEncoder().encode('{"status":"pulling é"}\n{"status":"success"}\n');
    const c3 = bytes.findIndex((b) => b === 0xc3);
    const { result, progress } = pullWith(streamOfBytes(bytes.slice(0, c3 + 1), bytes.slice(c3 + 1)));
    expect(await result).toEqual({ ok: true, status: 'success' });
    expect(progress.some((p) => p.status === 'pulling é')).toBe(true);
  });
});
