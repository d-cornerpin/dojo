// A sentence the caller did not hear is not recorded as said: one the voice could not speak leaves no
// delivery, and a barge-in or a hang-up adds one transcript line naming what was cut off.
import { describe, it, expect, vi } from 'vitest';

const runs: Array<{ sql: string; args: unknown[] }> = [];
const delivered: string[] = [];
const synthGate: { wait: Promise<void> | null } = { wait: null };

vi.mock('../tts-bridge.js', () => ({
  synthesizeForTwilio: async (text: string) => {
    if (text.startsWith('Unspeakable')) return null;
    await synthGate.wait;
    return { pcm: new Float32Array(8000), sampleRate: 8000 };
  },
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
vi.mock('../../agent/v2/outbound.js', () => ({
  recordAtDoor: (o: { outcome: string }) => { delivered.push(o.outcome); return {}; }, recordedId: vi.fn(), recordHeld: vi.fn(),
}));
vi.mock('../../agent/access/read.js', () => ({ mayUseChannel: () => true }));

const { CallSession } = await import('../call-session.js');

const loud = Buffer.alloc(160, 0x00).toString('base64');   // μ-law 0x00 is a full-scale sample
const transcriptOf = (): string => String(runs.find((r) => r.sql.includes('UPDATE twilio_call_log'))?.args[2]);

function call(): InstanceType<typeof CallSession> {
  const s = new CallSession({
    callSid: 'CA1', streamSid: 'MZ1', direction: 'outbound',
    fromNumber: '+15550000001', toNumber: '+15550000002', send: () => {},
  });
  s.start();
  return s;
}

describe('an interrupted sentence is recorded as not heard', () => {
  it('a sentence no voice could speak is neither delivered nor in the transcript', async () => {
    delivered.length = 0; runs.length = 0;
    const s = call();
    await s.queueAgentSay('Unspeakable words.');
    s.end('completed');
    expect(delivered).toEqual([]);
    expect(transcriptOf()).not.toContain('Unspeakable');
  });

  it('the caller speaking over queued audio adds one line naming what was not heard', async () => {
    delivered.length = 0; runs.length = 0;
    const s = call();
    await s.queueAgentSay('The first part is long.');
    await s.queueAgentSay('The second part never plays.');
    await s.frame(loud);   // the caller starts talking
    s.end('completed');
    const lines = transcriptOf().split('\n');
    expect(lines.filter((l) => l.includes('not heard'))).toHaveLength(1);
    expect(lines.at(-1)).toContain('The second part never plays.');
  });

  it('a hang-up with audio still queued adds one line saying the caller hung up', async () => {
    delivered.length = 0; runs.length = 0;
    const s = call();
    await s.queueAgentSay('The first part is long.');
    await s.queueAgentSay('The second part never plays.');
    s.end('twilio_stop');
    const lines = transcriptOf().split('\n').filter((l) => l.includes('not heard'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('the caller hung up: The first part is long. The second part never plays.');
  });
});
