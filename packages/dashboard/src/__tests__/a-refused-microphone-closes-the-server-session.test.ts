// A voice start that fails, and a dropped connection, end the whole session the way a stop does:
// the server socket closes and the microphone is released.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fake = vi.hoisted(() => ({ refuse: false, vads: [] as Array<{ destroyed: number }>, sockets: [] as Array<{ closed: boolean; readyState: number; sent: string[]; onclose: (() => void) | null }> }));

vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: {
    new: async () => {
      if (fake.refuse) { const e = new Error('blocked'); e.name = 'NotAllowedError'; throw e; }
      const vad = { destroyed: 0, destroy() { this.destroyed += 1; }, start: async () => {}, pause: async () => {} };
      fake.vads.push(vad);
      return vad;
    },
  },
}));
vi.mock('onnxruntime-web', () => ({ env: { wasm: {} } }));
vi.mock('../lib/api', () => ({ fetchUrl: vi.fn() }));

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  closed = false;
  sent: string[] = [];
  binaryType = '';
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    fake.sockets.push(this);
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(data: unknown) { if (typeof data === 'string') this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; }
}

class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  async resume() {}
  async suspend() { this.state = 'suspended'; }
  createBuffer() { return {}; }
  createBufferSource() { return { connect() {}, start() {}, buffer: null }; }
}

import { VoiceClient } from '../lib/voice/voice-client';

beforeEach(() => {
  fake.refuse = false;
  fake.vads.length = 0;
  fake.sockets.length = 0;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  localStorage.setItem('dojo_token', 'token');
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ending a voice session', () => {
  it('a refused microphone closes the server session', async () => {
    fake.refuse = true;
    const client = new VoiceClient({ agentId: 'a1' });
    await client.start();
    expect(client.state).toBe('error');
    expect(fake.sockets.length).toBe(1);
    expect(fake.sockets[0].closed).toBe(true);
    expect(fake.sockets[0].sent.some((m) => m.includes('"close"'))).toBe(true);
  });

  it('a second start after a refusal opens a fresh session and leaves no old one open', async () => {
    const client = new VoiceClient({ agentId: 'a1' });
    fake.refuse = true;
    await client.start();
    fake.refuse = false;
    await client.start();
    expect(client.state).toBe('listening');
    expect(fake.sockets.length).toBe(2);
    expect(fake.sockets[0].closed).toBe(true);
    expect(fake.sockets[1].closed).toBe(false);
  });

  it('a dropped connection releases the microphone', async () => {
    const client = new VoiceClient({ agentId: 'a1' });
    await client.start();
    expect(client.state).toBe('listening');
    fake.sockets[0].readyState = 3;
    fake.sockets[0].onclose?.();
    await flush();
    expect(fake.vads[0].destroyed).toBe(1);
    expect(client.state).toBe('idle');
  });
});
