// A text from the owner's own number is him, not "an unknown number": it wakes the agent, is authorized,
// and his words by SMS count as his own.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as w from '../../services/__tests__/mail-world.js';

vi.mock('../../db/connection.js', async () => (await import('../../services/__tests__/mail-world.js')).dbModule());
vi.mock('../../gateway/ws.js', async () => (await import('../../services/__tests__/mail-world.js')).wsModule());
vi.mock('../../agent/runtime.js', async () => (await import('../../services/__tests__/mail-world.js')).runtimeModule());
vi.mock('../auth.js', () => ({ isSmsEnabled: () => true, getTwilioCreds: () => null }));

// Loaded at file level, so no case pays for the load.
import '../../db/migrations.js';
import { ingestInboundSms } from '../sms-inbound.js';
import { ownerSaidSince, normalizeQuote } from '../../tracker/owner-words.js';

beforeEach(async () => {
  await w.freshWorld();
  const insert = (key: string, value: string) =>
    w.world.db!.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
  insert('imessage_approved_senders', JSON.stringify([{ address: '+15550100001', name: 'Owner', is_primary: true, sharing_level: 'open_book' }]));
  insert('twilio_sms_approved_senders', JSON.stringify([{ address: '+15550100002', name: 'Texter' }]));
});

const sms = (sid: string, from: string, body: string) => ({ messageSid: sid, fromNumber: from, toNumber: '+15550100900', body, numMedia: 0, mediaUrls: [] });

const row = (sid: string) => w.world.db!.prepare('SELECT authorized, inbound_meta FROM messages WHERE external_message_id = ?').get(sid) as { authorized: number; inbound_meta: string };

describe('the owner texting from his own number', () => {
  it('is the owner, wakes the agent, and his words count as his', async () => {
    expect(await ingestInboundSms(sms('SM-own-1', '+15550100001', 'I approve, close it'))).toBe(true);
    expect(w.wake).toHaveBeenCalledTimes(1);
    const r = row('SM-own-1');
    expect(r.authorized).toBe(1);
    expect(JSON.parse(r.inbound_meta).relation).toBe('owner');
    expect(ownerSaidSince(0, normalizeQuote('I approve, close it'), 'primary')).toBe(true);
  });

  it('an approved texter wakes the agent and is a known contact', async () => {
    await ingestInboundSms(sms('SM-ok-1', '+15550100002', 'Running late'));
    expect(w.wake).toHaveBeenCalledTimes(1);
    const r = row('SM-ok-1');
    expect(r.authorized).toBe(1);
    expect(JSON.parse(r.inbound_meta).relation).toBe('known_contact');
  });
});
