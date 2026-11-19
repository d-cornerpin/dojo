// A dashboard voice session with the cloud voice chosen: when the cloud voice breaks, the owner keeps
// hearing the reply in the local voice, from the first words not yet spoken, with no action and one notice.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WsEvent } from '@dojo/shared';

const bus = new Set<(e: WsEvent) => void>();
const emit = (e: WsEvent): void => { for (const h of [...bus]) h(e); };

// The cloud stand-in: each pushed utterance finishes ('ok'), fails with no audio ('fail'), is cut
// part-way ('cut'), is split into two snippets with the failure after the first ('split'), or fails at
// once inside the send ('send').
type Step = 'ok' | 'fail' | 'cut' | 'split' | 'send';
let script: Step[] = [];
let pushes = 0;
let openFails = false;
let live: { onError: ((e: Error) => void) | null } | null = null;
const pushed: string[] = [];
let gate: Promise<void> | null = null;
let saved: Record<string, string> = {};

vi.mock('hume', () => ({ HumeClient: class {} }));
vi.mock('../hume-engine.js', () => ({
  isHumeConfigured: () => true,
  HumeStreamSession: class {
    onWav: ((wav: Buffer) => void) | null = null;
    onSnippetDone: ((text: string) => void) | null = null;
    onError: ((e: Error) => void) | null = null;
    private pending = '';
    constructor() { live = this; }
    async open(): Promise<void> { if (openFails) throw new Error('refused'); }
    push(t: string): void { this.pending += t; pushed.push(t); }
    flush(): void {
      const text = this.pending;
      if (!text) return;
      this.pending = '';
      const step = script[pushes++] ?? 'ok';
      if (step === 'send') { this.onError?.(new Error('send failed')); return; }
      setTimeout(() => {
        if (step === 'ok') { this.onWav?.(Buffer.from('cloud')); this.onSnippetDone?.(text); }
        if (step === 'split') {
          const cut = text.indexOf('.') + 1;
          this.onWav?.(Buffer.from('cloud')); this.onSnippetDone?.(text.slice(0, cut));
          this.onError?.(new Error('dropped'));
        }
        if (step === 'cut') { this.onWav?.(Buffer.from('cloud')); this.onError?.(new Error('dropped')); }
        if (step === 'fail') this.onError?.(new Error('quota'));
      }, 0);
    }
    setDescription(): void {}
    async close(): Promise<void> {}
  },
}));
vi.mock('../../agent/runtime.js', () => ({ preemptAgentForUrgentMessage: () => {} }));
vi.mock('../../memory/served-ask.js', () => ({ turnAnswersSpokenRequest: () => true }));

let heard = '';
const localSaid: string[] = [];
let localBroken = false;
vi.mock('../tts-service.js', async (orig) => ({
  ...(await orig<typeof import('../tts-service.js')>()),
  loadKokoro: async () => ({}),
  isKokoroLoaded: () => true,
  async* synthesizeClauseStream(queue: AsyncIterable<string>) {
    if (localBroken) throw new Error('kokoro down');
    for await (const c of queue) { await gate; localSaid.push(c); yield { text: c, pcm: new Float32Array(4), sampleRate: 24000 }; }
  },
}));
vi.mock('../stt-service.js', () => ({
  transcribeBuffer: async () => ({ text: heard, durationMs: 1 }), ensureSttReady: async () => {}, DEFAULT_STT_MODEL_KEY: 'moonshine-base',
  parseSttModelKey: () => ({ kind: 'moonshine' }), pcmFloatToWav: () => Buffer.from('local'),
}));
vi.mock('../smart-turn.js', () => ({ predictTurnComplete: vi.fn(), TURN_COMPLETE_THRESHOLD: 0.5, warmUpSmartTurn: async () => {} }));
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
  getDb: () => ({
    prepare: () => ({ all: () => Object.entries(saved).map(([key, value]) => ({ key, value })), get: () => undefined, run: () => ({}) }),
  }),
}));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }) };
});

const jwt = (await import('jsonwebtoken')).default;
const { verifyAndOpenVoiceSession, handleVoiceMessage, closeVoiceSession, pushVoiceFiller } = await import('../voice-ws.js');

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

