// Answering-machine detection is gone, so a live call can never have reached
// voicemail. Guards against the dead "Voicemail mode" branch of the phone
// conduct block coming back: a call whose trailer still carries a voicemail
// line must get its ordinary inbound/outbound opening.

import { describe, it, expect, vi } from 'vitest';
vi.mock('../../db/connection.js', () => ({ getDb: () => { throw new Error('no database in this test'); }, closeDb: () => undefined, getDbPath: () => ':memory:' }));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../config/platform.js')>()),
  getOwnerName: () => 'the owner',
  getPrimaryAgentName: () => 'Agent',
}));
import { renderPhoneConduct } from '../assembler.js';

describe('a call is never told it reached voicemail', () => {
  it('an inbound call with a voicemail line gets the inbound opening', () => {
    const out = renderPhoneConduct('phone', 'Hello\nDirection: inbound\nVoicemail: true\nCallback: +15550100', undefined);
    expect(out).toContain('This is an INBOUND call.');
    expect(out).not.toContain('Voicemail mode');
  });

  it('an outbound call with a voicemail line gets the outbound opening', () => {
    const out = renderPhoneConduct('phone', 'Hello\nDirection: outbound\nVoicemail: true\nCallback: +15550100', undefined);
    expect(out).toContain('This is an OUTBOUND call you placed.');
    expect(out).not.toContain('Voicemail mode');
  });

  it('a turn that is not a call has no phone block', () => {
    expect(renderPhoneConduct('dashboard', 'Hello', undefined)).toBeNull();
  });
});
