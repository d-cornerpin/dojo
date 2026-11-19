// Opening a voice session tells the server only how the microphone is sampled: the voice, speed, engines
// and wake words are the saved settings, which the server reads itself.
import { describe, it, expect, vi } from 'vitest';

const sent = vi.hoisted(() => [] as string[]);
vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: { new: async () => ({ destroy() {}, start: async () => {}, pause: async () => {} }) },
}));
vi.mock('onnxruntime-web', () => ({ env: { wasm: {} } }));
vi.mock('../lib/api', () => ({ fetchUrl: vi.fn() }));

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  constructor(public url: string) { queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
  send(data: unknown) { if (typeof data === 'string') sent.push(data); }
  close() { this.readyState = 3; }
}

class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  async resume() {}
  async suspend() {}
  createBuffer() { return {}; }
  createBufferSource() { return { connect() {}, start() {}, buffer: null }; }
}

import { VoiceClient } from '../lib/voice/voice-client';

describe('opening a voice session', () => {
  it('sends the server the sample rate and nothing else', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    localStorage.setItem('dojo_token', 'token');
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    const client = new VoiceClient({ agentId: 'a1' });
    await client.start();
    expect(client.state).toBe('listening');
    expect(sent.map((m) => JSON.parse(m))).toEqual([{ type: 'config', pcmSampleRate: 16000 }]);
  });
});
