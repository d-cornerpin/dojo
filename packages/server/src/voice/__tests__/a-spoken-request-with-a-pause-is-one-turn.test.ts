// "Add milk to the list and" (pause) "also remind me at five": speaking again during the mid-thought hold
// keeps the held words, so the request goes to the agent once, whole. A sound that starts and never ends
// does not strand them.
import { describe, it, expect, vi, afterEach } from 'vitest';

const heard: string[] = [];
const doneness: number[] = [];
const submitted: string[] = [];

vi.mock('hume', () => ({ HumeClient: class {} }));
vi.mock('../hume-engine.js', () => ({ isHumeConfigured: () => false, HumeStreamSession: class {} }));
vi.mock('../tts-service.js', async (orig) => ({
  ...(await orig<typeof import('../tts-service.js')>()),
  loadKokoro: async () => ({}),
  isKokoroLoaded: () => true,
}));
vi.mock('../stt-service.js', () => ({
  transcribeBuffer: async () => ({ text: heard.shift() ?? '', durationMs: 1 }), ensureSttReady: async () => {},
  DEFAULT_STT_MODEL_KEY: 'moonshine-base', parseSttModelKey: () => ({ kind: 'moonshine' }), pcmFloatToWav: () => Buffer.from('wav'),
}));
vi.mock('../smart-turn.js', () => ({
  predictTurnComplete: async () => doneness.shift() ?? 0.9, TURN_COMPLETE_THRESHOLD: 0.5, warmUpSmartTurn: async () => {},
}));
vi.mock('../custom-voices.js', () => ({ checkCustomVoiceUsable: () => ({ ok: true }) }));
vi.mock('../model-manager.js', () => ({ KOKORO_MODEL_ID: 'k' }));
vi.mock('../../agent/runtime.js', () => ({ preemptAgentForUrgentMessage: () => {} }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, onBroadcast: () => () => {} }));
vi.mock('../../gateway/routes/chat.js', () => ({
  submitUserMessage: async (_a: string, text: string) => { submitted.push(text); return { ok: true, messageId: 'm1' }; },
}));
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

const ws = { send: () => {}, close: () => {} };
const control = (type: string): Promise<void> => handleVoiceMessage(ws as never, JSON.stringify({ type }));
const audio = (): Promise<void> => handleVoiceMessage(ws as never, Buffer.from(new Float32Array(8000).buffer));

afterEach(() => { closeVoiceSession(ws as never); vi.useRealTimers(); });

describe('a spoken request with a pause is one turn', () => {
  it('a long second part spoken during the hold joins the first', async () => {
    vi.useFakeTimers();
    verifyAndOpenVoiceSession(ws as never, `/voice?token=${jwt.sign({ userId: 'u1' }, 'secret')}&agentId=agent-1`);
    heard.push('Add milk to the list and', 'also remind me at five.');
    doneness.push(0.1, 0.9);

    await control('utterance_start'); await audio(); await control('utterance_end');   // held: mid-thought
    await vi.advanceTimersByTimeAsync(200);
    await control('utterance_start');                                                  // speaking again
    await vi.advanceTimersByTimeAsync(5_000);                                          // a long second part
    await audio(); await control('utterance_end');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(submitted).toEqual(['Add milk to the list and also remind me at five.']);
  });

  it('a sound that starts and never ends still lets the held words go', async () => {
    vi.useFakeTimers();
    submitted.length = 0;
    verifyAndOpenVoiceSession(ws as never, `/voice?token=${jwt.sign({ userId: 'u1' }, 'secret')}&agentId=agent-1`);
    heard.push('Add milk to the list and');
    doneness.push(0.1);

    await control('utterance_start'); await audio(); await control('utterance_end');   // held: mid-thought
    await vi.advanceTimersByTimeAsync(200);
    await control('utterance_start');                                                  // a cough, no end
    await vi.advanceTimersByTimeAsync(10_000);
    expect(submitted).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(submitted).toEqual(['Add milk to the list and']);
  });
});
