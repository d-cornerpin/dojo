// With dashboard voice on, only a turn that answers what was said by voice is read aloud; the agent's reply
// to a text from someone else stays silent.
import { describe, it, expect, vi } from 'vitest';
import type { WsEvent } from '@dojo/shared';

const bus = new Set<(e: WsEvent) => void>();
const emit = (e: WsEvent): void => { for (const h of [...bus]) h(e); };
const spoken: string[] = [];
let delivery = 'imessage';

vi.mock('hume', () => ({ HumeClient: class {} }));
vi.mock('../hume-engine.js', () => ({ isHumeConfigured: () => false, HumeStreamSession: class {} }));
vi.mock('../tts-service.js', async (orig) => ({
  ...(await orig<typeof import('../tts-service.js')>()),
  loadKokoro: async () => ({}),
  isKokoroLoaded: () => true,
  async* synthesizeClauseStream(queue: AsyncIterable<string>) {
    for await (const c of queue) { spoken.push(c); yield { text: c, pcm: new Float32Array(4), sampleRate: 24000 }; }
  },
}));
vi.mock('../stt-service.js', () => ({
  transcribeBuffer: async () => ({ text: '', durationMs: 1 }), ensureSttReady: async () => {}, DEFAULT_STT_MODEL_KEY: 'moonshine-base',
  parseSttModelKey: () => ({ kind: 'moonshine' }), pcmFloatToWav: () => Buffer.from('wav'),
}));
vi.mock('../smart-turn.js', () => ({ predictTurnComplete: async () => null, TURN_COMPLETE_THRESHOLD: 0.5, warmUpSmartTurn: async () => {} }));
vi.mock('../custom-voices.js', () => ({ checkCustomVoiceUsable: () => ({ ok: true }) }));
vi.mock('../model-manager.js', () => ({ KOKORO_MODEL_ID: 'k' }));
vi.mock('../../agent/turn-context.js', () => ({ turnContext: () => ({ address: { deliveryChannel: delivery } }) }));
vi.mock('../../agent/runtime.js', () => ({ preemptAgentForUrgentMessage: () => {} }));
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
const { verifyAndOpenVoiceSession, closeVoiceSession } = await import('../voice-ws.js');

const A = 'agent-1';
const ws = { send: () => {}, close: () => {} };
const reply = (text: string): void => {
  emit({ type: 'chat:chunk', agentId: A, messageId: 'm1', content: text, done: true });
  emit({ type: 'agent:status', agentId: A, status: 'idle' } as WsEvent);
};

describe('a reply to a text is not spoken while voice is on', () => {
  it('a turn delivered to iMessage is silent; a turn answering a spoken ask is read aloud', async () => {
    verifyAndOpenVoiceSession(ws as never, `/voice?token=${jwt.sign({ userId: 'u1' }, 'secret')}&agentId=${A}`);
    delivery = 'imessage';
    reply('The dentist is booked for Tuesday.');
    await new Promise((r) => setTimeout(r, 20));
    expect(spoken).toEqual([]);

    delivery = 'voice';
    reply('Milk is on the list.');
    await vi.waitFor(() => expect(spoken).toEqual(['Milk is on the list.']));
    closeVoiceSession(ws as never);
  });
});