// The local burst's own end frame (cloud bursts are named tts-cloud-*; ids carry their start time, which
// tells this test's bursts from a previous test's late repeats).
let t0 = 0;
const localReplyEnded = (): Promise<void> =>
  vi.waitFor(() => expect(types('voice:tts_end').some((m) => Number(String(m.messageId).slice(4)) >= t0)).toBe(true));

async function openCloudSession(): Promise<void> {
  saved = { 'voice.tts_engine': 'cloud', 'voice.cloud_voice': 'v1' };
  verifyAndOpenVoiceSession(ws as never, `/voice?token=${jwt.sign({ userId: 'u1' }, 'secret')}&agentId=${A}`);
}

beforeEach(() => {
  closeVoiceSession(ws as never);
  bus.clear();
  t0 = Date.now(); sent = []; binaries = 0; localSaid.length = 0;
  script = []; pushes = 0; localBroken = false; openFails = false; gate = null; pushed.length = 0; saved = {};
});

// Streams a reply part by part (the last one done), then waits for the local voice to finish it.
async function speak(...parts: string[]): Promise<void> {
  await openCloudSession();
  for (const [i, part] of parts.entries()) {
    emit(chunk(part, i === parts.length - 1));
    if (i < parts.length - 1) await settle();
  }
  emit(idle());
  await localReplyEnded();
}
const said = (): string => localSaid.join(' ');
const bargeIn = (): Promise<void> => handleVoiceMessage(ws as never, JSON.stringify({ type: 'barge_in' }));

