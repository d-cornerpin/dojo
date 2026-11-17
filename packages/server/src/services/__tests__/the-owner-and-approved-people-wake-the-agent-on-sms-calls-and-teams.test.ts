// The owner (his own number or mailbox) or a person on that channel's approved list wakes the main agent on SMS,
// calls and Teams too; anything else waits for the agent's next turn.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as w from './mail-world.js';

vi.mock('../../db/connection.js', async () => (await import('./mail-world.js')).dbModule());

import { senderWakes } from '../channel-safe-senders.js';
import { mayAnswer } from '../../agent/v2/channel-auth.js';

beforeEach(async () => {
  await w.freshWorld();
  const insert = (key: string, value: string) =>
    w.world.db!.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
  insert('imessage_approved_senders', JSON.stringify([{ address: '+15550100001', name: 'Owner', is_primary: true, sharing_level: 'open_book' }]));
  insert('twilio_sms_approved_senders', JSON.stringify([{ address: '+15550100002', name: 'Texter' }]));
  insert('twilio_voice_approved_callers', JSON.stringify([{ address: '+15550100003', name: 'Caller' }]));
  insert('teams_approved_senders', JSON.stringify([{ address: 'colleague@example.com', name: 'Colleague' }]));
});

describe('the owner and approved people wake the agent on SMS, calls and Teams', () => {
  it('his own number is him on SMS and on calls', () => {
    expect(senderWakes('sms', null, '+15550100001')).toBe(true);
    expect(senderWakes('phone', null, '+15550100001')).toBe(true);
  });

  it('a number on the SMS list wakes by SMS, not by a call', () => {
    expect(senderWakes('sms', null, '+15550100002')).toBe(true);
    expect(senderWakes('phone', null, '+15550100002')).toBe(false);
  });

  it('a caller on the call list wakes by a call', () => {
    expect(senderWakes('phone', null, '+15550100003')).toBe(true);
  });

  it('an approved Teams colleague wakes, a stranger does not', () => {
    expect(senderWakes('teams', null, 'colleague@example.com')).toBe(true);
    expect(senderWakes('teams', null, 'stranger@example.com')).toBe(false);
    expect(senderWakes('sms', null, '+15550100999')).toBe(false);
    expect(senderWakes('phone', null, '+15550100999')).toBe(false);
  });

  it('an empty sender never wakes', () => {
    expect(senderWakes('sms', null, '')).toBe(false);
    expect(senderWakes('teams', null, '   ')).toBe(false);
  });

  it('mail keeps its rule', () => {
    expect(senderWakes('gmail', { id: 'acct-1', kind: 'agent' }, 'stranger@example.com')).toBe(true);
    expect(senderWakes('gmail', { id: 'acct-2', kind: 'user' }, 'stranger@example.com')).toBe(false);
  });

  it('his own number may be answered by SMS', () => {
    expect(mayAnswer('sms', '+15550100001', 'agent')).toBe(true);
    expect(mayAnswer('sms', '+15550100999', 'agent')).toBe(false);
  });
});
