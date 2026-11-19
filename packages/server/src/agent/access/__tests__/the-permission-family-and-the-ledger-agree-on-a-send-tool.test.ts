// The helpers' channel grants and the delivery ledger read one table: every tool in it, and its
// owner-account twin, has the table's channel in the grants, and a send has it in the ledger.
import { describe, it, expect } from 'vitest';
import { PEOPLE_TOOLS, channelOfSendTool } from '@dojo/shared';
import { channelForTool } from '../channels.js';
import { USER_TWINNED_SEND_PREFIXES } from '../../sensei-policy.js';

describe('the permission family and the ledger agree on a send tool', () => {
  it('every tool in the table, and its twin, has the table channel in the grants', () => {
    for (const [name, tool] of PEOPLE_TOOLS) {
      const grant = tool.channel === 'phone' ? 'voice' : tool.channel;
      expect(channelForTool(name), name).toBe(grant);
      if (USER_TWINNED_SEND_PREFIXES.some((p) => name.startsWith(p))) {
        expect(channelForTool(`user_${name}`), name).toBe(grant);
      }
    }
  });

  it('a send has its channel in the ledger, twin included; a read or a hang-up has none', () => {
    expect(channelOfSendTool('gmail_reply')).toBe('email');
    expect(channelOfSendTool('user_outlook_send')).toBe('email');
    expect(channelOfSendTool('user_teams_send_channel_message')).toBe('teams');
    expect(channelOfSendTool('voice_call')).toBe('phone');
    expect(channelOfSendTool('imessage_list_contacts')).toBeNull();
    expect(channelOfSendTool('voice_call_end')).toBeNull();
    expect(channelOfSendTool('voice_call_status')).toBeNull();
    expect(channelOfSendTool('not_a_tool')).toBeNull();
  });
});