describe('a cloud voice that breaks mid-reply continues in the local voice', () => {
  it('a failure before any audio: the whole reply is spoken locally, with one notice', async () => {
    script = ['fail'];
    await speak('First part. ', 'Second part.');
    expect(localSaid.join('')).toBe('First part. Second part.');
    expect(types('voice:notice')).toHaveLength(1);
  });

  it('a failure after some audio, even mid-sentence: only what was not finished is said locally', async () => {
    script = ['ok', 'cut'];
    await speak('First part. ', 'Second part. ', 'Third part.');
    expect(localSaid.join('')).toBe('Second part. Third part.');
    expect(types('voice:notice')).toHaveLength(1);
  });

  it('an utterance Hume split into two snippets: the unfinished half is said, nothing is skipped', async () => {
    script = ['split'];
    await speak('First half. Second half.');
    expect(said()).toBe('Second half.');
  });

  it('text split across chunks at the failure is spoken whole: a word, a control mark', async () => {
    script = ['fail'];
    await speak('First part. Sec', 'ond. [no-re', 'ply]');
    expect(said()).toContain('Second.');
    expect(said()).not.toMatch(/no-re/);
  });

  it('a delivery cue still streaming at the failure is not spoken aloud', async () => {
    await openCloudSession();
    emit(chunk('((deliver: warm'));
    await settle();
    live?.onError?.(new Error('dropped'));
    emit(chunk('ly)) Hello there.', true));
    emit(idle());
    await localReplyEnded();
    expect(said()).toBe('Hello there.');
  });

  it('a filler already pushed with a half-streamed delivery cue: the cue is still not spoken aloud', async () => {
    await openCloudSession();
    emit(chunk('((deliver: warm'));
    await settle();
    pushVoiceFiller(A, 'One moment.');
    live?.onError?.(new Error('dropped'));
    emit(chunk('ly)) Hello there.', true));
    emit(idle());
    await localReplyEnded();
    expect(said()).toContain('Hello there.');
    expect(said()).not.toContain('deliver');
  });

  it('a send that fails during the setup still hands over the whole reply, buffered chunks included', async () => {
    script = ['send'];
    await openCloudSession();
    emit(chunk('First part. '));
    emit(chunk('Second part.', true));
    emit(idle());
    await localReplyEnded();
    expect(said()).toBe('First part. Second part.');
  });

  it('a cloud voice that refuses to connect speaks the reply locally, with one notice', async () => {
    openFails = true;
    await speak('Only part.');
    expect(said()).toBe('Only part.');
    expect(types('voice:notice')).toHaveLength(1);
  });

  it('a reply that finished before the break is released and the owner is told once', async () => {
    script = ['fail'];
    await speak('Short.');
    expect(types('voice:notice')).toHaveLength(1);
    expect(types('voice:state').at(-1)?.state).toBe('listening');
  });

  it('a barge-in during the fallback stops the local voice and sends nothing more', async () => {
    script = ['fail'];
    await openCloudSession();
    emit(chunk('First part. '));
    await settle();
    await bargeIn();
    const [spoken, starts, audio] = [[...localSaid], types('voice:tts_start').length, binaries];
    emit(idle());
    await settle();
    expect([localSaid, types('voice:tts_start').length, binaries]).toEqual([spoken, starts, audio]);
  });

  it('a reply that starts after a barge-in keeps its own subscription when the old local burst ends', async () => {
    script = ['fail'];
    let release = (): void => {};
    gate = new Promise<void>((r) => { release = r; });
    await openCloudSession();
    emit(chunk('First part. ', true));
    emit(idle());
    await settle();
    await bargeIn();
    emit(chunk('Second reply. '));
    await settle();
    release();
    await settle();
    emit(chunk('Later words.', true));
    await settle();
    expect(pushed.join(' ')).toContain('Later words.');
  });

  it('the sleep phrase during a local reply leaves proactive messages spoken afterwards', async () => {
    const hear = async (text: string): Promise<void> => {
      heard = text;
      await handleVoiceMessage(ws as never, Buffer.from(new Float32Array(8000).buffer));
      await handleVoiceMessage(ws as never, JSON.stringify({ type: 'utterance_end' }));
    };
    let release = (): void => {};
    gate = new Promise<void>((r) => { release = r; });
    saved = { 'voice.wake_word_enabled': 'true' };
    verifyAndOpenVoiceSession(ws as never, `/voice?token=${jwt.sign({ userId: 'u1' }, 'secret')}&agentId=${A}`);
    await hear('hey agent');
    await new Promise((r) => setTimeout(r, 260));
    emit(chunk('First part. ', true));
    await settle();
    await hear('stop listening');
    release();
    await settle();
    emit(chunk('A proactive message.', true));
    emit(idle());
    await vi.waitFor(() => expect(said()).toContain('A proactive message.'));
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

// What reaches either voice from a streamed reply: spaces at chunk edges, control marks, an echoed time stamp.
describe('what is spoken from the streamed chunks', () => {
  const STAMP = '[Nov 14, 2026, 07:05 AM UTC-08:00]';
  async function openLocalSession(): Promise<void> {
    saved = {};
    verifyAndOpenVoiceSession(ws as never, `/voice?token=${jwt.sign({ userId: 'u1' }, 'secret')}&agentId=${A}`);
  }
  const spoken = async (open: () => Promise<void>, parts: string[]): Promise<string> => {
    await open();
    parts.forEach((p, i) => emit(chunk(p, i === parts.length - 1)));
    emit(idle());
    await vi.waitFor(() => expect(localSaid.length + pushed.length).toBeGreaterThan(0));
    await settle();
    return [...localSaid, ...pushed].join(' ');
  };

  for (const [voice, open] of [['local', openLocalSession], ['cloud', openCloudSession]] as const) {
    it(`the ${voice} voice keeps the space at a chunk edge`, async () => {
      expect(await spoken(open, ['Let me ', 'check that.'])).toContain('Let me check that.');
    });
    it(`the ${voice} voice leaves one space where a control mark was taken out`, async () => {
      expect(await spoken(open, ['Hello [no-reply]world'])).toContain('Hello world');
    });
    it(`the ${voice} voice keeps the space when a chunk ends right after the mark`, async () => {
      expect(await spoken(open, ['Hello [no-reply]', 'world'])).toContain('Hello world');
    });
    it(`the ${voice} voice drops a time stamp echoed at the start`, async () => {
      const said = await spoken(open, [`${STAMP} Done.`]);
      expect(said).toContain('Done.');
      expect(said).not.toContain('2026');
    });
    it(`the ${voice} voice keeps a clock time and a date that are no stamp`, async () => {
      const said = await spoken(open, ['9:30 AM works. [2026-11-15] the plan']);
      expect(said).toContain('9:30');
      expect(said).toContain('2026-11-15');
    });
  }
});
