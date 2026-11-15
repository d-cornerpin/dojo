// A reply that Hume finishes and closes normally must not look like a cloud failure; a hang-up or an
// error frame mid-reply must.
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
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }) };
});

const { HumeStreamSession } = await import('../hume-engine.js');

const audio = (text: string, isLastChunk: boolean) => ({
  type: 'audio', audio: Buffer.from([1, 2, 3, 4]).toString('base64'), generationId: 'g', isLastChunk, text,
});

async function openSession(): Promise<{ s: InstanceType<typeof HumeStreamSession>; errors: string[]; done: string[] }> {
  const s = new HumeStreamSession({ voiceId: 'v' });
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
});
