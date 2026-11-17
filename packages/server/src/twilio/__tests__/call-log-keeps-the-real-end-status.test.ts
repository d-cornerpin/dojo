// The session's final log update must keep Twilio's real end state (busy, no-answer, failed,
// canceled) instead of overwriting it with 'completed'.
import { describe, it, expect, vi } from 'vitest';

const insertMock = vi.fn(() => ({}));
const transcribeBuffer = vi.fn(async () => ({ text: 'hello there' }));
const ensureSttReady = vi.fn(async () => {});
const runs: Array<{ sql: string; args: unknown[] }> = [];

vi.mock('../../memory/conversations.js', () => ({
  resolveOrCreateConversation: () => 'conv1',
}));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: (sql: string) => ({ run: (...args: unknown[]) => { runs.push({ sql, args }); return {}; } }) }),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'agent-1',
  getOwnerName: () => 'Owner',
}));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => {} }),
}));
vi.mock('../auth.js', () => ({ getTwilioConfig: () => ({ voiceMaxMinutesPerCall: 30 }) }));
vi.mock('../../services/channel-safe-senders.js', () => ({ getTwilioVoiceSafeCallers: () => [] }));
vi.mock('../../services/imessage-bridge.js', () => ({ addressesMatch: () => false }));
vi.mock('../../tools/inbound-fences.js', () => ({ callUtteranceText: (_n: string, _d: string, t: string) => t }));
vi.mock('../../agent/v2/inbound-channel.js', () => ({ recordInboundMeta: vi.fn() }));
vi.mock('../../work/ask-title.js', () => ({ insertInboundMessageIfAbsent: insertMock }));
vi.mock('../../agent/v2/outbound.js', () => ({
  recordAtDoor: vi.fn(), recordedId: vi.fn(), recordHeld: vi.fn(),
}));
vi.mock('../../agent/access/read.js', () => ({ mayUseChannel: () => true }));
vi.mock('../../voice/stt-service.js', () => ({
  transcribeBuffer,
  ensureSttReady,
}));

const { CallSession } = await import('../call-session.js');

function endStatusFor(reason: string): unknown {
  const s = new CallSession({
    callSid: 'CA1', streamSid: 'MZ1', direction: 'outbound',
    fromNumber: '+15550000001', toNumber: '+15550000002', send: () => {},
  });
  runs.length = 0;
  s.end(reason);
  return runs.find(r => r.sql.includes('UPDATE twilio_call_log'))?.args[0];
}

describe('call log keeps the real end status', () => {
  it.each(['busy', 'no-answer', 'failed', 'canceled'])('%s stays %s', (r) => {
    expect(endStatusFor(r)).toBe(r);
  });
  it.each(['twilio_stop', 'completed', 'ws_closed'])('%s is completed', (r) => {
    expect(endStatusFor(r)).toBe('completed');
  });
});
