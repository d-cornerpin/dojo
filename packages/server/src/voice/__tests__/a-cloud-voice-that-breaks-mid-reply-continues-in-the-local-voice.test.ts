// A dashboard voice session with the cloud voice chosen: when the cloud voice breaks, the owner keeps
// hearing the reply in the local voice, from the first words not yet spoken, with no action and one notice.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WsEvent } from '@dojo/shared';

const bus = new Set<(e: WsEvent) => void>();
const emit = (e: WsEvent): void => { for (const h of [...bus]) h(e); };

// The cloud stand-in: each pushed utterance succeeds, goes silent-and-fails, or is cut part-way.
type Step = 'ok' | 'fail' | 'cut';
let script: Step[] = [];
let failOpen = false;

vi.mock('hume', () => ({ HumeClient: class {} }));
vi.mock('../hume-engine.js', () => ({
  isHumeConfigured: () => true,
  HumeStreamSession: class {
    onWav: ((wav: Buffer, last: boolean) => void) | null = null;
    onError: ((e: Error) => void) | null = null;
    private pending = '';
    private n = 0;
    async open(): Promise<void> { if (failOpen) throw new Error('refused'); }
    push(t: string): void { this.pending += t; }
    flush(): void {
      if (!this.pending) return;
      this.pending = '';
      const step = script[this.n++] ?? 'ok';
      setTimeout(() => {
        if (step === 'ok') this.onWav?.(Buffer.from('cloud'), true);
        if (step === 'cut') { this.onWav?.(Buffer.from('cloud'), false); this.onError?.(new Error('dropped')); }
        if (step === 'fail') this.onError?.(new Error('quota'));
      }, 0);
    }
    setDescription(): void {}
    async close(): Promise<void> {}
  },
}));

const localSaid: string[] = [];
let localBroken = false;
vi.mock('../tts-service.js', async (orig) => ({
  ...(await orig<typeof import('../tts-service.js')>()),
  loadKokoro: async () => ({}),
  isKokoroLoaded: () => true,
  async* synthesizeClauseStream(queue: AsyncIterable<string>) {
    if (localBroken) throw new Error('kokoro down');
    for await (const c of queue) { localSaid.push(c); yield { text: c, pcm: new Float32Array(4), sampleRate: 24000 }; }
  },
}));
vi.mock('../stt-service.js', () => ({
  transcribeBuffer: vi.fn(), ensureSttReady: async () => {}, DEFAULT_STT_MODEL_KEY: 'moonshine-base',
  parseSttModelKey: () => ({ kind: 'moonshine' }), pcmFloatToWav: () => Buffer.from('local'),
}));
vi.mock('../smart-turn.js', () => ({ predictTurnComplete: vi.fn(), TURN_COMPLETE_THRESHOLD: 0.5, warmUpSmartTurn: async () => {} }));
vi.mock('../session-record.js', () => ({
  startVoiceSessionRecord: () => null, endVoiceSessionRecord: () => {}, bumpVoiceSessionTurnCount: () => {}, stampSpokenMessage: () => {},
}));
vi.mock('../custom-voices.js', () => ({ checkCustomVoiceUsable: () => ({ ok: true }) }));
vi.mock('../model-manager.js', () => ({ KOKORO_MODEL_ID: 'k' }));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: WsEvent) => emit(e),
  onBroadcast: (h: (e: WsEvent) => void) => { bus.add(h); return () => { bus.delete(h); }; },
}));
vi.mock('../../gateway/routes/chat.js', () => ({ submitUserMessage: vi.fn() }));
vi.mock('../../config/loader.js', () => ({ getJwtSecret: () => 'secret' }));
vi.mock('../../config/platform.js', () => ({ getPrimaryAgentName: () => 'Agent' }));
vi.mock('../../agent/v2/outbound.js', () => ({ recordAtDoor: () => ({}), recordedId: () => '' }));
vi.mock('../../memory/message-store.js', () => ({ markSpokenAloud: () => 0 }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => ({}) }) }),
}));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }) };
});

