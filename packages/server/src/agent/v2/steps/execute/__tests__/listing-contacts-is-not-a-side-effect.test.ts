// Listing contacts and checking a call do nothing in the world: they keep their channel grant and
// their place on the deny lists, but a turn that only read them did no side effect.
import { describe, it, expect } from 'vitest';
import { isEffectfulTool } from '../effectful-call.js';
import { channelForTool } from '../../../../access/channels.js';
import { SEND_TO_PEOPLE } from '../../../../sensei-policy.js';

describe('listing contacts is not a side effect', () => {
  it('the contact list and the call status are not side effects', () => {
    expect(isEffectfulTool('imessage_list_contacts')).toBe(false);
    expect(isEffectfulTool('voice_call_status')).toBe(false);
  });

  it('a send, an owner-account send and a hang-up still are', () => {
    expect(isEffectfulTool('imessage_send')).toBe(true);
    expect(isEffectfulTool('user_gmail_send')).toBe(true);
    expect(isEffectfulTool('voice_call_end')).toBe(true);
  });

  it('the two reads keep their channel grant and stay on the deny lists', () => {
    expect(channelForTool('imessage_list_contacts')).toBe('imessage');
    expect(channelForTool('voice_call_status')).toBe('voice');
    expect(SEND_TO_PEOPLE).toContain('imessage_list_contacts');
    expect(SEND_TO_PEOPLE).toContain('voice_call_status');
  });
});
