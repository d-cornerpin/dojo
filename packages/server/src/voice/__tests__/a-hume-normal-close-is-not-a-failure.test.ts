// A reply that Hume finishes and closes normally must not look like a cloud failure; a hang-up, an
// error frame or a socket that sends no audio mid-reply must.
import { describe, it, expect, vi } from 'vitest';

type Handler = (...a: unknown[]) => void;
const handlers = new Map<string, Handler>();
const fire = (ev: string, ...a: unknown[]): void => handlers.get(ev)?.(...a);
const socket = {
  on: (ev: string, h: Handler) => { handlers.set(ev, h); },
  waitForOpen: async () => {},
  close: () => {},
  sendPublish: (m: Record<string, unknown>) => { if (m.close) setTimeout(() => fire('close'), 0); },
};

vi.mock('hume', () => ({
  HumeClient: class { tts = { streamInput: { connect: async () => socket } }; },
}));
vi.mock('../../config/loader.js', () => ({ getProviderCredential: () => 'stand-in-key' }));
vi.mock('../../costs/tracker.js', () => ({ recordCost: () => {} }));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }) };
});

const { HumeStreamSession } = await import('../hume-engine.js');

const audio = (text: string, isLastChunk: boolean) => ({
  type: 'audio', audio: Buffer.from([1, 2, 3, 4]).toString('base64'), generationId: 'g', isLastChunk, text,
});

async function openSession(): Promise<{ s: InstanceType<typeof HumeStreamSession>; errors: string[]; done: string[] }> {
  const s = new HumeStreamSession({ voiceId: 'v', agentId: 'agent-1' });
  const errors: string[] = [];
  const done: string[] = [];
  s.onDrop = (e) => errors.push(e.message);
  s.onSnippetDone = (t) => done.push(t);
  await s.open();
  return { s, errors, done };
}

describe('a Hume reply that ends normally is not a failure', () => {
  it('audio, the end of the snippet, then our own close: no error, the snippet text reported', async () => {
    const { s, errors, done } = await openSession();
    s.push('Hello.');
    fire('message', audio('Hello.', true));
    await s.close();
    expect(done).toEqual(['Hello.']);
    expect(errors).toEqual([]);
  });

  it('a final frame with no audio still counts its snippet as done, and sends no sound', async () => {
    const { s, errors, done } = await openSession();
    const wavs: unknown[] = [];
    s.onWav = (w) => wavs.push(w);
    s.push('Done.');
    fire('message', { ...audio('Done.', true), audio: '' });
    expect(done).toEqual(['Done.']);
    expect(wavs).toEqual([]);
    await s.close();
    expect(errors).toEqual([]);
  });

  it('a hang-up we did not ask for is an error', async () => {
    const { errors } = await openSession();
    fire('close');
    expect(errors).toEqual(['Hume hung up mid-stream']);
  });

  it('the SDK error frame (no type, message only) is an error', async () => {
    const { errors } = await openSession();
    fire('message', { code: 'E', message: 'quota exceeded' });
    expect(errors).toEqual(['Hume error frame']);
  });

  it('words with no audio three seconds after the first push are an error; audio in time is not', async () => {
    vi.useFakeTimers();
    try {
      for (const answers of [false, true]) {
        const { s } = await openSession();
        const failures: string[] = [];
        s.onError = (e) => failures.push(e.message);
        s.push('Hello.');
        if (answers) fire('message', audio('Hello.', true));
        await vi.advanceTimersByTimeAsync(3_000);
        expect(failures).toEqual(answers ? [] : ['Hume sent no audio within 3 s']);
      }
    } finally { vi.useRealTimers(); }
  });
});
