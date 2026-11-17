// A text from a number nobody added starts no paid turn: it is stored as an unauthorized row, shown on the
// dashboard, and the agent sees it at its next turn.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as w from '../../services/__tests__/mail-world.js';

vi.mock('../../db/connection.js', async () => (await import('../../services/__tests__/mail-world.js')).dbModule());
vi.mock('../../gateway/ws.js', async () => (await import('../../services/__tests__/mail-world.js')).wsModule());
vi.mock('../../agent/runtime.js', async () => (await import('../../services/__tests__/mail-world.js')).runtimeModule());
vi.mock('../auth.js', () => ({ isSmsEnabled: () => true, getTwilioCreds: () => null }));

// Loaded at file level, so no case pays for the load.
import '../../db/migrations.js';
import { ingestInboundSms } from '../sms-inbound.js';

import { getWaitingHumanConversations } from '../../agent/v2/counterparty.js';
import { assembleContext } from '../../memory/assembler.js';

beforeEach(async () => {
  await w.freshWorld();
  const insert = (key: string, value: string) =>
    w.world.db!.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
  insert('imessage_approved_senders', JSON.stringify([{ address: '+15550100001', name: 'Owner', is_primary: true, sharing_level: 'open_book' }]));
  insert('twilio_sms_approved_senders', JSON.stringify([{ address: '+15550100002', name: 'Texter' }]));
});

const sms = (sid: string, from: string, body: string) => ({ messageSid: sid, fromNumber: from, toNumber: '+15550100900', body, numMedia: 0, mediaUrls: [] });

const row = (sid: string) => w.world.db!.prepare('SELECT authorized, inbound_meta FROM messages WHERE external_message_id = ?').get(sid) as { authorized: number; inbound_meta: string };

describe('an SMS from an unknown number', () => {
  it('starts no turn and is seen at the next one', async () => {
    expect(await ingestInboundSms(sms('SM-x-1', '+15550100777', 'You won a prize'))).toBe(true);
    expect(w.wake).not.toHaveBeenCalled();
    const r = row('SM-x-1');
    expect(r.authorized).toBe(0);
    expect(JSON.parse(r.inbound_meta).relation).toBe('third_party');
    expect(getWaitingHumanConversations('primary')).toEqual([]);
    expect(JSON.stringify((await assembleContext('primary', 'm')).messages)).toContain('+15550100777');
  });
});
