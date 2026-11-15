// A reply streams in chunks that may split at a space ("Let me " + "check"); both voices speak the space.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WsEvent } from '@dojo/shared';

const bus = new Set<(e: WsEvent) => void>();
const emit = (e: WsEvent): void => { for (const h of [...bus]) h(e); };
const pushed: string[] = [];
const localSaid: string[] = [];

vi.mock('hume', () => ({ HumeClient: class {} }));
vi.mock('../hume-engine.js', () => ({
  isHumeConfigured: () => true,
  HumeStreamSession: class {
    onWav: ((wav: Buffer) => void) | null = null;
    onSnippetDone: ((text: string) => void) | null = null;
    onError: ((e: Error) => void) | null = null;
    private pending = '';
    async open(): Promise<void> {}
    push(t: string): void { this.pending += t; pushed.push(t); }
    flush(): void { const t = this.pending; this.pending = ''; if (t) setTimeout(() => { this.onWav?.(Buffer.from('cloud')); this.onSnippetDone?.(t); }, 0); }
    setDescription(): void {}
    async close(): Promise<void> {}
  },
}));
vi.mock('../../agent/runtime.js', () => ({ preemptAgentForUrgentMessage: () => {} }));
vi.mock('../tts-service.js', async (orig) => ({
  ...(await orig<typeof import('../tts-service.js')>()),
  loadKokoro: async () => ({}),
  isKokoroLoaded: () => true,
  async* synthesizeClauseStream(queue: AsyncIterable<string>) {
    for await (const c of queue) { localSaid.push(c); yield { text: c, pcm: new Float32Array(4), sampleRate: 24000 }; }
  },
}));
vi.mock('../stt-service.js', () => ({
  transcribeBuffer: async () => ({ text: '', durationMs: 1 }), ensureSttReady: async () => {}, DEFAULT_STT_MODEL_KEY: 'moonshine-base',
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
const ws = { send: () => {}, close: () => {} };

async function open(config: Record<string, unknown>): Promise<void> {
  verifyAndOpenVoiceSession(ws as never, `/voice?token=${jwt.sign({ userId: 'u1' }, 'secret')}&agentId=${A}`);
  await handleVoiceMessage(ws as never, JSON.stringify({ type: 'config', ...config }));
}

beforeEach(() => { closeVoiceSession(ws as never); bus.clear(); pushed.length = 0; localSaid.length = 0; });

describe('a chunk edge that falls on a space', () => {
  it('the local voice says "Let me check that."', async () => {
    await open({});
    emit(chunk('Let me ')); emit(chunk('check that.', true)); emit(idle());
    await vi.waitFor(() => expect(localSaid.length).toBeGreaterThan(0));
    expect(localSaid.join(' ')).toContain('Let me check that.');
  });

  it('the cloud voice is sent "Let me check that."', async () => {
    await open({ cloudVoice: 'v1' });
    await handleVoiceMessage(ws as never, JSON.stringify({ type: 'config', ttsEngine: 'cloud' }));
    emit(chunk('Let me ')); emit(chunk('check that.', true)); emit(idle());
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0));
    expect(pushed.join('')).toContain('Let me check that.');
  });
});
