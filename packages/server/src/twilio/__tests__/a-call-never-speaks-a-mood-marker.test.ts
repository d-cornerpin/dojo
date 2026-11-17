// What the agent says on a phone call reaches the voice cleaned: no mood marker, no markdown, no raw link.
import { describe, it, expect, vi } from 'vitest';

const synthesized: string[] = [];
const runs: Array<{ sql: string; args: unknown[] }> = [];

vi.mock('../tts-bridge.js', () => ({
  synthesizeForTwilio: async (text: string) => { synthesized.push(text); return { pcm: new Float32Array(160), sampleRate: 8000 }; },
}));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: (sql: string) => ({ run: (...args: unknown[]) => { runs.push({ sql, args }); return {}; } }) }),
}));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }) };
});
vi.mock('../../voice/stt-service.js', () => ({ ensureSttReady: async () => {}, transcribeBuffer: vi.fn() }));
vi.mock('../../config/platform.js', () => ({ getPrimaryAgentId: () => 'agent-1', getOwnerName: () => 'Owner' }));
vi.mock('../auth.js', () => ({ getTwilioConfig: () => ({ voiceMaxMinutesPerCall: 30 }) }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../../agent/v2/outbound.js', () => ({ recordAtDoor: vi.fn(), recordedId: vi.fn(), recordHeld: vi.fn() }));
vi.mock('../../agent/access/read.js', () => ({ mayUseChannel: () => true }));

const { CallSession } = await import('../call-session.js');

describe('a call never speaks a mood marker', () => {
  it('the voice and the call transcript get the words only', async () => {
    const s = new CallSession({
      callSid: 'CA1', streamSid: 'MZ1', direction: 'outbound',
      fromNumber: '+15550000001', toNumber: '+15550000002', send: () => {},
    });
    await s.queueAgentSay('((mood: calm)) **Done.** The notes are at https://example.com/notes.');
    s.end('completed');
    expect(synthesized).toEqual(['Done. The notes are at link.']);
    const transcript = String(runs.find((r) => r.sql.includes('UPDATE twilio_call_log'))?.args[2]);
    expect(transcript).toContain('agent: Done. The notes are at link.');
    expect(transcript).not.toMatch(/mood|\*\*|https/);
  });
});