const jwt = (await import('jsonwebtoken')).default;
const { verifyAndOpenVoiceSession, handleVoiceMessage, closeVoiceSession } = await import('../voice-ws.js');

const A = 'agent-1';
const chunk = (content: string, done = false): WsEvent => ({ type: 'chat:chunk', agentId: A, messageId: 'm1', content, done });
const idle = (): WsEvent => ({ type: 'agent:status', agentId: A, status: 'idle' } as WsEvent);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 15));

let sent: Array<Record<string, unknown>>;
let binaries: number;
const ws = {
  send: (d: unknown) => { if (typeof d === 'string') sent.push(JSON.parse(d)); else binaries++; },
  close: () => {},
};
const types = (t: string): Array<Record<string, unknown>> => sent.filter((m) => m.type === t);

// The local burst's own end frame (cloud bursts are named tts-cloud-*).
const localReplyEnded = (): Promise<void> =>
  vi.waitFor(() => expect(types('voice:tts_end').some((m) => !String(m.messageId).startsWith('tts-cloud'))).toBe(true));

async function openCloudSession(): Promise<void> {
  const token = jwt.sign({ userId: 'u1' }, 'secret');
  verifyAndOpenVoiceSession(ws as never, `/voice?token=${token}&agentId=${A}`);
  await handleVoiceMessage(ws as never, JSON.stringify({ type: 'config', cloudVoice: 'v1' }));
  await handleVoiceMessage(ws as never, JSON.stringify({ type: 'config', ttsEngine: 'cloud' }));
}

beforeEach(() => {
  closeVoiceSession(ws as never);
  bus.clear();
  sent = []; binaries = 0; localSaid.length = 0;
  script = []; failOpen = false; localBroken = false;
});

describe('a cloud voice that breaks mid-reply continues in the local voice', () => {
  it('a failure before any audio: the whole reply is spoken locally, with one notice', async () => {
    script = ['fail'];
    await openCloudSession();
    emit(chunk('First part. '));
    await settle();
    emit(chunk('Second part.', true));
    emit(idle());
    await localReplyEnded();
    expect(localSaid.join('')).toBe('First part.Second part.');
    expect(types('voice:notice')).toHaveLength(1);
  });

  it('a failure after some audio: only the sentences not yet spoken are said locally', async () => {
    script = ['ok', 'fail'];
    await openCloudSession();
    emit(chunk('First part. '));
    await settle();
    emit(chunk('Second part. '));
    await settle();
    emit(chunk('Third part.', true));
    emit(idle());
    await localReplyEnded();
    expect(localSaid.join('')).toBe('Second part.Third part.');
    expect(types('voice:notice')).toHaveLength(1);
  });

  it('a sentence cut part-way is said whole in the local voice, and earlier ones are not repeated', async () => {
    script = ['ok', 'cut'];
    await openCloudSession();
    emit(chunk('First part. '));
    await settle();
    emit(chunk('Second part.', true));
    await settle();
    emit(idle());
    await localReplyEnded();
    expect(localSaid.join('')).toBe('Second part.');
  });

  it('control: a reply the cloud speaks in full is not also said locally', async () => {
    script = ['ok'];
    await openCloudSession();
    emit(chunk('Only part.', true));
    await settle();
    expect(localSaid).toEqual([]);
    expect(types('voice:state').at(-1)?.state).toBe('speaking');
  });

  it('a cloud voice that refuses to connect speaks the whole reply locally', async () => {
    failOpen = true;
    await openCloudSession();
    emit(chunk('Only part.', true));
    emit(idle());
    await localReplyEnded();
    expect(localSaid.join('')).toBe('Only part.');
  });

  it('when the local voice cannot speak either, the failure shows as before', async () => {
    script = ['fail'];
    localBroken = true;
    await openCloudSession();
    emit(chunk('Lost part.', true));
    emit(idle());
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'voice:state' && m.state === 'error')).toBe(true));
  });
});
